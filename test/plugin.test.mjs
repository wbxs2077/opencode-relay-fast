import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const configRoot = mkdtempSync(join(tmpdir(), "opencode-relay-fast-test-"));
const configPath = join(configRoot, "opencode-relay-fast.jsonc");
const statePath = join(configRoot, "opencode-relay-fast.state.json");
process.env.OPENCODE_RELAY_FAST_CONFIG = configPath;
process.env.OPENCODE_RELAY_FAST_STATE = statePath;

const BASE_CONFIG = `{
  // provider IDs are resolved from OpenCode's own config
  "providers": ["relay-a", "missing-provider"],
  "baseURLs": ["https://explicit.example.com/openai/v1/"],
  "models": ["gpt-5.5", "gpt-5.6-*"],
  "serviceTier": "priority", /* trailing comma below is fine */
}
`;
writeFileSync(configPath, BASE_CONFIG);

const {
    default: plugin,
    stripJsonc,
    parseConfig,
    RelayFastMatcher,
    uninstallFetchWrapper,
} = await import("../dist/index.js");
const realFetch = globalThis.fetch;

const OPENCODE_CONFIG = {
    provider: {
        "relay-a": { options: { baseURL: "https://Relay-A.example.com/v1" } },
        "relay-b": { options: { baseURL: "https://relay-b.example.com/v1" } },
    },
};

function makeContext(logs, toasts) {
    return {
        client: {
            app: { log: async (input) => logs.push(input) },
            tui: { showToast: async (input) => toasts.push(input) },
        },
    };
}

/** Fresh process-like start: remove any installed wrapper and controller, then load the plugin. */
async function loadPlugin({ opencodeConfig = OPENCODE_CONFIG, fresh = true } = {}) {
    const requests = [];
    const logs = [];
    const toasts = [];
    if (fresh) {
        uninstallFetchWrapper();
        globalThis.fetch = async (input, init) => {
            const request = input instanceof Request ? input : undefined;
            requests.push({
                url: request ? request.url : String(input),
                init,
                body: init?.body ?? (request ? await request.clone().text() : undefined),
                headers: init?.headers ?? request?.headers,
            });
            return new Response("{}", { status: 200 });
        };
    }
    const hooks = await plugin(makeContext(logs, toasts));
    const cfg = structuredClone(opencodeConfig);
    await hooks.config(cfg);
    return { hooks, requests, logs, toasts, opencodeConfig: cfg };
}

async function runFast(hooks, args) {
    const output = { parts: [{ type: "text", text: "Manage relay Fast mode: $ARGUMENTS" }] };
    await hooks["command.execute.before"]({ command: "fast", sessionID: "s", arguments: args }, output);
    return output.parts[0].text;
}

function post(url, body, extraInit = {}) {
    return globalThis.fetch(url, { method: "POST", body: JSON.stringify(body), ...extraInit });
}

function lastTier(requests) {
    return JSON.parse(requests.at(-1).body).service_tier;
}

function headerValue(headers, name) {
    if (!headers) return undefined;
    if (headers instanceof Headers) return headers.get(name) ?? undefined;
    const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === name);
    return entry?.[1];
}

/* ------------------------------------------------------------------------ */
/* Unit                                                                      */
/* ------------------------------------------------------------------------ */

test("stripJsonc removes comments and trailing commas but keeps strings intact", () => {
    const text = `{
  // line comment
  "url": "https://x.example.com/v1", /* block */
  "note": "keep // this and /* this */",
  "tricky": "gpt,}",
  "list": [1, 2,],
  "nested": { "a": "b,]", },
}`;
    assert.deepEqual(JSON.parse(stripJsonc(text)), {
        url: "https://x.example.com/v1",
        note: "keep // this and /* this */",
        tricky: "gpt,}",
        list: [1, 2],
        nested: { a: "b,]" },
    });
});

test("parseConfig applies defaults, normalises endpoints and rejects wrong types", () => {
    const config = parseConfig(`{ "endpoints": ["chat/completions/", "/responses"], "logInjections": false }`);
    assert.deepEqual(config.endpoints, ["/chat/completions", "/responses"]);
    assert.equal(config.serviceTier, "priority");
    assert.equal(config.logInjections, false);
    assert.deepEqual(config.models, []);
    assert.deepEqual(parseConfig("{}").endpoints, ["/responses", "/chat/completions"]);

    assert.throws(() => parseConfig(`{ "models": "gpt-only" }`), /"models" must be an array/);
    assert.throws(() => parseConfig(`{ "providers": [1] }`), /"providers" must be an array/);
    assert.throws(() => parseConfig(`{ "baseURLs": [""] }`), /"baseURLs" must be an array/);
    assert.throws(() => parseConfig(`[]`), /must be a JSON object/);
});

test("matcher resolves providers, matches base URL prefix plus endpoint, strips query", () => {
    const matcher = new RelayFastMatcher(
        parseConfig(`{ "providers": ["relay-a"], "baseURLs": ["https://explicit.example.com/openai/v1/"] }`),
    );
    matcher.resolveProviders(OPENCODE_CONFIG.provider);

    assert.equal(
        matcher.matchesUrl("https://relay-a.example.com/v1/chat/completions"),
        "https://relay-a.example.com/v1/chat/completions",
    );
    assert.ok(matcher.matchesUrl("https://RELAY-A.example.com/v1/responses/"));
    assert.ok(matcher.matchesUrl("https://explicit.example.com/openai/v1/responses"));
    assert.equal(
        matcher.matchesUrl("https://user:pw@relay-a.example.com/v1/responses?api_key=SECRET#frag"),
        "https://relay-a.example.com/v1/responses",
    );
    assert.equal(matcher.matchesUrl("https://relay-a.example.com/v1/models"), undefined);
    assert.equal(matcher.matchesUrl("https://relay-a.example.com/v2/responses"), undefined);
    assert.equal(matcher.matchesUrl("https://relay-b.example.com/v1/responses"), undefined);
    assert.equal(matcher.matchesUrl("not a url"), undefined);
});

test("providers sharing a base URL with an unselected provider are skipped (fail closed)", () => {
    const providers = {
        pro: { options: { baseURL: "https://shared.example.com/v1" } },
        "pro-fast": { options: { baseURL: "https://shared.example.com/v1" } },
        other: { options: { baseURL: "https://other.example.com/v1" } },
    };

    const one = new RelayFastMatcher(parseConfig(`{ "providers": ["pro-fast"] }`));
    one.resolveProviders(providers);
    assert.equal(one.hasTargets, false);
    assert.match(one.describeAmbiguous()[0], /pro-fast shares https:\/\/shared.example.com\/v1 with unselected pro/);

    const both = new RelayFastMatcher(parseConfig(`{ "providers": ["pro", "pro-fast"] }`));
    both.resolveProviders(providers);
    assert.deepEqual(both.describeTargets(), ["https://shared.example.com/v1 (provider: pro)"]);
    assert.deepEqual(both.describeAmbiguous(), []);

    const explicit = new RelayFastMatcher(
        parseConfig(`{ "providers": ["pro-fast"], "baseURLs": ["https://shared.example.com/v1"] }`),
    );
    explicit.resolveProviders(providers);
    assert.equal(explicit.hasTargets, true);
    assert.equal(explicit.describeAmbiguous().length, 1);
});

test("model globs restrict injection; empty list allows all", () => {
    const restricted = new RelayFastMatcher(parseConfig(`{ "models": ["gpt-5.5", "gpt-5.6-*"] }`));
    assert.ok(restricted.matchesModel("gpt-5.5"));
    assert.ok(restricted.matchesModel("gpt-5.6-sol"));
    assert.ok(!restricted.matchesModel("gpt-5.4"));
    assert.ok(!restricted.matchesModel("gpt-5x5"));

    const open = new RelayFastMatcher(parseConfig("{}"));
    assert.ok(open.matchesModel("anything"));
});

/* ------------------------------------------------------------------------ */
/* Plugin integration                                                        */
/* ------------------------------------------------------------------------ */

test("injects only matching requests while enabled, and records state", async () => {
    const { hooks, requests, logs, toasts } = await loadPlugin();

    assert.match(await runFast(hooks, "on"), /Fast mode is ON/);
    assert.equal(toasts.at(-1).body.variant, "success");

    await post("https://relay-a.example.com/v1/responses", { model: "gpt-5.6-sol", input: "hi" });
    assert.equal(lastTier(requests), "priority");

    await post("https://relay-a.example.com/v1/chat/completions", { model: "gpt-5.5", messages: [] });
    assert.equal(lastTier(requests), "priority");

    await post("https://explicit.example.com/openai/v1/responses", { model: "gpt-5.6-luna", input: "x" });
    assert.equal(lastTier(requests), "priority");

    await post("https://relay-a.example.com/v1/responses", { model: "gpt-5.4", input: "hi" }); // model
    assert.equal(lastTier(requests), undefined);
    await post("https://relay-b.example.com/v1/responses", { model: "gpt-5.6-sol", input: "hi" }); // provider
    assert.equal(lastTier(requests), undefined);
    await post("https://relay-a.example.com/v1/embeddings", { model: "gpt-5.6-sol", input: "hi" }); // endpoint
    assert.equal(lastTier(requests), undefined);

    const original = JSON.stringify({ model: "gpt-5.5", input: "hi", service_tier: "priority" });
    await globalThis.fetch("https://relay-a.example.com/v1/responses", { method: "POST", body: original });
    assert.equal(requests.at(-1).body, original);

    const status = await runFast(hooks, "status");
    assert.match(status, /Injected requests: 3/);
    assert.match(status, /provider: relay-a/);
    assert.match(status, /Unresolved providers.*missing-provider/);

    const persisted = JSON.parse(readFileSync(statePath, "utf8"));
    assert.equal(persisted.enabled, true);
    assert.equal(persisted.injectionCount, 3);
    assert.equal(persisted.lastInjectedModel, "gpt-5.6-luna");

    assert.equal(logs.filter((entry) => entry.body.message === "Injected service tier").length, 3);
    assert.ok(logs.some((entry) => entry.body.level === "warn" && /missing-provider/.test(JSON.stringify(entry))));
});

test("Request inputs are inspected and rewritten, including their Content-Length", async () => {
    const { hooks, requests } = await loadPlugin();
    await runFast(hooks, "on");

    const body = JSON.stringify({ model: "gpt-5.5", input: "hi" });
    await globalThis.fetch(
        new Request("https://relay-a.example.com/v1/responses", {
            method: "POST",
            body,
            headers: { "content-type": "application/json", "content-length": String(body.length) },
        }),
    );
    assert.equal(lastTier(requests), "priority");
    assert.equal(headerValue(requests.at(-1).headers, "content-length"), undefined);
    assert.equal(headerValue(requests.at(-1).headers, "content-type"), "application/json");

    // init overrides the Request per the Fetch spec
    await globalThis.fetch(new Request("https://relay-a.example.com/v1/responses", { method: "POST", body }), {
        body: JSON.stringify({ model: "gpt-5.4" }),
    });
    assert.equal(lastTier(requests), undefined);

    // GET Request without body is untouched
    await globalThis.fetch(new Request("https://relay-a.example.com/v1/responses"));
    assert.equal(requests.at(-1).body, "");
});

test("Uint8Array bodies are supported and Content-Length is dropped from init headers", async () => {
    const { hooks, requests } = await loadPlugin();
    await runFast(hooks, "on");

    const bytes = new TextEncoder().encode(JSON.stringify({ model: "gpt-5.5", input: "hi" }));
    await globalThis.fetch("https://relay-a.example.com/v1/responses", {
        method: "POST",
        body: bytes,
        headers: { "Content-Type": "application/json", "Content-Length": String(bytes.length) },
    });
    assert.equal(lastTier(requests), "priority");
    assert.deepEqual(requests.at(-1).init.headers, { "Content-Type": "application/json" });

    await globalThis.fetch("https://relay-a.example.com/v1/responses", {
        method: "POST",
        body: JSON.stringify({ model: "gpt-5.5" }),
        headers: new Headers({ "content-length": "10" }),
    });
    assert.equal(requests.at(-1).init.headers.get("content-length"), null);
});

test("query strings and credentials never reach state, logs or status", async () => {
    const { hooks, requests, logs } = await loadPlugin();
    await runFast(hooks, "on");

    await post("https://user:pw@relay-a.example.com/v1/responses?api_key=SECRET", { model: "gpt-5.5" });
    assert.equal(lastTier(requests), "priority");

    const status = await runFast(hooks, "status");
    assert.ok(!status.includes("SECRET") && !status.includes("user:pw"));
    assert.ok(!readFileSync(statePath, "utf8").includes("SECRET"));
    assert.ok(!JSON.stringify(logs).includes("SECRET"));
    assert.match(status, /Last: .* gpt-5.5 -> https:\/\/relay-a.example.com\/v1\/responses/);
});

test("re-initialisation shares one controller: /fast off in a later instance stops injection", async () => {
    const first = await loadPlugin();
    await runFast(first.hooks, "on");
    await post("https://relay-a.example.com/v1/responses", { model: "gpt-5.5" });
    assert.equal(lastTier(first.requests), "priority");

    const second = await loadPlugin({ fresh: false });
    await runFast(second.hooks, "off");
    await post("https://relay-a.example.com/v1/responses", { model: "gpt-5.5" });
    assert.equal(lastTier(first.requests), undefined);

    await runFast(first.hooks, "on");
    await post("https://relay-a.example.com/v1/responses", { model: "gpt-5.5" });
    assert.equal(lastTier(first.requests), "priority");

    // exactly one wrapper layer: each request reaches the mock once
    assert.equal(first.requests.length, 3);
    assert.equal(second.requests.length, 0);
});

test("off and toggle change state; non-POST and other commands are ignored", async () => {
    const { hooks, requests, toasts } = await loadPlugin();

    assert.match(await runFast(hooks, "off"), /Fast mode is OFF/);
    await post("https://relay-a.example.com/v1/responses", { model: "gpt-5.6-sol", input: "hi" });
    assert.equal(lastTier(requests), undefined);

    assert.match(await runFast(hooks, ""), /Fast mode is ON/);
    assert.match(await runFast(hooks, "toggle"), /Fast mode is OFF/);
    assert.match(await runFast(hooks, "bogus"), /Usage: \/fast/);
    assert.equal(toasts.length, 4);

    await runFast(hooks, "on");
    await globalThis.fetch("https://relay-a.example.com/v1/responses", {
        method: "GET",
        body: JSON.stringify({ model: "gpt-5.5" }),
    });
    assert.equal(lastTier(requests), undefined);

    const output = { parts: [{ type: "text", text: "unrelated" }] };
    await hooks["command.execute.before"]({ command: "other", sessionID: "s", arguments: "" }, output);
    assert.equal(output.parts[0].text, "unrelated");
});

test("config hook registers the /fast command and honours commandModel", async () => {
    const { opencodeConfig } = await loadPlugin();
    assert.equal(opencodeConfig.command.fast.template, "Manage relay Fast mode: $ARGUMENTS");
    assert.equal(opencodeConfig.command.fast.model, undefined);

    writeFileSync(configPath, `{ "providers": ["relay-a"], "commandModel": "relay-a/gpt-5.4-mini" }`);
    const again = await loadPlugin();
    assert.equal(again.opencodeConfig.command.fast.model, "relay-a/gpt-5.4-mini");
    writeFileSync(configPath, BASE_CONFIG);
});

test("invalid config fails closed: no targets, error reported, nothing injected", async () => {
    for (const bad of [`{ "providers": [ `, `{ "providers": ["relay-a"], "models": "gpt-only" }`]) {
        writeFileSync(configPath, bad);
        const { hooks, logs, requests } = await loadPlugin();
        await runFast(hooks, "on");
        await post("https://relay-a.example.com/v1/responses", { model: "unexpected" });
        assert.equal(lastTier(requests), undefined);

        const status = await runFast(hooks, "status");
        assert.match(status, /Config error \(injection disabled\)/);
        assert.match(status, /Targets: none configured/);
        assert.ok(logs.some((entry) => entry.body.level === "warn" && /Failed to parse/.test(entry.body.message)));
    }
    writeFileSync(configPath, BASE_CONFIG);
});

test("ambiguous providers are reported in status and logs", async () => {
    writeFileSync(configPath, `{ "providers": ["pro-fast"] }`);
    const shared = {
        provider: {
            pro: { options: { baseURL: "https://shared.example.com/v1" } },
            "pro-fast": { options: { baseURL: "https://shared.example.com/v1" } },
        },
    };
    const { hooks, logs, requests } = await loadPlugin({ opencodeConfig: shared });
    await runFast(hooks, "on");
    await post("https://shared.example.com/v1/responses", { model: "gpt-5.5" });
    assert.equal(lastTier(requests), undefined);
    assert.match(await runFast(hooks, "status"), /Skipped ambiguous providers: pro-fast shares .* with unselected pro/);
    assert.ok(logs.some((entry) => /share a base URL/.test(entry.body.message)));
    writeFileSync(configPath, BASE_CONFIG);
});

test.after(() => {
    uninstallFetchWrapper();
    globalThis.fetch = realFetch;
    rmSync(configRoot, { recursive: true, force: true });
});
