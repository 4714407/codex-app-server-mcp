# Codex app-server MCP usage guide

[中文使用指南](USAGE.md) · [English README](README.en.md)

`$mcpDir` below means the directory containing this project's `server.mjs`. Set it to your own installation directory; do not copy the placeholder literally.

## 1. Install and log in

```powershell
$mcpDir = '<directory containing codex-app-server-mcp>'
Set-Location $mcpDir
npm.cmd install
codex --version
codex login
```

If `codex` is not on `PATH`, configure its absolute path with `CODEX_EXECUTABLE` in the MCP client's environment.

## 2. Register with Claude Code

Register the stdio server for the current Claude Code user:

```powershell
$mcpDir = '<directory containing codex-app-server-mcp>'
$nodeExe = (Get-Command node.exe).Source
claude mcp add --transport stdio --scope user codex-agent -- $nodeExe (Join-Path $mcpDir 'server.mjs')
claude mcp get codex-agent
```

Remove it with:

```powershell
claude mcp remove codex-agent --scope user
```

Other MCP clients can launch the same stdio command. Keep the service configuration in the client's `command`, `args`, and `env`; do not manually start a separate bridge process in normal use.

## 3. Basic workflow

1. Call `codex_start` with a non-empty `prompt` and an absolute `cwd`.
2. Save the returned `jobId` and `threadId`.
3. Call `codex_status` until the task reaches a terminal state.
4. Use `codex_cancel` when the task is no longer needed.

Example request:

```json
{
  "prompt": "Review uncommitted changes and report only high-risk issues.",
  "cwd": "D:\\projects\\my-app"
}
```

Use the returned `threadId` together with exactly the same `cwd` to continue a conversation:

```json
{
  "prompt": "Propose the smallest fix for the issue you found.",
  "cwd": "D:\\projects\\my-app",
  "threadId": "previous threadId"
}
```

`codex_status` returns the complete response by default. Pass the preceding `outputCursor` as `cursor` to receive only new output. Set `waitMs` to long-poll for up to 30 seconds.

## 4. Configure permissions

The default is read-only. To permit edits, configure both the sandbox and a writable-root allowlist in the MCP client's environment:

```json
{
  "env": {
    "CODEX_SANDBOX_MODE": "workspace-write",
    "CODEX_ALLOWED_ROOTS": "D:\\projects\\my-app;D:\\projects\\another-app"
  }
}
```

`CODEX_ALLOWED_ROOTS` can also be a JSON string array. `workspace-write` without it fails closed. The allowlist is a startup setting: restart the MCP connection after changing it. It does not grant network access or access outside the task `cwd` and Codex's standard temporary locations.

## 5. Models, reviews, and long tasks

- Use `codex_models` to discover live model IDs, then pass a selected ID as `model` to `codex_start`. The order is per-call `model`, then `CODEX_MODEL`, then Codex defaults.
- Use `codex_steer` with an active `jobId` to add an instruction to an ordinary turn.
- Use `codex_review` with an existing `threadId` and a target of `uncommittedChanges`, `baseBranch`, `commit`, or `custom`.
- Use `codex_compact` to compact an existing long thread; it returns a `jobId` that can be tracked with `codex_status`.

When Codex requests clarification, status becomes `waiting_for_input`. Retrieve the question with `codex_pending_input`, then submit the supplied `inputId` and answer object through `codex_answer_input`. This never approves shell commands, file changes, or permission requests.

## 6. Local task index and diagnostics

Task records are in memory by default. To retain non-sensitive task metadata across a restart, configure a protected local file:

```powershell
$env:CODEX_STATE_PATH = 'C:\secure-state\codex-app-server-mcp-jobs.json'
```

The index stores IDs, status, mode, sandbox, working directory, and error metadata; it does not store prompts, replies, credentials, or pending answers. A task that was active when the bridge stopped is restored as `unknown` and is never retried automatically. Its `threadId` can be resumed manually.

Use `codex_doctor` to inspect mode, executable resolution, sandbox, allowed roots, state path, and current connection state.

## 7. Remote app-server

Set `CODEX_APP_SERVER_URL` to use an existing remote app-server rather than spawning a local child process:

```json
{
  "env": {
    "CODEX_APP_SERVER_URL": "wss://codex.example.internal/app-server",
    "CODEX_REMOTE_TOKEN_FILE": "C:\\secure\\codex-app-server.token"
  }
}
```

Use `wss://` for a cross-machine endpoint. `ws://` is accepted only for `localhost`, `127.0.0.1`, `::1`, or an SSH tunnel. Never place credentials in the URL. In remote mode, `cwd` refers to the remote execution environment and is validated there.

## 8. Troubleshooting

**Codex executable not found** — install Codex, ensure `codex --version` works, or set `CODEX_EXECUTABLE`.

**Task fails during initialization** — run `codex login` in a normal terminal, then reconnect the MCP service. For remote mode, also check the endpoint, TLS, and token-file permissions.

**Writes are rejected** — configure both `CODEX_SANDBOX_MODE=workspace-write` and `CODEX_ALLOWED_ROOTS`, then ensure `cwd` is inside an allowed root.

**Thread cwd mismatch** — resuming a `threadId` requires exactly the original `cwd`.

**Output is truncated** — the bridge retains at most 256 KiB per task. Split the task or request a more concise result.
