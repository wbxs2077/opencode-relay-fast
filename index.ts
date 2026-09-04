import {
    existsSync,
    mkdirSync,
    readFileSync,
    renameSync,
    unlinkSync,
    writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Plugin } from "@opencode-ai/plugin";

/*
 * opencode-relay-fast
 *
 * Injects `service_tier` (default: "priority") into OpenAI-compatible requests
 * that OpenCode sends to the relay / gateway providers you list, while Fast
 * mode is switched on with the `/fast` command.
 *
 * Two files live under ~/.config/opencode (or $XDG_CONFIG_HOME/opencode):
 *   - opencode-relay-fast.jsonc        user-edited configuration (comments allowed)
 *   - opencode-relay-fast.state.json   machine-written runtime state
 */

const PLUGIN_NAME = "opencode-relay-fast";
const COMMAND_NAME = "fast";
const DEFAULT_ENDPOINTS = ["/responses", "/chat/completions"];
const DEFAULT_SERVICE_TIER = "priority";

const CONFIG_DIR = join(
    process.env.XDG_CONFIG_HOME || join(homedir(), ".config"),
    "opencode",
);
const CONFIG_PATH =
    process.env.OPENCODE_RELAY_FAST_CONFIG || join(CONFIG_DIR, `${PLUGIN_NAME}.jsonc`);
const STATE_PATH =
    process.env.OPENCODE_RELAY_FAST_STATE || join(CONFIG_DIR, `${PLUGIN_NAME}.state.json`);

export type RelayFastConfig = {
    /** OpenCode provider IDs whose `options.baseURL` should be targeted. */
    providers: string[];
    /** Explicit base URLs to target, in addition to the resolved providers. */
    baseURLs: string[];
    /** Endpoint suffixes (relative to the base URL) that accept `service_tier`. */
    endpoints: string[];
    /** Model ID glob patterns (`*` wildcard). Empty means every model. */
    models: string[];
    /** Value written into `service_tier`. */
    serviceTier: string;
    /** Optional `provider/model` used to run the `/fast` command itself. */
    commandModel?: string;
    /** Emit an OpenCode log line for every injected request. */
    logInjections: boolean;
};

export type RelayFastState = {
    enabled: boolean;
    injectionCount: number;
    lastInjectedAt?: string;
    lastInjectedModel?: string;
    lastInjectedUrl?: string;
};

type Target = {
    /** Normalised base URL: lower-case origin + pathname without trailing slash. */
    prefix: string;
    /** Where the target came from, for `/fast status`. */
    source: string;
};

type InjectionResult = {
    init: RequestInit | undefined;
    model?: string;
    url?: string;
};

const DEFAULT_CONFIG: RelayFastConfig = {
    providers: [],
    baseURLs: [],
    endpoints: DEFAULT_ENDPOINTS,
    models: [],
    serviceTier: DEFAULT_SERVICE_TIER,
    commandModel: undefined,
    logInjections: true,
};

/* ------------------------------------------------------------------------ */
/* Small helpers                                                             */
/* ------------------------------------------------------------------------ */

/** Strip `//`, `/* *\/` comments and trailing commas so JSONC parses as JSON. */
export function stripJsonc(text: string): string {
    let out = "";
    let i = 0;
    let inString = false;

    while (i < text.length) {
        const ch = text[i];
        const next = text[i + 1];

        if (inString) {
            out += ch;
            if (ch === "\\") {
                out += next ?? "";
                i += 2;
                continue;
            }
            if (ch === '"') inString = false;
            i += 1;
            continue;
        }

        if (ch === '"') {
            inString = true;
            out += ch;
            i += 1;
            continue;
        }

        if (ch === "/" && next === "/") {
            while (i < text.length && text[i] !== "\n") i += 1;
            continue;
        }

        if (ch === "/" && next === "*") {
            i += 2;
            while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i += 1;
            i += 2;
            continue;
        }

        out += ch;
        i += 1;
    }

    return out.replace(/,(\s*[}\]])/g, "$1");
}

function stringArray(value: unknown): string[] | undefined {
    if (!Array.isArray(value)) return undefined;
    return value.filter((item): item is string => typeof item === "string" && item.length > 0);
}

function normaliseBaseUrl(raw: string): string | undefined {
    try {
        const url = new URL(raw);
        const path = url.pathname.replace(/\/+$/, "");
        return `${url.origin.toLowerCase()}${path}`;
    } catch {
        return undefined;
    }
}

function normaliseEndpoint(raw: string): string {
    const trimmed = raw.trim().replace(/\/+$/, "");
    return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

function globToRegExp(pattern: string): RegExp {
    const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
    return new RegExp(`^${escaped}$`);
}

function resolveUrl(input: RequestInfo | URL): string {
    if (typeof input === "string") return input;
    if (input instanceof URL) return input.href;
    return input.url;
}

function parseBody(body: BodyInit | null | undefined): Record<string, unknown> | undefined {
    let raw: string;
    if (typeof body === "string") {
        raw = body;
    } else if (body instanceof Uint8Array) {
        raw = new TextDecoder().decode(body);
    } else {
        return undefined;
    }

    try {
        const parsed: unknown = JSON.parse(raw);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
        return parsed as Record<string, unknown>;
    } catch {
        return undefined;
    }
}

/** Drop a caller-supplied Content-Length header; the body length changes after injection. */
function withoutContentLength(headers: HeadersInit | undefined): HeadersInit | undefined {
    if (!headers) return headers;

    if (headers instanceof Headers) {
        const copy = new Headers(headers);
        copy.delete("content-length");
        return copy;
    }

    if (Array.isArray(headers)) {
        return headers.filter(([name]) => name.toLowerCase() !== "content-length");
    }

    const copy: Record<string, string> = {};
    for (const [name, value] of Object.entries(headers)) {
        if (name.toLowerCase() !== "content-length") copy[name] = value;
    }
    return copy;
}

function atomicWriteJson(path: string, value: unknown): void {
    mkdirSync(dirname(path), { recursive: true });
    const tempPath = `${path}.${process.pid}.${Date.now()}.tmp`;
    try {
        writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
        renameSync(tempPath, path);
    } finally {
        if (existsSync(tempPath)) unlinkSync(tempPath);
    }
}

/* ------------------------------------------------------------------------ */
/* Config and state                                                          */
/* ------------------------------------------------------------------------ */

export function parseConfig(text: string): RelayFastConfig {
    const parsed: unknown = JSON.parse(stripJsonc(text));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { ...DEFAULT_CONFIG };
    const raw = parsed as Record<string, unknown>;

    const endpoints = stringArray(raw.endpoints)?.map(normaliseEndpoint);
    const serviceTier =
        typeof raw.serviceTier === "string" && raw.serviceTier.trim()
            ? raw.serviceTier.trim()
            : DEFAULT_SERVICE_TIER;

    return {
        providers: stringArray(raw.providers) ?? [],
        baseURLs: stringArray(raw.baseURLs) ?? [],
        endpoints: endpoints && endpoints.length > 0 ? endpoints : DEFAULT_ENDPOINTS,
        models: stringArray(raw.models) ?? [],
        serviceTier,
        commandModel:
            typeof raw.commandModel === "string" && raw.commandModel.trim()
                ? raw.commandModel.trim()
                : undefined,
        logInjections: raw.logInjections !== false,
    };
}

function readConfig(): { config: RelayFastConfig; error?: string } {
    if (!existsSync(CONFIG_PATH)) return { config: { ...DEFAULT_CONFIG } };
    try {
        return { config: parseConfig(readFileSync(CONFIG_PATH, "utf8")) };
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { config: { ...DEFAULT_CONFIG }, error: `Failed to parse ${CONFIG_PATH}: ${message}` };
    }
}

function readState(): RelayFastState {
    try {
        if (!existsSync(STATE_PATH)) return { enabled: false, injectionCount: 0 };
        const raw = JSON.parse(readFileSync(STATE_PATH, "utf8")) as Partial<RelayFastState>;
        return {
            enabled: raw.enabled === true,
            injectionCount:
                typeof raw.injectionCount === "number" && raw.injectionCount >= 0
                    ? raw.injectionCount
                    : 0,
            lastInjectedAt: typeof raw.lastInjectedAt === "string" ? raw.lastInjectedAt : undefined,
            lastInjectedModel:
                typeof raw.lastInjectedModel === "string" ? raw.lastInjectedModel : undefined,
            lastInjectedUrl: typeof raw.lastInjectedUrl === "string" ? raw.lastInjectedUrl : undefined,
        };
    } catch {
        return { enabled: false, injectionCount: 0 };
    }
}

/* ------------------------------------------------------------------------ */
/* Matching                                                                  */
/* ------------------------------------------------------------------------ */

export class RelayFastMatcher {
    private targets: Target[] = [];
    private modelPatterns: RegExp[] = [];
    private endpoints: string[] = [];
    private serviceTier = DEFAULT_SERVICE_TIER;
    private unresolvedProviders: string[] = [];

    constructor(private config: RelayFastConfig) {
        this.endpoints = config.endpoints;
        this.serviceTier = config.serviceTier;
        this.modelPatterns = config.models.map(globToRegExp);
        this.setExplicitTargets();
    }

    private setExplicitTargets(): void {
        this.targets = [];
        for (const raw of this.config.baseURLs) {
            const prefix = normaliseBaseUrl(raw);
            if (prefix) this.targets.push({ prefix, source: `baseURLs: ${raw}` });
        }
        this.unresolvedProviders = [...this.config.providers];
    }

    /** Resolve `providers` against the provider map found in OpenCode's config. */
    resolveProviders(providers: Record<string, { options?: { baseURL?: string } }> | undefined): void {
        this.setExplicitTargets();
        this.unresolvedProviders = [];

        for (const id of this.config.providers) {
            const baseURL = providers?.[id]?.options?.baseURL;
            const prefix = baseURL ? normaliseBaseUrl(baseURL) : undefined;
            if (!prefix) {
                this.unresolvedProviders.push(id);
                continue;
            }
            if (!this.targets.some((target) => target.prefix === prefix)) {
                this.targets.push({ prefix, source: `provider: ${id}` });
            }
        }
    }

    get hasTargets(): boolean {
        return this.targets.length > 0;
    }

    describeTargets(): string[] {
        return this.targets.map((target) => `${target.prefix} (${target.source})`);
    }

    describeUnresolved(): string[] {
        return [...this.unresolvedProviders];
    }

    matchesUrl(input: RequestInfo | URL): string | undefined {
        let url: URL;
        try {
            url = new URL(resolveUrl(input));
        } catch {
            return undefined;
        }

        const full = `${url.origin.toLowerCase()}${url.pathname.replace(/\/+$/, "")}`;
        for (const target of this.targets) {
            if (!full.startsWith(target.prefix)) continue;
            const rest = full.slice(target.prefix.length);
            if (this.endpoints.includes(rest)) return url.href;
        }
        return undefined;
    }

    matchesModel(model: string): boolean {
        if (this.modelPatterns.length === 0) return true;
        return this.modelPatterns.some((pattern) => pattern.test(model));
    }

    inject(input: RequestInfo | URL, init?: RequestInit): InjectionResult {
        if (this.targets.length === 0) return { init };
        if (init?.method && init.method.toUpperCase() !== "POST") return { init };

        const url = this.matchesUrl(input);
        if (!url) return { init };

        const body = parseBody(init?.body);
        if (!body) return { init };

        const model = typeof body.model === "string" ? body.model : undefined;
        if (!model || !this.matchesModel(model)) return { init };
        if (body.service_tier === this.serviceTier) return { init };

        return {
            init: {
                ...init,
                headers: withoutContentLength(init?.headers),
                body: JSON.stringify({ ...body, service_tier: this.serviceTier }),
            },
            model,
            url,
        };
    }
}

/* ------------------------------------------------------------------------ */
/* Plugin                                                                    */
/* ------------------------------------------------------------------------ */

const plugin: Plugin = async (ctx) => {
    const { config, error: configError } = readConfig();
    const matcher = new RelayFastMatcher(config);
    let state = readState();
    const originalFetch = globalThis.fetch;

    const log = (
        level: "info" | "warn" | "error",
        message: string,
        extra?: Record<string, unknown>,
    ): void => {
        void ctx.client.app
            .log({ body: { service: PLUGIN_NAME, level, message, extra } })
            .catch(() => undefined);
    };

    const toast = (message: string, variant: "info" | "success" | "warning" | "error"): void => {
        void ctx.client.tui
            .showToast({ body: { title: "Fast mode", message, variant, duration: 4000 } })
            .catch(() => undefined);
    };

    const persistState = (): void => {
        try {
            atomicWriteJson(STATE_PATH, state);
        } catch (error) {
            log("warn", "Failed to persist state", {
                path: STATE_PATH,
                error: error instanceof Error ? error.message : String(error),
            });
        }
    };

    const formatStatus = (): string => {
        const lines = [
            `Fast mode is ${state.enabled ? "ON" : "OFF"} (service_tier=${config.serviceTier}).`,
            `Injected requests: ${state.injectionCount}.`,
        ];
        if (state.lastInjectedAt) {
            lines.push(`Last: ${state.lastInjectedAt} ${state.lastInjectedModel} -> ${state.lastInjectedUrl}`);
        }
        const targets = matcher.describeTargets();
        lines.push(targets.length > 0 ? `Targets: ${targets.join("; ")}` : "Targets: none configured.");
        const unresolved = matcher.describeUnresolved();
        if (unresolved.length > 0) {
            lines.push(`Unresolved providers (no baseURL in opencode config): ${unresolved.join(", ")}`);
        }
        lines.push(`Models: ${config.models.length > 0 ? config.models.join(", ") : "all"}.`);
        if (configError) lines.push(`Config error: ${configError}`);
        return lines.join(" ");
    };

    const handleCommand = (argument: string): { message: string; short: string } => {
        const action = argument.trim().toLowerCase();
        if (action && !["on", "off", "toggle", "status"].includes(action)) {
            return {
                message: `Usage: /${COMMAND_NAME} [on|off|toggle|status]`,
                short: `Usage: /${COMMAND_NAME} [on|off|toggle|status]`,
            };
        }

        if (action !== "status") {
            state.enabled = action === "on" ? true : action === "off" ? false : !state.enabled;
            persistState();
        }

        const short = `Fast mode ${state.enabled ? "ON" : "OFF"} (${state.injectionCount} injected)`;
        return { message: formatStatus(), short };
    };

    if (configError) log("warn", configError);

    const wrappedFetch: typeof globalThis.fetch = async (input, init) => {
        if (!state.enabled) return originalFetch(input, init);

        const result = matcher.inject(input, init);
        if (result.model && result.url) {
            state.injectionCount += 1;
            state.lastInjectedAt = new Date().toISOString();
            state.lastInjectedModel = result.model;
            state.lastInjectedUrl = result.url;
            persistState();
            if (config.logInjections) {
                log("info", "Injected service tier", {
                    serviceTier: config.serviceTier,
                    model: result.model,
                    url: result.url,
                });
            }
        }
        return originalFetch(input, result.init);
    };

    globalThis.fetch = wrappedFetch;

    return {
        config: async (opencodeConfig) => {
            matcher.resolveProviders(opencodeConfig.provider);
            const unresolved = matcher.describeUnresolved();
            if (unresolved.length > 0) {
                log("warn", "Configured providers have no baseURL in OpenCode config", {
                    providers: unresolved,
                });
            }
            if (!matcher.hasTargets) {
                log("warn", `No targets configured; edit ${CONFIG_PATH}`);
            }

            opencodeConfig.command ??= {};
            opencodeConfig.command[COMMAND_NAME] = {
                template: `Manage relay Fast mode: $ARGUMENTS`,
                description: `Toggle or inspect ${config.serviceTier} service_tier injection for relay providers`,
                ...(config.commandModel ? { model: config.commandModel } : {}),
            };
        },

        "command.execute.before": async (input, output) => {
            if (input.command !== COMMAND_NAME) return;

            const { message, short } = handleCommand(input.arguments);
            toast(short, state.enabled ? "success" : "info");

            // OpenCode has no way to cancel a command from this hook, so the
            // prompt is replaced with a one-line echo request. It still costs
            // one tiny model call; set `commandModel` to route it cheaply.
            const textPart = output.parts.find((part) => part.type === "text");
            if (!textPart || textPart.type !== "text") return;
            textPart.text = `Reply with exactly the following text and nothing else:\n${message}`;
            output.parts.splice(0, output.parts.length, textPart);
        },
    };
};

export default plugin;
