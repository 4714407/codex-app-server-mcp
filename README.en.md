# Codex app-server MCP bridge

[中文文档](README.md) · [English usage guide](USAGE.en.md)

A secure, general-purpose MCP bridge that lets MCP-compatible clients such as Claude Code and Cursor asynchronously run, inspect, and control independent Codex app-server tasks.

`MCP client → MCP stdio → this bridge → Codex app-server → independent Codex thread`

The bridge does not attach to the current Codex desktop conversation. `codex_start` creates a thread unless a prior `threadId` is provided.

For setup examples and the full tool reference, see the [English usage guide](USAGE.en.md).

## Requirements

- Node.js 20 or newer
- Codex CLI installed and logged in with `codex login`
- Project dependencies installed with `npm install`

The bridge resolves `CODEX_EXECUTABLE` first, then searches `PATH` for `codex`. It uses `spawn(..., { shell: false })` and does not read, copy, print, or hard-code Tokens, API keys, or global Codex configuration.

Windows has been verified with Codex CLI 0.154.0. macOS and Linux use cross-platform Node APIs but have not yet been validated against a real Codex task.

## MCP tools

| Tool | Purpose |
| --- | --- |
| `codex_start` | Start a new task or resume a thread. |
| `codex_status` | Read task state and output; supports output cursors and long polling. |
| `codex_cancel` | Request interruption of a running task. |
| `codex_models` | List models available from the current app-server. |
| `codex_steer` | Add guidance to a running ordinary turn. |
| `codex_review` | Start native Codex code review for a thread. |
| `codex_compact` | Compact a long thread as an asynchronous task. |
| `codex_pending_input` / `codex_answer_input` | Inspect and answer a Codex clarification request. |
| `codex_doctor` | Inspect connection, executable, security, and local-index configuration. |

Only one task is active per bridge process. A second start request returns `busy` until the active task ends or is cancelled.

## Security model

- The default sandbox is `read-only`; network access is disabled.
- `workspace-write` requires `CODEX_ALLOWED_ROOTS`. The task `cwd` must be inside one listed root or the task is rejected.
- Command, file-change, and permission-approval requests are denied. Answering `codex_pending_input` cannot approve them.
- Remote `ws://` is allowed only for loopback or an SSH tunnel. Use `wss://` for a remote host and provide a bearer token through `CODEX_REMOTE_TOKEN_FILE` where possible.
- A dropped remote connection marks the task `unknown`; it is never automatically retried.

## Testing and distribution

```bash
npm test
npm run test:real
npm pack --dry-run
```

`npm test` uses mocks plus MCP integration checks. `test:real` needs a logged-in Codex CLI, network access, and available quota.

## Community and security

- See [CONTRIBUTING.md](CONTRIBUTING.md) before submitting a change.
- See [SECURITY.md](SECURITY.md) to privately report a vulnerability.
- See [CHANGELOG.md](CHANGELOG.md) for version history.

Licensed under [MIT](LICENSE), Copyright © 2026 4714407.
