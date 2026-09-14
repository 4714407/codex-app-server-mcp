import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { CodexBridge } from '../lib/codex-bridge.mjs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import path from 'node:path';

function fixture(sandboxMode, model) {
  const messages = []; let child; let turn = 0;
  const send = message => child.stdout.write(JSON.stringify(message) + '\n');
  const bridge = new CodexBridge({ sandboxMode, model, allowedRoots: sandboxMode === 'workspace-write' ? [process.cwd()] : [], remoteUrl: '', executable: process.execPath, logger: () => {}, spawnImpl: () => {
    child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => child.emit('exit', 0);
    let buffer = '';
    child.stdin.on('data', chunk => {
      buffer += chunk;
      while (buffer.includes('\n')) {
        const i = buffer.indexOf('\n'); const m = JSON.parse(buffer.slice(0, i)); buffer = buffer.slice(i + 1); messages.push(m);
        if (!m.method || m.id === undefined) continue;
        let result = {};
        if (m.method === 'model/list') result = { data: [{ id: 'model-1', model: 'gpt-5', displayName: 'GPT-5', description: 'test model', isDefault: true, defaultReasoningEffort: 'medium', supportedReasoningEfforts: [{ effort: 'low' }], availabilityNux: { message: 'available' } }], nextCursor: 'next-page' };
        if (m.method === 'thread/read') result = { thread: { id: 'thread', cwd: process.cwd() } };
        if (['thread/start', 'thread/resume'].includes(m.method)) result = { thread: { id: 'thread' } };
        if (m.method === 'turn/start') result = { turn: { id: `turn-${++turn}` } };
        if (m.method === 'review/start') result = { turn: { id: `turn-${++turn}` }, reviewThreadId: 'thread' };
        if (m.method === 'thread/compact/start') result = { turn: { id: `turn-${++turn}` } };
        send({ id: m.id, result });
      }
    });
    return child;
  }});
  return { bridge, messages, send };
}

test('sandbox config defaults to read-only, validates env and rejects unsupported values', () => {
  const previous = process.env.CODEX_SANDBOX_MODE;
  try {
    delete process.env.CODEX_SANDBOX_MODE;
    assert.equal(new CodexBridge().sandboxMode, 'read-only');
    process.env.CODEX_SANDBOX_MODE = 'workspace-write';
    assert.equal(new CodexBridge().sandboxMode, 'workspace-write');
    assert.equal(new CodexBridge({ sandboxMode: 'read-only' }).sandboxMode, 'read-only');
    for (const invalid of ['', 'danger-full-access', 'workspaceWrite', 'typo']) {
      process.env.CODEX_SANDBOX_MODE = invalid;
      assert.throws(() => new CodexBridge(), /CODEX_SANDBOX_MODE/);
    }
  } finally { if (previous === undefined) delete process.env.CODEX_SANDBOX_MODE; else process.env.CODEX_SANDBOX_MODE = previous; }
});

test('workspace-write fails closed without allowed roots and accepts listed roots', async () => {
  const noRoots = new CodexBridge({ sandboxMode: 'workspace-write', executable: process.execPath, logger: () => {} });
  await assert.rejects(noRoots.start({ cwd: process.cwd(), prompt: 'test' }), /CODEX_ALLOWED_ROOTS/);
  const { bridge } = fixture('workspace-write'); assert.deepEqual(bridge.allowedRoots, [process.cwd().replace(/[\\/]+$/, '')]); await bridge.close();
});

test('doctor reports the configured security and persistence settings', async () => {
  const bridge = new CodexBridge({ sandboxMode: 'workspace-write', allowedRoots: [process.cwd()], statePath: path.join(process.cwd(), 'test-tmp', 'doctor-state.json'), executable: process.execPath, logger: () => {} });
  const doctor = await bridge.doctor(); assert.equal(doctor.sandboxMode, 'workspace-write'); assert.deepEqual(doctor.allowedRoots, [process.cwd().replace(/[\\/]+$/, '')]); assert.equal(doctor.statePath.endsWith('doctor-state.json'), true); await bridge.close();
});

test('native review and compact create tracked jobs', async t => {
  const { bridge } = fixture('read-only'); t.after(() => bridge.close()); const requests = [];
  bridge.ensureReady = async () => {}; bridge.request = async (method, params) => { requests.push({ method, params }); if (method === 'thread/read') return { thread: { id: 'thread', cwd: process.cwd() } }; if (method === 'review/start') return { turn: { id: 'review-turn' }, reviewThreadId: 'thread' }; return { turn: { id: 'compact-turn' } }; };
  const review = await bridge.review({ threadId: 'thread', target: { type: 'uncommittedChanges' } });
  assert.equal(review.status, 'running'); assert.equal(requests.find(m => m.method === 'review/start').params.delivery, 'inline');
  bridge.activeJobId = null; const compact = await bridge.compact({ threadId: 'thread' }); assert.equal(compact.status, 'running'); assert.ok(requests.find(m => m.method === 'thread/compact/start'));
});

for (const mode of ['read-only', 'workspace-write']) {
  test(`${mode}: new/resumed threads and turns reapply policy; requests cannot change sandbox`, async t => {
    const { bridge, messages, send } = fixture(mode); t.after(() => bridge.close());
    const first = await bridge.start({ cwd: process.cwd(), prompt: 'test', sandboxMode: 'danger-full-access' });
    assert.equal(first.sandboxMode, mode);
    send({ method: 'turn/completed', params: { threadId: first.threadId, turn: { id: first.turnId, status: 'completed' } } });
    const second = await bridge.start({ cwd: process.cwd(), prompt: 'continue', threadId: first.threadId });
    const expected = mode === 'read-only' ? { type: 'readOnly', networkAccess: false } : { type: 'workspaceWrite', writableRoots: [process.cwd()], networkAccess: false };
    for (const method of ['thread/start', 'thread/resume']) {
      const req = messages.find(m => m.method === method); assert.equal(req.params.sandbox, mode); assert.equal(req.params.approvalPolicy, 'never');
    }
    const turns = messages.filter(m => m.method === 'turn/start'); assert.equal(turns.length, 2);
    for (const req of turns) { assert.deepEqual(req.params.sandboxPolicy, expected); assert.equal(req.params.approvalPolicy, 'never'); }
    send({ method: 'turn/completed', params: { threadId: first.threadId, turn: { id: first.turnId, status: 'interrupted' } } });
    assert.equal(bridge.status(second.jobId).status, 'running');
    send({ method: 'item/agentMessage/delta', params: { threadId: second.threadId, turnId: second.turnId, delta: 'second answer' } });
    send({ method: 'turn/completed', params: { threadId: second.threadId, turn: { id: second.turnId, status: 'completed' } } });
    assert.equal(bridge.status(second.jobId).status, 'completed');
    assert.equal(bridge.status(second.jobId).assistantReply, 'second answer');
    assert.equal(bridge.status(first.jobId).assistantReply, '');
  });

  test(`${mode}: approval requests are still denied`, async t => {
    const { bridge, messages, send } = fixture(mode); t.after(() => bridge.close());
    const job = await bridge.start({ cwd: process.cwd(), prompt: 'test' });
    send({ id: 'approval', method: 'item/fileChange/requestApproval', params: { threadId: job.threadId, turnId: job.turnId } });
    assert.deepEqual(messages.find(m => m.id === 'approval').result, { decision: 'cancel' });
  });

  test(`${mode}: MCP tool discovery reports configured mode without a per-call switch`, async t => {
    const client = new Client({ name: 'sandbox-config-test', version: '1.0.0' });
    const transport = new StdioClientTransport({ command: process.execPath, args: [path.resolve('server.mjs')], env: { ...process.env, CODEX_SANDBOX_MODE: mode, CODEX_APP_SERVER_URL: '' }, stderr: 'pipe' });
    t.after(() => client.close()); await client.connect(transport);
    const tool = (await client.listTools()).tools.find(x => x.name === 'codex_start');
    assert.ok(tool.description.includes(mode));
    assert.deepEqual(Object.keys(tool.inputSchema.properties).sort(), ['cwd', 'model', 'prompt', 'threadId']);
  });
}

test('remote workspace-write passes remote cwd as writable root', async () => {
  const bridge = new CodexBridge({ sandboxMode: 'workspace-write', allowedRoots: ['/remote'], remoteUrl: 'wss://example.invalid' });
  const requests = []; bridge.ensureReady = async () => {};
  bridge.request = async (method, params) => { requests.push({ method, params }); return method === 'thread/start' ? { thread: { id: 'remote' } } : { turn: { id: 'turn' } }; };
  const job = await bridge.start({ cwd: '/remote/nonexistent-local-project', prompt: 'test' });
  assert.equal(job.mode, 'remote');
  assert.deepEqual(requests.find(m => m.method === 'turn/start').params.sandboxPolicy.writableRoots, ['/remote/nonexistent-local-project']);
  await bridge.close();
});


test('model override is forwarded on new/resumed threads and each turn; unset is omitted', async () => {
 const prior = process.env.CODEX_MODEL;
 try {
  delete process.env.CODEX_MODEL;
  assert.equal(new CodexBridge().model, null);
  process.env.CODEX_MODEL = 'configured-model';
  assert.equal(new CodexBridge().model, 'configured-model');
  assert.throws(() => new CodexBridge({ model: '' }), /CODEX_MODEL/);
  delete process.env.CODEX_MODEL;
  for (const model of [undefined, 'test-model-id']) {
   const { bridge, messages, send } = fixture('read-only', model);
   try {
    const first = await bridge.start({ cwd: process.cwd(), prompt: 'hello' });
    assert.equal(first.requestedModel, model ?? null);
    send({ method: 'turn/completed', params: { threadId: first.threadId, turn: { id: first.turnId, status: 'completed' } } });
    await bridge.start({ cwd: process.cwd(), prompt: 'continue', threadId: first.threadId });
    for (const m of messages.filter(m => ['thread/start', 'thread/resume', 'turn/start'].includes(m.method))) {
     if (model) assert.equal(m.params.model, model); else assert.equal(Object.hasOwn(m.params, 'model'), false);
    }
   } finally { await bridge.close(); }
  }
  const { bridge, messages, send } = fixture('read-only', 'configured-model');
  try {
   const first = await bridge.start({ cwd: process.cwd(), prompt: 'hello', model: 'requested-model' });
   assert.equal(first.requestedModel, 'requested-model');
   send({ method: 'turn/completed', params: { threadId: first.threadId, turn: { id: first.turnId, status: 'completed' } } });
   const second = await bridge.start({ cwd: process.cwd(), prompt: 'continue', threadId: first.threadId, model: 'another-model' });
   assert.equal(second.requestedModel, 'another-model');
   assert.equal(messages.find(m => m.method === 'thread/start').params.model, 'requested-model');
   assert.equal(messages.find(m => m.method === 'thread/resume').params.model, 'another-model');
   assert.deepEqual(messages.filter(m => m.method === 'turn/start').map(m => m.params.model), ['requested-model', 'another-model']);
   await assert.rejects(bridge.start({ cwd: process.cwd(), prompt: 'bad', model: ' ' }), /model must/);
  } finally { await bridge.close(); }
 } finally { if (prior === undefined) delete process.env.CODEX_MODEL; else process.env.CODEX_MODEL = prior; }
});

test('listModels reads and normalizes the live app-server model list', async t => {
 const { bridge, messages } = fixture('read-only', 'configured-model'); t.after(() => bridge.close());
 const listed = await bridge.listModels({ limit: 10 });
 assert.equal(listed.configuredModel, 'configured-model');
 assert.equal(listed.sandboxMode, 'read-only');
 assert.deepEqual(listed.models, [{ id: 'model-1', model: 'gpt-5', displayName: 'GPT-5', description: 'test model', isDefault: true, defaultReasoningEffort: 'medium', supportedReasoningEfforts: [{ effort: 'low' }], availabilityMessage: 'available' }]);
 assert.equal(listed.nextCursor, 'next-page');
 assert.deepEqual(messages.find(m => m.method === 'model/list').params, { limit: 10, includeHidden: false });
});

test('MCP discovery exposes codex_models with pagination arguments', async t => {
 const client = new Client({ name: 'model-list-test', version: '1.0.0' });
 const transport = new StdioClientTransport({ command: process.execPath, args: [path.resolve('server.mjs')], env: { ...process.env, CODEX_APP_SERVER_URL: '' }, stderr: 'pipe' });
 t.after(() => client.close()); await client.connect(transport);
 const tool = (await client.listTools()).tools.find(x => x.name === 'codex_models');
 assert.ok(tool);
 assert.deepEqual(Object.keys(tool.inputSchema.properties).sort(), ['cursor', 'limit']);
});
