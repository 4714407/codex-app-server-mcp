# Codex app-server MCP 使用指南

[English version](USAGE.en.md)

本 MCP 将 Claude Code 和独立的 Codex app-server 会话连接起来：Claude 通过 MCP 工具发起任务、查看结果或取消任务，Codex 在指定的工作目录中执行。

> 它不会接管当前 Codex 桌面端会话。每次 `codex_start` 会新建独立会话，或通过 `threadId` 恢复此前由此 MCP 创建/使用的会话。

下文以 `$mcpDir` 表示 **`codex-app-server-mcp` 所在目录**（也就是包含 `server.mjs` 的目录）。请先按自己的实际安装位置设置它，不要照抄示例中的占位值。

## 1. 前置条件

- Node.js 20 或更高版本；
- 已安装并登录 Codex CLI：`codex login`；
- 已在本仓库安装依赖：`npm.cmd install`（Windows）或 `npm install`（macOS/Linux）。

在 Windows PowerShell 中可先验证：

```powershell
$mcpDir = '<codex-app-server-mcp 所在目录>'
Set-Location $mcpDir
node --version
codex --version
codex login
npm.cmd install
```

如果 `codex` 不在 `PATH`，后续配置中请设置 `CODEX_EXECUTABLE` 为 `codex.exe` 的绝对路径。

## 2. 在 Claude Code 中注册

以下命令把 MCP 注册到当前用户的 Claude Code。请把路径替换为实际仓库位置：

```powershell
$mcpDir = '<codex-app-server-mcp 所在目录>'
$nodeExe = (Get-Command node.exe).Source
claude mcp add --transport stdio --scope user codex-agent -- $nodeExe (Join-Path $mcpDir 'server.mjs')
claude mcp get codex-agent
```

重启 Claude Code 或重新连接 MCP 后即可使用。卸载时执行：

```powershell
claude mcp remove codex-agent --scope user
```

### 项目级配置（可选）

如果希望配置只对单个项目生效，可在该项目的 `.mcp.json` 中声明服务。以下为本地、默认只读的最小配置：

```json
{
  "mcpServers": {
    "codex-agent": {
      "command": "node",
      "args": ["<codex-app-server-mcp 所在目录>/server.mjs"]
    }
  }
}
```

Windows 上若 `node` 不在 Claude Code 的 `PATH`，把 `command` 改为 `node.exe` 的绝对路径。

## 3. 最常用的工作流

1. 告诉 Claude 要交给 Codex 的任务，以及目标工作目录。
2. Claude 调用 `codex_start`，立即取得 `jobId`。
3. Claude 用 `codex_status` 轮询任务，直到状态进入终态。
4. 如不再需要任务，调用 `codex_cancel`；只有最终状态为 `cancelled` 才表示已经取消。

可以直接这样对 Claude 说：

```text
通过 codex-agent 审查 D:\projects\my-app 的未提交改动，
只报告高风险问题，不要修改任何文件。
```

或让它完成一个可写任务（前提是按下一节启用了写入）：

```text
通过 codex-agent 在 D:\projects\my-app 修复登录页的 TypeScript 类型错误，
运行相关测试，并总结修改内容。
```

对应的 MCP 调用形态如下：

```json
// 1) 启动
{
  "prompt": "审查未提交改动，只报告高风险问题。",
  "cwd": "D:\\projects\\my-app"
}

// 2) 查询
{ "jobId": "codex_start 返回的 jobId" }
```

本地模式下，`cwd` 必须是存在的绝对目录。同一个 MCP 进程一次只运行一个任务；收到 `busy` 时，等待当前任务结束或取消后再试。

## 4. 工具说明

| 工具 | 用途 | 关键参数 |
| --- | --- | --- |
| `codex_start` | 新建或恢复 Codex 会话并启动任务 | `prompt`、`cwd`；可选 `threadId`、`model` |
| `codex_status` | 获取任务状态、进度与已收到的回复 | `jobId`；可选 `cursor`、`waitMs` |
| `codex_cancel` | 请求中断运行中的任务 | `jobId` |
| `codex_models` | 从当前 app-server 获取可用模型 | 可选 `cursor`、`limit` |
| `codex_steer` | 向运行中的普通任务补充指令 | `jobId`、`prompt` |
| `codex_review` | 对已有会话启动原生代码审查 | `threadId`、`target`；可选 `delivery` |
| `codex_compact` | 压缩已有会话的上下文 | `threadId` |
| `codex_pending_input` / `codex_answer_input` | 读取并回答 Codex 提出的问题 | `jobId`；或 `inputId`、`answers` |
| `codex_doctor` | 检查连接、安全配置与本地任务索引 | 无 |

`codex_start` 的结果会包含 `jobId`、`threadId`、`turnId` 与当前状态。状态可能是 `starting`、`running`、`completed`、`failed`、`cancelled`；远程连接在任务中断开时还可能为 `unknown`。完整回复位于 `codex_status` 的 `assistantReply` 字段。

为了避免轮询时重复读取整段文本，把上次的 `outputCursor` 作为下一次的 `cursor`；此时 `assistantReply` 仅包含新增文本。`waitMs` 可让查询最多等待 30 秒，直到有新输出或任务结束。

若要让后续任务沿用会话上下文，保存首次结果中的 `threadId`，并在下一次启动时同时传入相同的 `cwd`：

```json
{
  "prompt": "根据刚才的审查，给出最小修复方案。",
  "cwd": "D:\\projects\\my-app",
  "threadId": "此前返回的 threadId"
}
```

## 5. 写入权限与安全边界

默认模式为 `read-only`：Codex 能分析文件但不能修改文件，且网络访问关闭。

确实需要让 Codex 编辑文件时，在 MCP 的启动环境中显式设置：

```json
{
  "env": {
    "CODEX_SANDBOX_MODE": "workspace-write",
    "CODEX_ALLOWED_ROOTS": "D:\\projects\\my-app;D:\\projects\\another-app"
  }
}
```

也可手动启动时设置：

```powershell
$env:CODEX_SANDBOX_MODE = 'workspace-write'
$env:CODEX_ALLOWED_ROOTS = 'D:\projects\my-app;D:\projects\another-app'
node (Join-Path $mcpDir 'server.mjs')
```

`workspace-write` 必须同时设置 `CODEX_ALLOWED_ROOTS`，否则任务会拒绝启动。它是以分号分隔的目录列表，也可写成 JSON 字符串数组；任务的 `cwd` 必须位于其中某个目录内。`workspace-write` 只允许写入本次 `cwd` 工作区以及 Codex 标准沙箱允许的临时目录；它不会开启网络，也不能通过提示词或工具参数提升为更高权限。该选项是启动配置，改动后需要重启 MCP。

## 6. 长任务、提问与会话控制

任务运行时可调用 `codex_steer` 补充方向，例如“优先检查失败的测试”。它只能作用于正在运行的普通 turn，不能修改沙箱或审批策略。

若 Codex 主动请求业务澄清，任务状态会变为 `waiting_for_input`。先用 `codex_pending_input` 获取 `inputId` 和问题，再用 `codex_answer_input` 提交答案。该机制不能批准命令、文件变更或权限请求；此类请求仍会被拒绝。

`codex_review` 使用 app-server 的原生审查能力，支持 `uncommittedChanges`、`baseBranch`、`commit` 和 `custom` 目标。`codex_compact` 会为长会话创建异步压缩任务；两者均返回可通过 `codex_status` 查询的 `jobId`。

## 7. 任务索引与诊断

默认不把任务元数据写入磁盘。若希望在 MCP 重启后仍能找回已结束任务的 `jobId`、`threadId`、状态和工作目录，设置 `CODEX_STATE_PATH` 指向受限权限的本地 JSON 文件：

```powershell
$env:CODEX_STATE_PATH = 'C:\secure-state\codex-app-server-mcp-jobs.json'
node (Join-Path $mcpDir 'server.mjs')
```

索引不保存 prompt、助手回复、Token、环境变量或待回答的问题；重启后保留的仅是已结束任务元数据。使用 `codex_doctor` 可查看当前本地/远程模式、Codex 可执行文件、沙箱、目录白名单、索引路径和连接状态。

## 8. 选择模型

先调用 `codex_models` 查看当前账号可用的模型 ID，再在任务中指定：

```json
{
  "prompt": "审查这个项目的认证实现。",
  "cwd": "D:\\projects\\my-app",
  "model": "实际可用的模型 ID"
}
```

也可以为整个 MCP 实例设置默认模型：

```json
{
  "env": {
    "CODEX_MODEL": "实际可用的模型 ID"
  }
}
```

优先级为：本次 `model` 参数 > `CODEX_MODEL` > Codex 默认配置。

## 9. 连接远程 app-server（可选）

默认的本地模式会自行运行 `codex app-server`。若已有远程 app-server，可设置 `CODEX_APP_SERVER_URL`，此时 MCP 不会启动或停止远程 Codex 进程。

```powershell
$env:CODEX_APP_SERVER_URL = 'wss://codex.example.internal/app-server'
$env:CODEX_REMOTE_TOKEN_FILE = 'C:\secure\codex-app-server.token'
node (Join-Path $mcpDir 'server.mjs')
```

- 跨机器连接必须使用 `wss://`；`ws://` 仅允许 `localhost`、`127.0.0.1` 或 SSH 隧道；
- Token 可通过 `CODEX_REMOTE_TOKEN_FILE`（推荐）或 `CODEX_REMOTE_BEARER_TOKEN` 提供；不要把 Token 放进 URL；
- 远程模式的 `cwd` 是远程执行环境中的绝对路径，MCP 不会在本机校验该目录；
- 远程连接中断后任务会标记为 `unknown`，不会自动重试，以免重复执行。

## 10. 常见问题

**提示找不到 Codex 可执行文件**

确认 `codex --version` 可用，或设置 `CODEX_EXECUTABLE`：

```powershell
$env:CODEX_EXECUTABLE = 'C:\Program Files\OpenAI\Codex\bin\codex.exe'
```

**任务启动后失败或初始化超时**

先在普通终端执行 `codex login`，确认登录完成；再检查 Codex CLI 是否可运行。远程模式还应检查 URL、TLS 证书与 Token 文件权限。

**需要写文件却没有生效**

确认 MCP 是以 `CODEX_SANDBOX_MODE=workspace-write` 和 `CODEX_ALLOWED_ROOTS` 启动，并重启 Claude Code/MCP；同时确认目标文件位于本次传入的 `cwd` 内，且 `cwd` 位于目录白名单内。

**恢复会话时报 cwd 不兼容**

恢复 `threadId` 时必须传入与该会话首次启动时完全相同的 `cwd`。

**输出不完整**

单个任务的已缓存回复最多 256 KiB，超过时 `outputTruncated` 为 `true`。请要求 Codex 输出更精炼的结论，或将任务拆分。

## 11. 快速自检

在仓库根目录运行：

```powershell
npm.cmd test
```

这会运行桥接协议与 MCP 工具的自动化测试。需要真实调用 Codex 时，另行运行 `npm.cmd run test:real`；它需要有效登录、网络和可用额度。
