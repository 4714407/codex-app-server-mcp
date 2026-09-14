import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const root = path.resolve('test-tmp');
let client, transport;
const call = async (name, args) => {
  const response = await client.callTool({ name, arguments: args });
  const text = response.content?.find((x) => x.type === 'text')?.text || '';
  return { response, text, data: (() => { try { return JSON.parse(text); } catch { return null; } })() };
};
const waitForTerminal = async (jobId, timeout = 120_000) => {
  const until = Date.now() + timeout;
  for (;;) {
    const r = await call('codex_status', { jobId });
    if (['completed', 'failed', 'cancelled'].includes(r.data.status)) return r.data;
    if (Date.now() > until) throw new Error(`job ${jobId} did not finish`);
    await new Promise((resolve) => setTimeout(resolve, 750));
  }
};
test.before(async () => {
  await mkdir(root, { recursive: true });
  client = new Client({ name: 'bridge-e2e-test', version: '1.0.0' }, { capabilities: {} });
  const env = { ...process.env };
  if (process.platform === 'win32' && !env.CODEX_EXECUTABLE) env.CODEX_EXECUTABLE = 'C:\\Users\\luo\\AppData\\Local\\Programs\\OpenAI\\Codex\\bin\\codex.exe';
  transport = new StdioClientTransport({ command: process.execPath, args: [path.resolve('server.mjs')], cwd: path.resolve(), env, stderr: 'pipe' });
  await client.connect(transport);
});
test.after(async () => { await transport?.close(); await rm(root, { recursive: true, force: true }); });

test('MCP tools/list exposes the documented bridge tools', async () => {
  const listed = await client.listTools();
  assert.deepEqual(listed.tools.map((x) => x.name).sort(), ['codex_answer_input', 'codex_cancel', 'codex_compact', 'codex_doctor', 'codex_models', 'codex_pending_input', 'codex_review', 'codex_start', 'codex_status', 'codex_steer']);
});
test('codex_models returns the live model catalog', async (t) => {
  const models = await call('codex_models', { limit: 100 });
  if (models.response.isError && /not found on PATH|not logged in|app-server exited|Could not find home directory/i.test(models.text)) {
    t.skip(`真实 Codex 模型列表测试环境不可用：${models.text}`); return;
  }
  assert.equal(models.response.isError, undefined, models.text);
  assert.ok(Array.isArray(models.data.models));
  assert.ok(Object.hasOwn(models.data, 'nextCursor'));
  for (const model of models.data.models) {
    assert.equal(typeof model.id, 'string');
    assert.equal(typeof model.displayName, 'string');
  }
});
test('invalid cwd and unknown job are useful MCP tool errors', async () => {
  const invalid = await call('codex_start', { prompt: 'hi', cwd: path.join(root, 'does-not-exist') });
  assert.equal(invalid.response.isError, true); assert.match(invalid.text, /cwd/i);
  const unknown = await call('codex_status', { jobId: 'not-a-job' });
  assert.equal(unknown.response.isError, true); assert.match(unknown.text, /unknown jobId/i);
});
test('real Codex task and resumed thread retain context', { timeout: 180_000 }, async (t) => {
  const smoke = await call('codex_start', { prompt: '只回复 CODEX_OK，不读取或修改任何文件。', cwd: root });
  if (smoke.response.isError) {
    if (/Could not find home directory|not found on PATH|not logged in|app-server exited/i.test(smoke.text)) { t.skip(`真实 Codex 测试环境不可用：${smoke.text}`); return; }
    assert.fail(smoke.text);
  }
  const smokeDone = await waitForTerminal(smoke.data.jobId);
  assert.equal(smokeDone.status, 'completed', smokeDone.error); assert.match(smokeDone.assistantReply, /CODEX_OK/);
  const token = `BRIDGE_${Math.random().toString(36).slice(2, 10)}`;
  const first = await call('codex_start', { prompt: `Remember exactly this token and reply only with it: ${token}`, cwd: root });
  if (first.response.isError) {
    if (/Could not find home directory|not found on PATH|not logged in|app-server exited/i.test(first.text)) { t.skip(`真实 Codex 测试环境不可用：${first.text}`); return; }
    assert.fail(first.text);
  }
  assert.ok(first.data.jobId); assert.ok(first.data.threadId);
  const one = await waitForTerminal(first.data.jobId);
  assert.equal(one.status, 'completed', one.error); assert.match(one.assistantReply, new RegExp(token));
  const second = await call('codex_start', { prompt: 'Reply only with the token I asked you to remember.', cwd: root, threadId: first.data.threadId });
  assert.equal(second.response.isError, undefined, second.text);
  const two = await waitForTerminal(second.data.jobId);
  assert.equal(two.status, 'completed', two.error); assert.match(two.assistantReply, new RegExp(token));
});
