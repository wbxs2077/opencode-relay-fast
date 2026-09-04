# opencode-relay-fast

[中文文档](./README.zh-CN.md)

An [OpenCode](https://opencode.ai) plugin that turns on OpenAI **priority processing**
(`"service_tier": "priority"`, what Codex calls *Fast mode*) for the third-party relay /
gateway providers you choose, behind a single `/fast` command.

It was written for [sub2api](https://github.com/Wei-Shaw/sub2api)-style relays that expose an
OpenAI-compatible `/v1` endpoint, but it works with any provider whose upstream honours
`service_tier`.

## Why

OpenCode has no per-provider switch for `service_tier`. The upstream
[opencodex-fast](https://github.com/Tarquinen/opencodex-fast) plugin injects it, but only for
the official `chatgpt.com/backend-api/codex` endpoint. If you reach OpenAI models through a
relay, nothing sends the priority hint. This plugin closes that gap without you editing
`opencode.json` every time you want to switch tiers.

## How it works

1. You list the OpenCode **provider IDs** that should get Fast mode. The plugin reads their
   `options.baseURL` from OpenCode's own config, so URLs are never duplicated.
2. `globalThis.fetch` is wrapped once. A request is rewritten only when **all** of these hold:
   - Fast mode is ON (`/fast on`),
   - the URL is `<baseURL>/responses` or `<baseURL>/chat/completions` (configurable),
   - the method is POST and the JSON body has a `model` matching your model globs,
   - `service_tier` is not already set to the target value.
3. Every injection bumps a counter and writes a log line, so you can prove it happened.

Everything else, including other providers, other endpoints, and non-JSON bodies, passes through
untouched.

## Install

### From npm

```jsonc
// ~/.config/opencode/opencode.jsonc
{
  "plugin": ["opencode-relay-fast"]
}
```

### From source (local plugin)

```bash
git clone https://github.com/wbxs2077/opencode-relay-fast.git
cd opencode-relay-fast
npm install
npm test          # builds dist/ and runs the test suite
```

Then create a one-line loader in OpenCode's global plugin directory
(`~/.config/opencode/plugins/`, or `%USERPROFILE%\.config\opencode\plugins\` on Windows):

```js
// ~/.config/opencode/plugins/opencode-relay-fast.js
export { default } from "file:///absolute/path/to/opencode-relay-fast/dist/index.js";
```

Restart OpenCode after installing.

## Configure

Copy [`examples/opencode-relay-fast.jsonc`](./examples/opencode-relay-fast.jsonc) to
`~/.config/opencode/opencode-relay-fast.jsonc` and edit it. Comments and trailing commas are
allowed.

```jsonc
{
  // Provider IDs from opencode.json; their options.baseURL is resolved automatically
  "providers": ["my-relay"],

  // Optional explicit base URLs (include any /v1 prefix)
  "baseURLs": [],

  // Endpoints relative to the base URL. Defaults shown.
  "endpoints": ["/responses", "/chat/completions"],

  // Model ID globs. Empty = every model.
  "models": ["gpt-5.5", "gpt-5.6-*"],

  // "auto" | "default" | "flex" | "priority"
  "serviceTier": "priority",

  // Optional: run the /fast command itself on a cheap model
  // "commandModel": "my-relay/gpt-5.4-mini",

  "logInjections": true
}
```

A matching provider in `opencode.json` looks like this:

```jsonc
{
  "provider": {
    "my-relay": {
      "api": "openai",
      "options": { "baseURL": "https://relay.example.com/v1", "apiKey": "sk-..." },
      "models": { "gpt-5.6-sol": {}, "gpt-5.5": {} }
    }
  }
}
```

Paths can be overridden with `OPENCODE_RELAY_FAST_CONFIG` and `OPENCODE_RELAY_FAST_STATE`.

### Safety rules (fail closed)

Priority processing costs money, so the plugin refuses to guess:

- **Invalid config disables injection.** A malformed file or a wrongly typed field (for example
  `"models": "gpt-5.5"` instead of an array) is reported in `/fast status` and the log, and
  nothing is injected until it is fixed.
- **Providers that share a base URL are skipped.** Requests are matched by URL, so if a selected
  provider has the same `baseURL` as an unselected one, the plugin cannot tell them apart. It
  skips that provider and says so in `/fast status`. Either list both providers or add the URL
  to `baseURLs` to opt in to URL-wide matching.
- **Only origin and path are recorded.** Credentials, query strings and fragments in request
  URLs never reach the state file, the log, or the `/fast` prompt.
- **One wrapper per process.** OpenCode may initialise plugins once per project directory; all
  instances share one switch, so `/fast off` anywhere stops injection everywhere.

## Use

```text
/fast            Toggle Fast mode
/fast on         Enable
/fast off        Disable
/fast status     Show state, injection count, resolved targets, model filter
```

The state (`enabled`, counters, last injection) is persisted in
`~/.config/opencode/opencode-relay-fast.state.json` and survives restarts.

### The `/fast` command costs one tiny model call

OpenCode's `command.execute.before` hook cannot cancel a command yet. The plugin therefore
shows a TUI toast and replaces the prompt with a one-line "echo this status" request. Set
`commandModel` to route that request to the cheapest model your relay offers.

## Verify it is doing something

1. `/fast on`
2. Send a normal message using a matching provider and model.
3. `/fast status` should show `Injected requests` increased.
4. `~/.local/share/opencode/log/*.log` contains `Injected service tier` entries with the model
   and URL.

Injection only proves that OpenCode sent the hint. Whether the relay forwards it, and whether
the upstream honours it, is up to them. Measure latency before and after if you need certainty,
and remember priority processing is billed at a higher rate by OpenAI.

## Development

```bash
npm test      # tsc build + node --test
npm run dev   # opencode plugin dev
```

The matcher (`RelayFastMatcher`), the JSONC stripper, `parseConfig` and the
`installFetchWrapper` / `uninstallFetchWrapper` pair are exported for tests and for reuse in
other plugins.

## Credits

Derived from [Tarquinen/opencodex-fast](https://github.com/Tarquinen/opencodex-fast), which
targets the official Codex backend. This project generalises the idea to arbitrary relays.

## License

[MIT](./LICENSE)
