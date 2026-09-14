#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { CodexBridge } from './lib/codex-bridge.mjs';

const bridge = new CodexBridge();
const server = new McpServer({ name: 'codex-app-server-mcp', version: '1.0.0' });
const result = (value) => ({ content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] });
const failure = (error) => ({ content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }], isError: true });
server.registerTool('codex_start', { description: `在新的或已有 Codex thread 中启动任务，立即返回 jobId。可用 model 参数指定本次任务模型。配置模型：${bridge.model ?? 'Codex 默认配置 / 已有会话模型'}。当前沙箱：${bridge.sandboxMode}；${bridge.sandboxMode === 'workspace-write' ? '允许在任务工作区内修改文件' : '只读，禁止修改文件'}。权限由用户启动配置决定，工具参数不能更改。`, inputSchema: { prompt: z.string().min(1), cwd: z.string().min(1), threadId: z.string().min(1).optional(), model: z.string().trim().min(1).optional() } }, async (args) => { try { return result(await bridge.start(args)); } catch (e) { return failure(e); } });
server.registerTool('codex_status', { description: '查询 Codex 任务状态和已经收到的助手答复。传入 cursor 时只返回新增输出；waitMs 可长轮询最多 30 秒。', inputSchema: { jobId: z.string().min(1), cursor: z.number().int().min(0).optional(), waitMs: z.number().int().min(0).max(30000).optional() } }, async (args) => { try { return result(await bridge.status(args.jobId, args)); } catch (e) { return failure(e); } });
server.registerTool('codex_cancel', { description: '请求中断正在运行的 Codex 任务；终态以后才确认取消。', inputSchema: { jobId: z.string().min(1) } }, async ({ jobId }) => { try { return result(await bridge.cancel(jobId)); } catch (e) { return failure(e); } });
server.registerTool('codex_models', { description: '从当前 Codex app-server 实时读取可用模型列表。可使用 nextCursor 继续读取下一页。', inputSchema: { cursor: z.string().trim().min(1).optional(), limit: z.number().int().min(1).max(100).optional() } }, async (args) => { try { return result(await bridge.listModels(args)); } catch (e) { return failure(e); } });
server.registerTool('codex_steer', { description: '向当前运行中的普通 Codex turn 补充指令；不会改变沙箱或审批策略。', inputSchema: { jobId: z.string().min(1), prompt: z.string().min(1) } }, async (args) => { try { return result(await bridge.steer(args)); } catch (e) { return failure(e); } });
server.registerTool('codex_review', { description: '对已有 Codex thread 启动原生代码审查。仅接受明确的审查目标。', inputSchema: { threadId: z.string().min(1), delivery: z.enum(['inline', 'detached']).optional(), target: z.object({ type: z.enum(['uncommittedChanges', 'baseBranch', 'commit', 'custom']), branch: z.string().min(1).optional(), sha: z.string().min(1).optional(), title: z.string().min(1).optional(), instructions: z.string().min(1).optional() }) } }, async (args) => { try { return result(await bridge.review(args)); } catch (e) { return failure(e); } });
server.registerTool('codex_compact', { description: '压缩已有 Codex thread 的上下文，适用于长会话；作为一个异步任务返回 jobId。', inputSchema: { threadId: z.string().min(1) } }, async (args) => { try { return result(await bridge.compact(args)); } catch (e) { return failure(e); } });
server.registerTool('codex_pending_input', { description: '列出某个任务正在等待回答的 Codex 问题。', inputSchema: { jobId: z.string().min(1) } }, async ({ jobId }) => { try { const state = await bridge.status(jobId); return result({ jobId, status: state.status, pendingInput: state.pendingInput }); } catch (e) { return failure(e); } });
server.registerTool('codex_answer_input', { description: '提交 codex_pending_input 返回的问题答案，并恢复任务；不能用于批准命令或文件变更。', inputSchema: { inputId: z.string().min(1), answers: z.record(z.unknown()) } }, async (args) => { try { return result(await bridge.answerInput(args)); } catch (e) { return failure(e); } });
server.registerTool('codex_doctor', { description: '检查桥接模式、Codex 可执行文件、初始化状态、沙箱、目录白名单和任务索引配置。', inputSchema: {} }, async () => { try { return result(await bridge.doctor()); } catch (e) { return failure(e); } });
await server.connect(new StdioServerTransport());
const shutdown = async () => { await bridge.close(); process.exit(0); };
process.once('SIGINT', shutdown); process.once('SIGTERM', shutdown); process.stdin.once('end', shutdown);
