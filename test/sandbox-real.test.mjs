import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, access, rm } from 'node:fs/promises';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

async function connect(mode) {
  const env = { ...process.env, CODEX_APP_SERVER_URL: '' };
  if (mode) env.CODEX_SANDBOX_MODE = mode; else delete env.CODEX_SANDBOX_MODE;
  const client = new Client({ name: 'sandbox-file-e2e', version: '1.0.0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.resolve('server.mjs')], env, stderr: 'pipe' }));
  return client;
}
async function call(client, name, args) {
  const r = await client.callTool({ name, arguments: args });
  const text = r.content?.find(x => x.type === 'text')?.text || '';
  assert.ok(!r.isError, text); return JSON.parse(text);
}
async function run(client, cwd, filename, threadId) {
  const job = await call(client, 'codex_start', { cwd, prompt: `Create a file named ${filename} in the current workspace containing exactly SANDBOX_OK. Use the available file editing or shell tool to actually save it. If the sandbox denies writing, report the denial and stop. Do not request elevated permissions. Do not change any other file.`, ...(threadId ? { threadId } : {}) });
  console.log('Started real sandbox task', { sandboxMode: job.sandboxMode, jobId: job.jobId });
  const deadline = Date.now() + 120000;
  let lastState;
  while (Date.now() < deadline) {
    const state = await call(client, 'codex_status', { jobId: job.jobId });
    lastState = state;
    if (['completed', 'failed', 'cancelled', 'unknown'].includes(state.status)) { assert.equal(state.status, 'completed', state.error || state.assistantReply); return state; }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  await call(client, 'codex_cancel', { jobId: job.jobId }); throw new Error('real sandbox task timed out: ' + JSON.stringify(lastState));
}

test('real MCP file permissions: default read-only, opt-in write, resume downgraded to read-only', { skip: process.env.CODEX_RUN_SANDBOX_REAL !== '1', timeout: 400000 }, async () => {
  const parent = path.resolve('test-tmp'); await mkdir(parent, { recursive: true });
  const cwd = await mkdtemp(path.join(parent, 'sandbox-'));
  let client;
  try {
    client = await connect();
    const ro = await run(client, cwd, 'denied-default.txt'); assert.equal(ro.sandboxMode, 'read-only');
    await assert.rejects(access(path.join(cwd, 'denied-default.txt')), { code: 'ENOENT' });
    await client.close(); client = await connect('workspace-write');
    const writable = await run(client, cwd, 'allowed.txt'); assert.equal(writable.sandboxMode, 'workspace-write');
    assert.equal((await readFile(path.join(cwd, 'allowed.txt'), 'utf8')).trim(), 'SANDBOX_OK');
    await client.close(); client = await connect('read-only');
    const downgraded = await run(client, cwd, 'denied-resume.txt', writable.threadId); assert.equal(downgraded.sandboxMode, 'read-only');
    await assert.rejects(access(path.join(cwd, 'denied-resume.txt')), { code: 'ENOENT' });
  } finally {
    await client?.close();
    const relative = path.relative(parent, cwd);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Unsafe test cleanup path');
    try { await rm(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); }
    catch (e) { console.warn('Temporary test directory retained:', cwd, e.code); }
  }
});
