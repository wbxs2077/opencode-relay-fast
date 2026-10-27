# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- `overwriteServiceTier` (default `true`, the previous behaviour). Set it to `false` to leave
  requests that already carry a `service_tier` unchanged.

### Fixed

- Re-initialising the plugin after another plugin had wrapped `fetch` made the two wrappers call
  each other forever, overflowing the stack on every request. The wrapper is now installed once.
- With several projects open, only the last initialised project's providers were targeted, and
  `/fast status` in earlier projects described a matcher that was no longer active. Every open
  project's providers are now targeted, and a provider URL that another open project uses for an
  unselected provider is skipped (fail closed).
- `serviceTier`, `commandModel`, `logInjections` and `overwriteServiceTier` with a wrong type now
  disable injection like other invalid fields, instead of silently falling back to defaults.
- The state file is no longer rewritten synchronously on every injected request; counters are
  written at most once a second, on every `/fast` command, and on exit.
- CI pins third-party actions to commit SHAs, uses read-only permissions and skips install scripts.

## [0.2.1] - 2026-09-04

Hardening release after an adversarial review. No configuration changes are required.

### Fixed

- `fetch(Request)` calls are now inspected and rewritten; previously only `(url, init)` calls were.
- `Content-Length` inherited from a `Request` input is dropped when the body is rewritten.
- Plugin re-initialisation (one instance per project directory) now shares a single fetch
  wrapper and switch, so `/fast off` in any instance stops injection everywhere.
- A wrongly typed config field such as `"models": "gpt-5.5"` no longer widens matching to every
  model. Malformed configuration now disables injection and is reported by `/fast status`.
- Request URLs are recorded as origin plus path only. Credentials, query strings and fragments
  never reach the state file, the log, or the `/fast` prompt.
- A selected provider that shares its base URL with an unselected provider is skipped with a
  warning instead of silently matching both. List both providers or use `baseURLs` to opt in.
- The JSONC stripper no longer removes `,}` or `,]` sequences that appear inside strings.

## [0.2.0] - 2026-09-04

First release as `opencode-relay-fast`, generalised from
[Tarquinen/opencodex-fast](https://github.com/Tarquinen/opencodex-fast).

### Added

- Target relay providers by OpenCode provider ID; base URLs are resolved from OpenCode's config.
- Explicit `baseURLs`, configurable `endpoints`, model globs and `serviceTier` value.
- Separate user config (`opencode-relay-fast.jsonc`) and runtime state
  (`opencode-relay-fast.state.json`).
- `/fast on|off|toggle|status` with a TUI toast, injection counter and resolved-target report.
- Optional `commandModel` to run the `/fast` echo request on a cheap model.
- Test suite, GitHub Actions CI, MIT license, English and Chinese README.

### Changed

- `/fast` no longer aborts the command with a thrown error; it rewrites the prompt instead.
