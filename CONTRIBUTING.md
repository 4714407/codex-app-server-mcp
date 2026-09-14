# 贡献指南

感谢贡献。提交前请先阅读 [README.md](README.md) 中的权限与兼容性说明。

## 开发环境

- Node.js 20 或更高版本；
- 运行 `npm install`；
- 提交前运行 `npm test`。

真实 Codex 测试还需要有效登录、网络和可用额度；它们不应作为普通贡献的前置条件。

## 提交变更

1. 保持改动聚焦，并为行为变更补充或更新测试。
2. 不要提交 `.env`、Token、API Key、用户目录、真实项目文件或未脱敏日志。
3. 涉及 app-server JSON-RPC 方法、事件或字段时，说明已验证的 Codex CLI 版本，并保持对不兼容协议的明确失败行为。
4. 涉及 `workspace-write`、远程连接、任务持久化或审批处理时，优先维持最小权限与默认拒绝策略。
5. 更新 README、USAGE 或 CHANGELOG 中受影响的部分。

## Pull Request

请在 PR 描述中说明：问题、解决方式、测试命令与结果，以及任何兼容性或安全影响。若变更包含破坏性配置调整，请在 CHANGELOG 中标记。
