# Codex app-server MCP 桥接

> 想直接接入并开始使用？请先看 [使用指南](USAGE.md)。

[English documentation](README.en.md)

安全问题请阅读 [安全策略](SECURITY.md) 并私下报告；参与贡献前请阅读 [贡献指南](CONTRIBUTING.md)。版本变更记录见 [CHANGELOG.md](CHANGELOG.md)。

本项目让 Claude Code 通过本地 stdio MCP 调用独立的 Codex app-server 会话，默认适用于提问、代码分析和只读审查；用户显式启用 workspace-write 后，也可在任务工作区内修改代码。它不会连接或继承当前 Codex 桌面聊天上下文；没有 `threadId` 时创建新会话，提供 `threadId` 时恢复该会话。

`Claude Code → MCP stdio → 本桥接程序 → Codex app-server stdio → 独立 Codex thread`

## 兼容性、安装与登录

最低 Node.js 版本为 20。已在 Windows 上核实 Node.js `v24.14.1`、npm `11.11.0`、Codex CLI `0.154.0`，并以该 Codex 版本生成协议定义核对字段。实现使用 Node.js 的跨平台 `spawn(..., { shell: false })`；macOS 和 Linux 尚未实际验证，不对此作出已验证声明。

```powershell
$mcpDir = '<codex-app-server-mcp 所在目录>'
Set-Location $mcpDir
npm.cmd install
codex --version
codex login
node .\server.mjs
```

桥接优先使用 `CODEX_EXECUTABLE`；未设置时从 `PATH` 查找 `codex`（Windows 也查找 `.exe`、`.cmd` 和 `.bat`）。找不到时工具返回明确配置说明。桥接不会读取、复制、打印或硬编码令牌、API Key 或 Codex 全局配置。

Windows PowerShell：

```powershell
$env:CODEX_EXECUTABLE = 'C:\Program Files\OpenAI\Codex\bin\codex.exe'
node D:\path\to\codex-app-server-mcp\server.mjs
```

macOS / Linux：

```bash
export CODEX_EXECUTABLE="$(command -v codex)" # 可省略，让程序从 PATH 查找
node /path/to/codex-app-server-mcp/server.mjs
```

未登录时，请在普通终端执行 `codex login` 后重启桥接。若本机 Codex 协议不兼容，初始化或对应 JSON-RPC 请求会以方法名和服务端错误明确失败，不会静默降级。

## MCP 工具

`codex_start({ prompt, cwd, threadId?, model? })` 按启动时的沙箱配置启动任务。`prompt` 必须非空；`cwd` 必须是存在的绝对目录。它立即返回 `jobId`、`threadId` 和已获得时的 `turnId`。同一桥接进程只允许一个活动任务，第二个调用会收到 `busy`；恢复既有 thread 时 cwd 必须与该 thread 初始 cwd 相同。

`codex_status({ jobId, cursor?, waitMs? })` 返回任务状态 `starting`、`running`、`waiting_for_input`、`completed`、`failed` 或 `cancelled`，以及已收到的助手回复、错误、进度和关联 ID。传入上次结果的 `outputCursor` 作为 `cursor` 时，`assistantReply` 只包含增量；`waitMs` 支持最多 30 秒的长轮询。启动结果和状态均包含 `sandboxMode`，工具描述也显示当前模式。最多保留 100 个任务，每项回复最多 256 KiB，截断会标为 `outputTruncated: true`。

`codex_cancel({ jobId })` 使用 app-server `turn/interrupt` 请求中断。返回 `requested` 仅表示已发出请求；只有收到匹配 `turn/completed` 的 `interrupted` 才确认 `cancelled`。重复取消和已结束任务有稳定结果。

```text
codex_start({"prompt":"只回复 CODEX_OK，不读取或修改任何文件。","cwd":"D:\\project"})
codex_status({"jobId":"..."})
codex_cancel({"jobId":"..."})
```

`codex_models({ cursor?, limit? })` 从当前 Codex app-server 实时读取可用模型。返回模型 ID、显示名称、描述、默认推理强度、支持的推理强度、可用性提示以及 `nextCursor`；Claude 可先调用此工具展示列表，再将用户选中的 `model` 传给下一次 `codex_start`。

`codex_steer({ jobId, prompt })` 可向运行中的普通 turn 补充指令；`codex_review({ threadId, target, delivery? })` 启动原生审查；`codex_compact({ threadId })` 异步压缩长会话。Codex 需要澄清时，使用 `codex_pending_input({ jobId })` 取得问题与 `inputId`，再由 `codex_answer_input({ inputId, answers })` 明确回答；该流程不能批准命令或文件变更。`codex_doctor()` 显示连接、可执行文件、沙箱、目录白名单和可选任务索引配置。

设置 `CODEX_STATE_PATH` 后，桥接将以原子写入的本地 JSON 索引保留不含 prompt/回复/凭据的任务元数据；重启时已运行任务标为 `unknown`，不会自动重试，可使用保存的 `threadId` 手动恢复。

## 权限、超时和关闭

未设置 `CODEX_SANDBOX_MODE` 时使用 `read-only`。用户可显式设置为 `workspace-write`，其他值（包括空字符串和拼写错误）会导致启动失败。可写模式必须同时设置 `CODEX_ALLOWED_ROOTS`（分号分隔的目录列表或 JSON 字符串数组），任务 `cwd` 必须位于白名单内；未设置白名单时可写任务会拒绝启动。新建与恢复 thread 都明确设定当前沙箱和 `approvalPolicy: "never"`；每个 turn 再指定相应策略：只读为 `{ type: "readOnly", networkAccess: false }`；可写为 `{ type: "workspaceWrite", writableRoots: [cwd], networkAccess: false }`。`never` 代表不发起交互审批，不代表自动批准。服务端提出的命令、文件改动和权限审批一律拒绝；用户输入会进入等待状态，须通过 `codex_pending_input` 和 `codex_answer_input` 明确回答，未知服务端请求收到 JSON-RPC `-32601`，不会悬挂。工作区内写入在 workspace-write 下由沙箱直接允许，无需自动批准请求；超出沙箱的请求仍被拒绝。工具不接受改变沙箱或审批策略的参数，也不会使用危险绕过选项。

初始化超时为 20 秒，普通 RPC 超时为 30 秒。Codex 子进程退出、初始化失败或 JSON-RPC 失败会让活动任务失败，绝不误报成功。stdin 关闭、SIGINT 或 SIGTERM 时只关闭本桥接启动的 app-server，并清理计时器和待处理请求。

## 注册 Claude Code

已按当前 Claude Code 文档核对：stdio 选项和 `--scope` 必须放在服务名前，`--` 后才是启动命令。请自行执行：

```powershell
$mcpDir = '<codex-app-server-mcp 所在目录>'
$nodeExe = (Get-Command node.exe).Source
claude mcp add --transport stdio --scope user codex-agent -- "$nodeExe" (Join-Path $mcpDir 'server.mjs')
claude mcp get codex-agent
```

卸载命令：

```powershell
claude mcp remove codex-agent --scope user
```

## 测试与分发

```powershell
npm.cmd test
npm.cmd run test:real
npm.cmd pack --dry-run
npm.cmd pack
```

`npm test` 运行 JSONL 分块、启动响应前事件、忙状态、取消确认、子进程退出，以及使用官方 MCP 客户端 SDK 从外部进程启动服务的初始化、`tools/list`、不存在 cwd、未知 job 检查。`test:real` 额外验证真实 Codex 简短答复与 `threadId` 上下文恢复；它需要网络、有效登录和可用额度。测试只使用项目内 `test-tmp`，不会访问业务项目。模拟不会替代真实端到端成功。

npm 的 `files` 白名单仅包含运行必需的 `server.mjs`、`lib/`、README 和 LICENSE，排除测试、测试临时目录、日志、凭据、本地配置和会话数据。`npm pack` 仅在本地生成 tarball，不会发布到 npm。

## 两种 Codex 连接模式

MCP 服务应由 Claude Code、Cursor 等 MCP 客户端按其 `command`、`args` 和 `env` 配置自动启动；无需手动运行桥接进程或使用平台专属启动脚本。首次仍需在项目目录执行一次 `npm.cmd install`（或 `npm install`）。

两种模式向 Claude Code 暴露相同的 `codex_start`、`codex_status`、`codex_cancel`、`codex_models`、`codex_steer`、`codex_review`、`codex_compact`、`codex_pending_input`、`codex_answer_input` 和 `codex_doctor` 工具。每次启动只选择一种模式：设置 `CODEX_APP_SERVER_URL` 即为远程模式；未设置时为本地模式。

### 本地模式

本地模式由桥接程序以 `spawn(codex, ['app-server', '--listen', 'stdio://'])` 启动并管理子进程。`cwd` 是桥接机器上的存在目录，必须是绝对路径。桥接关闭时只停止它自己启动的 app-server。

Windows PowerShell：

```powershell
Remove-Item Env:CODEX_APP_SERVER_URL -ErrorAction Ignore
$env:CODEX_EXECUTABLE = 'C:\Program Files\OpenAI\Codex\bin\codex.exe' # 或让程序从 PATH 查找
node D:\path\to\codex-app-server-mcp\server.mjs
```

macOS / Linux：

```bash
unset CODEX_APP_SERVER_URL
export CODEX_EXECUTABLE="$(command -v codex)" # 可省略
node /path/to/codex-app-server-mcp/server.mjs
```

### 远程模式

远程模式不会启动、重启或终止任何 Codex 进程；它只连接既有 app-server。`cwd` 是远程 Codex 执行环境中的绝对路径，桥接不会在本机检查它是否存在，远程 app-server 会验证它。

配置 `CODEX_APP_SERVER_URL`。跨机器连接必须使用 `wss://`；`ws://` 仅接受 `localhost`、`127.0.0.1` 或 `::1`，用于同机服务或 SSH 隧道。URL 不得内嵌用户名、密码或 Token。

Bearer Token 可任选其一提供：`CODEX_REMOTE_BEARER_TOKEN`，或 `CODEX_REMOTE_TOKEN_FILE` 指向只含 Token 的秘密文件。Token 只用于 WebSocket 握手的 `Authorization: Bearer …` 请求头，不会写入日志、任务状态或 README 示例。优先使用秘密文件。

Windows PowerShell（TLS 反向代理后的远程服务）：

```powershell
$env:CODEX_APP_SERVER_URL = 'wss://codex.example.internal/app-server'
$env:CODEX_REMOTE_TOKEN_FILE = 'C:\secure\codex-app-server.token'
Remove-Item Env:CODEX_EXECUTABLE -ErrorAction Ignore
node D:\path\to\codex-app-server-mcp\server.mjs
```

macOS / Linux（TLS 反向代理后的远程服务）：

```bash
export CODEX_APP_SERVER_URL='wss://codex.example.internal/app-server'
export CODEX_REMOTE_TOKEN_FILE="$HOME/.config/codex-app-server.token"
node /path/to/codex-app-server-mcp/server.mjs
```

使用 SSH 隧道时，远程主机上的 app-server 应仅监听 loopback；在本机建立隧道后使用本地 `ws://`：

```bash
# 远程主机：使用其安全的 Token 文件启动 app-server
codex app-server --listen ws://127.0.0.1:4500 --ws-auth capability-token --ws-token-file /secure/codex-app-server.token
# 本机：保持隧道运行
ssh -N -L 4500:127.0.0.1:4500 user@codex-host
export CODEX_APP_SERVER_URL='ws://127.0.0.1:4500'
export CODEX_REMOTE_TOKEN_FILE="$HOME/.config/codex-app-server.token"
node /path/to/codex-app-server-mcp/server.mjs
```

远程 WebSocket 在任务运行时断开，任务会显示 `status: "unknown"` 与断线原因。桥接不会自动重连后重发该任务，避免重复执行；可以在确认远程状态后手动发起新任务。关闭桥接只关闭其 WebSocket 客户端连接，不会向远程 app-server 发送终止信号。

本地模式的真实 Codex 测试仍依赖本机登录和可访问的用户 Home。远程模式已使用本地受控 WebSocket 服务验证握手 Bearer 头、远程 cwd 透传和断线为 `unknown`；尚未针对外部真实远程 Codex 端点运行集成测试。

## 沙箱开关：默认只读，用户显式启用写入

在 Claude 项目的 .mcp.json 中，保留现有 codex-agent 的 command、args 和 env，在它的 env 对象中增加：

```json
"CODEX_SANDBOX_MODE": "workspace-write"
```

保存后重启该项目的 Claude / MCP 连接。恢复只读时改为 read-only；删除该键将回退到进程环境，环境也未设置时才使用只读默认值。

这是一项启动配置，不是 Claude 可以通过 prompt 或 codex_start 参数自行切换的权限。每个桥接实例启动后固定使用该模式，新建、恢复会话及每次任务均重新发送对应权限。支持本地和远程连接；远程的 cwd 与可写目录属于远程执行环境。

写入范围是任务 cwd 工作区及 Codex 标准沙箱允许的临时目录，受服务端和平台的额外限制约束。不会开启网络或全磁盘访问。当前 cwd 仍由调用方提供，因此请明确任务目录。配置为 workspace-write 并不保证外部依赖下载或工作区外的全局缓存写入成功。

若为调试而手动启动，可仅使用环境变量：

```powershell
$env:CODEX_SANDBOX_MODE = 'workspace-write'
$env:CODEX_ALLOWED_ROOTS = 'D:\projects\my-app'
node .\server.mjs
```

验证：npm.cmd test 包含默认值、非法配置、新建/恢复会话的双层权限、远程策略、审批拒绝和 MCP 工具描述检查。
真实沙箱文件测试使用独立临时目录（不修改业务仓库）：

```powershell
$env:CODEX_RUN_SANDBOX_REAL = '1'
npm.cmd run test:sandbox-real
```

真实测试依次检查默认只读不能创建文件、显式开启写入能创建文件，以及恢复可写会话到只读后不能再次创建文件。需有效 Codex 登录和可用网络；未执行真实测试不能视为沙箱执行验证通过。

## 指定模型

在项目 .mcp.json 的 codex-agent.env 中设置 CODEX_MODEL 为账号可用的模型 ID，保存后重启 Claude / MCP。示例（将占位符替换为实际模型 ID）：

```json
"CODEX_MODEL": "YOUR_MODEL_ID",
"CODEX_SANDBOX_MODE": "workspace-write"
```

未设置 CODEX_MODEL 时不传 model：新会话使用 Codex 默认配置，恢复会话遵循 Codex 对已有会话的默认行为。显式设置后，新建、恢复会话和每个 turn 均传入该模型。空值会报错；不自动替换账号不支持的模型，不修改 Codex 全局配置。该设置适用于本地和远程模式，也可通过启动环境传入。任务状态的 requestedModel 表示请求的模型 ID（未设置时为 null），不冒充服务端确认的实际模型。

### 通过话术切换模型

codex_start 现在接受可选 model 参数。对 Claude 说“通过 codex-agent，使用模型 <实际模型 ID> 审查当前项目”，Claude 应把模型 ID 传入 model，而不是仅写进 prompt。
优先级为：本次 model 参数 > CODEX_MODEL 启动配置 > Codex 默认。支持在下一次调用中沿用 threadId 并更换 model，兼容性和账号权限由服务端验证；不自动替换不支持的模型。运行中的任务不能中途切换，需等待结束或取消后再调用。未指定 model 且未配置 CODEX_MODEL 时，恢复已有会话遵循服务端已有模型设置。

注意：可通过话术选择模型，但不能通过话术改变沙箱权限；写入权限仍必须由用户配置 CODEX_SANDBOX_MODE。
