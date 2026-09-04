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

writeFileSync(
    configPath,
    `{
  // provider IDs are resolved from OpenCode's own config
  "providers": ["relay-a", "missing-provider"],
  "baseURLs": ["https://explicit.example.com/openai/v1/"],
  "models": ["gpt-5.5", "gpt-5.6-*"],
  "serviceTier": "priority", /* trailing comma below is fine */
}
`,
);

const { default: plugin, stripJsonc, parseConfig, RelayFastMatcher } = await import("../dist/index.js");
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

async function loadPlugin() {
    const requests = [];
    const logs = [];
    const toasts = [];
    globalThis.fetch = async (input, init) => {
        requests.push({ input: String(input), init });
        return new Response("{}", { status: 200 });
    };
    const hooks = await plugin(makeContext(logs, toasts));
    const opencodeConfig = structuredClone(OPENCODE_CONFIG);
    await hooks.config(opencodeConfig);
    return { hooks, requests, logs, toasts, opencodeConfig };
}

async function runFast(hooks, args) {
    const output = { parts: [{ type: "text", text: "Manage relay Fast mode: $ARGUMENTS" }] };
    await hooks["command.execute.before"]({ command: "fast", sessionID: "s", arguments: args }, output);
    return output.parts[0].text;
}

function post(url, body, extraInit = {}) {
    return globalThis.fetch(url, { method: "POST", body: JSON.stringify(body), ...extraInit });
}

function lastBody(requests) {
    return JSON.parse(requests.at(-1).init.body);
}

test("stripJsonc removes comments and trailing commas but keeps strings intact", () => {
    const text = `{
  // line comment
  "url": "https://x.example.com/v1", /* block */
  "note": "keep // this and /* this */",
  "list": [1, 2,],
}`;
    assert.deepEqual(JSON.parse(stripJsonc(text)), {
        url: "https://x.example.com/v1",
        note: "keep // this and /* this */",
        list: [1, 2],
    });
});

test("parseConfig applies defaults and normalises endpoints", () => {
    const config = parseConfig(`{ "endpoints": ["chat/completions/", "/responses"], "logInjections": false }`);
    assert.deepEqual(config.endpoints, ["/chat/completions", "/responses"]);
    assert.equal(config.serviceTier, "priority");
    assert.equal(config.logInjections, false);
    assert.deepEqual(config.models, []);
    assert.deepEqual(parseConfig("{}").endpoints, ["/responses", "/chat/completions"]);
});

test("matcher resolves providers and matches base URL prefix plus endpoint", () => {
    const matcher = new RelayFastMatcher(
        parseConfig(`{ "providers": ["relay-a"], "baseURLs": ["https://explicit.example.com/openai/v1/"] }`),
    );
    matcher.resolveProviders(OPENCODE_CONFIG.provider);

    assert.ok(matcher.matchesUrl("https://relay-a.example.com/v1/chat/completions"));
    assert.ok(matcher.matchesUrl("https://RELAY-A.example.com/v1/responses/"));
    assert.ok(matcher.matchesUrl("https://explicit.example.com/openai/v1/responses"));
    assert.equal(matcher.matchesUrl("https://relay-a.example.com/v1/models"), undefined);
    assert.equal(matcher.matchesUrl("https://relay-a.example.com/v2/responses"), undefined);
    assert.equal(matcher.matchesUrl("https://relay-b.example.com/v1/responses"), undefined);
    assert.equal(matcher.matchesUrl("not a url"), undefined);
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

test("injects only matching requests while enabled, and records state", async () => {
    const { hooks, requests, logs, toasts } = await loadPlugin();

    assert.match(await runFast(hooks, "on"), /Fast mode is ON/);
    assert.equal(toasts.at(-1).body.variant, "success");

    await post("https://relay-a.example.com/v1/responses", { model: "gpt-5.6-sol", input: "hi" });
    assert.equal(lastBody(requests).service_tier, "priority");

    await post("https://relay-a.example.com/v1/chat/completions", { model: "gpt-5.5", messages: [] });
    assert.equal(lastBody(requests).service_tier, "priority");

    await post("https://explicit.example.com/openai/v1/responses", { model: "gpt-5.6-luna", input: "x" });
    assert.equal(lastBody(requests).service_tier, "priority");

    // unsupported model
    await post("https://relay-a.example.com/v1/responses", { model: "gpt-5.4", input: "hi" });
    assert.equal(lastBody(requests).service_tier, undefined);

    // provider not listed
    await post("https://relay-b.example.com/v1/responses", { model: "gpt-5.6-sol", input: "hi" });
    assert.equal(lastBody(requests).service_tier, undefined);

    // wrong endpoint
    await post("https://relay-a.example.com/v1/embeddings", { model: "gpt-5.6-sol", input: "hi" });
    assert.equal(lastBody(requests).service_tier, undefined);

    // already set: body left untouched
    const original = JSON.stringify({ model: "gpt-5.5", input: "hi", service_tier: "priority" });
    await globalThis.fetch("https://relay-a.example.com/v1/responses", { method: "POST", body: original });
    assert.equal(requests.at(-1).init.body, original);

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

    globalThis.fetch = realFetch;
});

test("Uint8Array bodies are supported and Content-Length is dropped", async () => {
    const { hooks, requests } = await loadPlugin();
    await runFast(hooks, "on");

    const bytes = new TextEncoder().encode(JSON.stringify({ model: "gpt-5.5", input: "hi" }));
    await globalThis.fetch("https://relay-a.example.com/v1/responses", {
        method: "POST",
        body: bytes,
        headers: { "Content-Type": "application/json", "Content-Length": String(bytes.length) },
    });
    const sent = requests.at(-1).init;
    assert.equal(JSON.parse(sent.body).service_tier, "priority");
    assert.deepEqual(sent.headers, { "Content-Type": "application/json" });

    await globalThis.fetch("https://relay-a.example.com/v1/responses", {
        method: "POST",
        body: JSON.stringify({ model: "gpt-5.5" }),
        headers: new Headers({ "content-length": "10" }),
    });
    assert.equal(requests.at(-1).init.headers.get("content-length"), null);

    globalThis.fetch = realFetch;
});

test("off and toggle change state; non-POST and other commands are ignored", async () => {
    const { hooks, requests, toasts } = await loadPlugin();

    assert.match(await runFast(hooks, "off"), /Fast mode is OFF/);
    await post("https://relay-a.example.com/v1/responses", { model: "gpt-5.6-sol", input: "hi" });
    assert.equal(lastBody(requests).service_tier, undefined);

    assert.match(await runFast(hooks, ""), /Fast mode is ON/);
    assert.match(await runFast(hooks, "toggle"), /Fast mode is OFF/);
    assert.match(await runFast(hooks, "bogus"), /Usage: \/fast/);
    assert.equal(toasts.length, 4);

    await runFast(hooks, "on");
    await globalThis.fetch("https://relay-a.example.com/v1/responses", {
        method: "GET",
        body: JSON.stringify({ model: "gpt-5.5" }),
    });
    assert.equal(lastBody(requests).service_tier, undefined);

    const output = { parts: [{ type: "text", text: "unrelated" }] };
    await hooks["command.execute.before"]({ command: "other", sessionID: "s", arguments: "" }, output);
    assert.equal(output.parts[0].text, "unrelated");

    globalThis.fetch = realFetch;
});

test("config hook registers the /fast command and honours commandModel", async () => {
    const { opencodeConfig } = await loadPlugin();
    assert.equal(opencodeConfig.command.fast.template, "Manage relay Fast mode: $ARGUMENTS");
    assert.equal(opencodeConfig.command.fast.model, undefined);

    writeFileSync(configPath, `{ "providers": ["relay-a"], "commandModel": "relay-a/gpt-5.4-mini" }`);
    const again = await loadPlugin();
    assert.equal(again.opencodeConfig.command.fast.model, "relay-a/gpt-5.4-mini");

    globalThis.fetch = realFetch;
});

test("invalid config falls back to defaults and reports the error", async () => {
    writeFileSync(configPath, `{ "providers": [ `);
    const { hooks, logs } = await loadPlugin();
    const status = await runFast(hooks, "status");
    assert.match(status, /Config error/);
    assert.match(status, /Targets: none configured/);
    assert.ok(logs.some((entry) => entry.body.level === "warn" && /Failed to parse/.test(entry.body.message)));
    globalThis.fetch = realFetch;
});

test.after(() => {
    globalThis.fetch = realFetch;
    rmSync(configRoot, { recursive: true, force: true });
});
