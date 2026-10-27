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
    /** Replace a `service_tier` the request already carries. When false, such requests are left unchanged. */
    overwriteServiceTier: boolean;
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
    /** Resolved from a provider ID rather than listed explicitly in `baseURLs`. */
    fromProvider: boolean;
};

type ProviderMap = Record<string, { options?: { baseURL?: string } }>;

const DEFAULT_CONFIG: RelayFastConfig = {
    providers: [],
    baseURLs: [],
    endpoints: DEFAULT_ENDPOINTS,
    models: [],
    serviceTier: DEFAULT_SERVICE_TIER,
    overwriteServiceTier: true,
    commandModel: undefined,
    logInjections: true,
};

/* ------------------------------------------------------------------------ */
/* Small helpers                                                             */
/* ------------------------------------------------------------------------ */

/** Strip `//` and `/* *\/` comments plus trailing commas so JSONC parses as JSON. String-aware. */
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

        if (ch === "}" || ch === "]") {
            // Trailing comma outside a string: drop the last emitted `,` if only whitespace follows it.
            const trimmed = out.replace(/\s+$/, "");
            if (trimmed.endsWith(",")) out = trimmed.slice(0, -1) + out.slice(trimmed.length);
        }

        out += ch;
        i += 1;
    }

    return out;
}

/** Returns the trimmed array, or throws when the key is present but not an array of non-empty strings. */
function stringArray(raw: Record<string, unknown>, key: string): string[] | undefined {
    const value = raw[key];
    if (value === undefined || value === null) return undefined;
    if (
        !Array.isArray(value) ||
        !value.every((item) => typeof item === "string" && item.trim().length > 0)
    ) {
        throw new Error(`"${key}" must be an array of non-empty strings`);
    }
    return value.map((item: string) => item.trim());
}

/** Returns the trimmed string, or throws when the key is present but not a non-empty string. */
function optionalString(raw: Record<string, unknown>, key: string): string | undefined {
    const value = raw[key];
    if (value === undefined || value === null) return undefined;
    if (typeof value !== "string" || !value.trim()) {
        throw new Error(`"${key}" must be a non-empty string`);
    }
    return value.trim();
}

/** Returns the boolean, or throws when the key is present but not a boolean. */
function optionalBoolean(raw: Record<string, unknown>, key: string): boolean | undefined {
    const value = raw[key];
    if (value === undefined || value === null) return undefined;
    if (typeof value !== "boolean") throw new Error(`"${key}" must be true or false`);
    return value;
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

function bodyToString(body: BodyInit): string | undefined {
    if (typeof body === "string") return body;
    if (body instanceof Uint8Array) return new TextDecoder().decode(body);
    return undefined;
}

function parseJsonObject(raw: string): Record<string, unknown> | undefined {
    try {
        const parsed: unknown = JSON.parse(raw);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
        return parsed as Record<string, unknown>;
    } catch {
        return undefined;
    }
}

/** Copy headers without Content-Length; the body length changes after injection. */
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

/**
 * Normalise `fetch(input, init)` into the pieces the matcher needs. `init`
 * wins over fields carried by a `Request` input, mirroring the Fetch spec.
 */
async function readRequest(
    input: RequestInfo | URL,
    init: RequestInit | undefined,
): Promise<{ method: string; headers: HeadersInit | undefined; body: string | undefined }> {
    const request = typeof Request !== "undefined" && input instanceof Request ? input : undefined;
    const method = (init?.method ?? request?.method ?? "GET").toUpperCase();
    const headers = init?.headers ?? request?.headers;

    if (init?.body !== undefined && init.body !== null) {
        return { method, headers, body: bodyToString(init.body) };
    }
    if (request?.body) {
        try {
            return { method, headers, body: await request.clone().text() };
        } catch {
            return { method, headers, body: undefined };
        }
    }
    return { method, headers, body: undefined };
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

/** Parse JSONC config text. Throws on malformed JSON or wrongly typed fields (fail closed). */
export function parseConfig(text: string): RelayFastConfig {
    const parsed: unknown = JSON.parse(stripJsonc(text));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("config must be a JSON object");
    }
    const raw = parsed as Record<string, unknown>;

    const endpoints = stringArray(raw, "endpoints")?.map(normaliseEndpoint);

    return {
        providers: stringArray(raw, "providers") ?? [],
        baseURLs: stringArray(raw, "baseURLs") ?? [],
        endpoints: endpoints && endpoints.length > 0 ? endpoints : DEFAULT_ENDPOINTS,
        models: stringArray(raw, "models") ?? [],
        serviceTier: optionalString(raw, "serviceTier") ?? DEFAULT_SERVICE_TIER,
        overwriteServiceTier: optionalBoolean(raw, "overwriteServiceTier") ?? true,
        commandModel: optionalString(raw, "commandModel"),
        logInjections: optionalBoolean(raw, "logInjections") ?? true,
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
    private ambiguousProviders: string[] = [];
    private unselected = new Set<string>();

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
            if (prefix) this.targets.push({ prefix, source: `baseURLs: ${raw}`, fromProvider: false });
        }
        this.unresolvedProviders = [...this.config.providers];
        this.ambiguousProviders = [];
        this.unselected = new Set();
    }

    /**
     * Resolve `providers` against the provider map found in OpenCode's config.
     *
     * Requests are matched by URL, so a selected provider that shares its base URL
     * with an unselected provider cannot be told apart from it. Such providers are
     * skipped (fail closed) and reported. List both providers, or use `baseURLs`,
     * to opt in to URL-wide matching deliberately.
     */
    resolveProviders(providers: ProviderMap | undefined): void {
        this.setExplicitTargets();
        this.unresolvedProviders = [];

        const prefixes = new Map<string, string>();
        for (const [id, provider] of Object.entries(providers ?? {})) {
            const baseURL = provider?.options?.baseURL;
            const prefix = baseURL ? normaliseBaseUrl(baseURL) : undefined;
            if (prefix) prefixes.set(id, prefix);
        }

        const selected = new Set(this.config.providers);
        for (const [id, prefix] of prefixes) {
            if (!selected.has(id)) this.unselected.add(prefix);
        }
        for (const id of this.config.providers) {
            const prefix = prefixes.get(id);
            if (!prefix) {
                this.unresolvedProviders.push(id);
                continue;
            }

            const sharedWith = [...prefixes]
                .filter(([other, otherPrefix]) => other !== id && otherPrefix === prefix && !selected.has(other))
                .map(([other]) => other);
            if (sharedWith.length > 0) {
                this.ambiguousProviders.push(`${id} shares ${prefix} with unselected ${sharedWith.join(", ")}`);
                continue;
            }

            if (!this.targets.some((target) => target.prefix === prefix)) {
                this.targets.push({ prefix, source: `provider: ${id}`, fromProvider: true });
            }
        }
    }

    get hasTargets(): boolean {
        return this.targets.length > 0;
    }

    get targetList(): readonly Target[] {
        return this.targets;
    }

    /** Base URLs of resolved providers that are not selected. */
    get unselectedPrefixes(): ReadonlySet<string> {
        return this.unselected;
    }

    describeTargets(): string[] {
        return this.targets.map((target) => `${target.prefix} (${target.source})`);
    }

    describeUnresolved(): string[] {
        return [...this.unresolvedProviders];
    }

    describeAmbiguous(): string[] {
        return [...this.ambiguousProviders];
    }

    /** Returns the sanitised URL (origin + path; no credentials, query or fragment) when it is a Fast endpoint. */
    matchesUrl(input: RequestInfo | URL): string | undefined {
        return this.matchTarget(input)?.url;
    }

    /** Like `matchesUrl`, but also returns the target that matched. */
    matchTarget(input: RequestInfo | URL): { url: string; target: Target } | undefined {
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
            if (this.endpoints.includes(rest)) return { url: full, target };
        }
        return undefined;
    }

    matchesModel(model: string): boolean {
        if (this.modelPatterns.length === 0) return true;
        return this.modelPatterns.some((pattern) => pattern.test(model));
    }

    /** Rewrite a JSON request body; returns undefined when nothing should change. */
    injectBody(rawBody: string): { body: string; model: string } | undefined {
        const body = parseJsonObject(rawBody);
        if (!body) return undefined;

        const model = typeof body.model === "string" ? body.model : undefined;
        if (!model || !this.matchesModel(model)) return undefined;
        if (body.service_tier === this.serviceTier) return undefined;
        if (body.service_tier !== undefined && !this.config.overwriteServiceTier) return undefined;

        return { body: JSON.stringify({ ...body, service_tier: this.serviceTier }), model };
    }
}

/* ------------------------------------------------------------------------ */
/* Shared runtime                                                            */
/* ------------------------------------------------------------------------ */

/**
 * OpenCode may initialise a plugin more than once per process (one instance
 * per project directory). All instances share this controller and a single
 * fetch wrapper, so `/fast off` in any instance stops injection everywhere.
 * Each project keeps its own provider map, and requests are matched against
 * all of them.
 */
type Controller = {
    config: RelayFastConfig;
    configError?: string;
    /** OpenCode provider map per project directory (undefined until its `config` hook runs). */
    projects: Map<string, ProviderMap | undefined>;
    /** One matcher per entry in `projects`, rebuilt by `rebuildMatchers`. */
    matchers: Map<string, RelayFastMatcher>;
    state: RelayFastState;
    log: (level: "info" | "warn" | "error", message: string, extra?: Record<string, unknown>) => void;
    persistTimer?: ReturnType<typeof setTimeout>;
};

/** Injection counters are written at most this often, off the request path. */
const PERSIST_DELAY_MS = 1000;

const CONTROLLER_KEY = Symbol.for(`${PLUGIN_NAME}.controller`);
const ORIGINAL_FETCH_KEY = Symbol.for(`${PLUGIN_NAME}.originalFetch`);

type GlobalWithPlugin = typeof globalThis & {
    [CONTROLLER_KEY]?: Controller;
    [ORIGINAL_FETCH_KEY]?: typeof globalThis.fetch;
};

function getController(): Controller | undefined {
    return (globalThis as GlobalWithPlugin)[CONTROLLER_KEY];
}

function persistState(controller: Controller): void {
    clearTimeout(controller.persistTimer);
    controller.persistTimer = undefined;
    try {
        atomicWriteJson(STATE_PATH, controller.state);
    } catch (error) {
        controller.log("warn", "Failed to persist state", {
            path: STATE_PATH,
            error: error instanceof Error ? error.message : String(error),
        });
    }
}

function schedulePersist(controller: Controller): void {
    if (controller.persistTimer) return;
    controller.persistTimer = setTimeout(() => persistState(controller), PERSIST_DELAY_MS);
    controller.persistTimer.unref?.();
}

let exitHookInstalled = false;

/** Flush counters that are still waiting for the debounce timer when the process exits. */
function installExitHook(): void {
    if (exitHookInstalled) return;
    exitHookInstalled = true;
    process.once("exit", () => {
        const controller = getController();
        if (controller?.persistTimer) persistState(controller);
    });
}

function rebuildMatchers(controller: Controller): void {
    controller.matchers = new Map();
    for (const [project, providers] of controller.projects) {
        const matcher = new RelayFastMatcher(controller.config);
        matcher.resolveProviders(providers);
        controller.matchers.set(project, matcher);
    }
}

/** Base URLs that some open project uses for a provider it did not select. */
function unselectedPrefixes(controller: Controller): Set<string> {
    const prefixes = new Set<string>();
    for (const matcher of controller.matchers.values()) {
        for (const prefix of matcher.unselectedPrefixes) prefixes.add(prefix);
    }
    return prefixes;
}

/**
 * Requests are matched by URL only, so a provider target from one project is
 * skipped (fail closed) when another open project has an unselected provider on
 * the same base URL. Explicit `baseURLs` are a deliberate opt-in and always apply.
 */
function matchRequest(
    controller: Controller,
    input: RequestInfo | URL,
): { matcher: RelayFastMatcher; url: string } | undefined {
    const unselected = unselectedPrefixes(controller);
    for (const matcher of controller.matchers.values()) {
        const hit = matcher.matchTarget(input);
        if (!hit) continue;
        if (hit.target.fromProvider && unselected.has(hit.target.prefix)) continue;
        return { matcher, url: hit.url };
    }
    return undefined;
}

async function fastFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const g = globalThis as GlobalWithPlugin;
    const originalFetch = g[ORIGINAL_FETCH_KEY]!;
    const controller = getController();
    if (!controller || !controller.state.enabled) return originalFetch(input, init);

    const { config, state } = controller;
    const match = matchRequest(controller, input);
    if (!match) return originalFetch(input, init);
    const { matcher, url } = match;

    const request = await readRequest(input, init);
    if (request.method !== "POST" || request.body === undefined) return originalFetch(input, init);

    const injected = matcher.injectBody(request.body);
    if (!injected) return originalFetch(input, init);

    state.injectionCount += 1;
    state.lastInjectedAt = new Date().toISOString();
    state.lastInjectedModel = injected.model;
    state.lastInjectedUrl = url;
    schedulePersist(controller);
    if (config.logInjections) {
        controller.log("info", "Injected service tier", {
            serviceTier: config.serviceTier,
            model: injected.model,
            url,
        });
    }

    return originalFetch(input, {
        ...init,
        method: request.method,
        headers: withoutContentLength(request.headers),
        body: injected.body,
    });
}

/**
 * Install the fetch wrapper exactly once per process. Exposed for tests.
 *
 * Never re-install once the original fetch is recorded: if another plugin has
 * since wrapped our wrapper, recording that wrapper as "original" would make
 * the two call each other forever.
 */
export function installFetchWrapper(): void {
    const g = globalThis as GlobalWithPlugin;
    if (g[ORIGINAL_FETCH_KEY]) return;
    g[ORIGINAL_FETCH_KEY] = globalThis.fetch;
    globalThis.fetch = fastFetch;
}

/** Restore the original fetch and forget the controller. Exposed for tests. */
export function uninstallFetchWrapper(): void {
    const g = globalThis as GlobalWithPlugin;
    if (g[ORIGINAL_FETCH_KEY]) globalThis.fetch = g[ORIGINAL_FETCH_KEY];
    clearTimeout(g[CONTROLLER_KEY]?.persistTimer);
    delete g[ORIGINAL_FETCH_KEY];
    delete g[CONTROLLER_KEY];
}

/* ------------------------------------------------------------------------ */
/* Plugin                                                                    */
/* ------------------------------------------------------------------------ */

const plugin: Plugin = async (ctx) => {
    const { config, error: configError } = readConfig();

    const log: Controller["log"] = (level, message, extra) => {
        void ctx.client.app
            .log({ body: { service: PLUGIN_NAME, level, message, extra } })
            .catch(() => undefined);
    };

    const toast = (message: string, variant: "info" | "success" | "warning" | "error"): void => {
        void ctx.client.tui
            .showToast({ body: { title: "Fast mode", message, variant, duration: 4000 } })
            .catch(() => undefined);
    };

    // Re-initialisation reloads the shared config and registers this project,
    // keeping the single shared state and every other project's provider map.
    const project = ctx.directory ?? "";
    const controller: Controller = getController() ?? {
        config,
        projects: new Map(),
        matchers: new Map(),
        state: readState(),
        log,
    };
    controller.config = config;
    controller.configError = configError;
    controller.log = log;
    if (!controller.projects.has(project)) controller.projects.set(project, undefined);
    rebuildMatchers(controller);
    (globalThis as GlobalWithPlugin)[CONTROLLER_KEY] = controller;
    installFetchWrapper();
    installExitHook();

    if (configError) log("warn", configError);

    const formatStatus = (): string => {
        const { state, config, configError } = controller;
        const matchers = [...controller.matchers.values()];
        const unselected = unselectedPrefixes(controller);
        const targets = new Set<string>();
        const crossProject = new Set<string>();
        for (const matcher of matchers) {
            for (const target of matcher.targetList) {
                const label = `${target.prefix} (${target.source})`;
                (target.fromProvider && unselected.has(target.prefix) ? crossProject : targets).add(label);
            }
        }
        const lines = [
            `Fast mode is ${state.enabled ? "ON" : "OFF"} (service_tier=${config.serviceTier}).`,
            `Injected requests: ${state.injectionCount}.`,
        ];
        if (state.lastInjectedAt) {
            lines.push(`Last: ${state.lastInjectedAt} ${state.lastInjectedModel} -> ${state.lastInjectedUrl}`);
        }
        lines.push(targets.size > 0 ? `Targets: ${[...targets].join("; ")}` : "Targets: none configured.");
        const unresolved = config.providers.filter((id) =>
            matchers.every((matcher) => matcher.describeUnresolved().includes(id)),
        );
        if (unresolved.length > 0) {
            lines.push(`Unresolved providers (no baseURL in opencode config): ${unresolved.join(", ")}`);
        }
        const ambiguous = new Set(matchers.flatMap((matcher) => matcher.describeAmbiguous()));
        if (ambiguous.size > 0) {
            lines.push(`Skipped ambiguous providers: ${[...ambiguous].join("; ")}. List both providers or use baseURLs to opt in.`);
        }
        if (crossProject.size > 0) {
            lines.push(`Skipped providers whose base URL another open project uses for an unselected provider: ${[...crossProject].join("; ")}. Use baseURLs to opt in.`);
        }
        lines.push(`Models: ${config.models.length > 0 ? config.models.join(", ") : "all"}.`);
        if (!config.overwriteServiceTier) lines.push("Existing service_tier values are preserved.");
        if (configError) lines.push(`Config error (injection disabled): ${configError}`);
        return lines.join(" ");
    };

    const handleCommand = (argument: string): { message: string; short: string } => {
        const action = argument.trim().toLowerCase();
        if (action && !["on", "off", "toggle", "status"].includes(action)) {
            const usage = `Usage: /${COMMAND_NAME} [on|off|toggle|status]`;
            return { message: usage, short: usage };
        }

        const { state } = controller;
        if (action !== "status") {
            state.enabled = action === "on" ? true : action === "off" ? false : !state.enabled;
        }
        // Also flushes counters still waiting for the debounce timer.
        persistState(controller);

        const short = `Fast mode ${state.enabled ? "ON" : "OFF"} (${state.injectionCount} injected)`;
        return { message: formatStatus(), short };
    };

    return {
        config: async (opencodeConfig) => {
            controller.projects.set(project, opencodeConfig.provider);
            rebuildMatchers(controller);
            const matcher = controller.matchers.get(project)!;

            const unresolved = matcher.describeUnresolved();
            if (unresolved.length > 0) {
                log("warn", "Configured providers have no baseURL in OpenCode config", {
                    providers: unresolved,
                });
            }
            const ambiguous = matcher.describeAmbiguous();
            if (ambiguous.length > 0) {
                log("warn", "Skipped providers that share a base URL with unselected providers", {
                    providers: ambiguous,
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
            toast(short, controller.state.enabled ? "success" : "info");

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
