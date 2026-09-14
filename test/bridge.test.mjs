import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { WebSocketServer } from 'ws';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CodexBridge } from '../lib/codex-bridge.mjs';

function fakeBridge() {
  let child;
  const spawnImpl = () => {
    child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough(); child.killed = false;
    child.kill = () => { child.killed = true; child.emit('exit', 1, null); };
    child.stdin.setEncoding('utf8'); let buffer = '';
    child.stdin.on('data', (chunk) => { buffer += chunk; while (buffer.includes('\n')) { const i = buffer.indexOf('\n'); const msg = JSON.parse(buffer.slice(0, i)); buffer = buffer.slice(i + 1); respond(msg); } });
    return child;
  };
  const emit = (message, split = false) => { const line = `${JSON.stringify(message)}\n`; if (split) { child.stdout.write(line.slice(0, 9)); child.stdout.write(line.slice(9)); } else child.stdout.write(line); };
  const respond = (msg) => {
    if (!msg.id) return;
    if (msg.method === 'initialize') emit({ id: msg.id, result: { platformFamily: 'windows' } }, true);
    else if (msg.method === 'thread/start') emit({ id: msg.id, result: { thread: { id: 'thread-a' } } });
    else if (msg.method === 'turn/start') { emit({ method: 'turn/started', params: { threadId: 'thread-a', turn: { id: 'turn-a' } } }); emit({ id: msg.id, result: { turn: { id: 'turn-a' } } }); }
    else if (msg.method === 'turn/interrupt') emit({ id: msg.id, result: {} });
    else if (msg.method === 'turn/steer') emit({ id: msg.id, result: { turnId: 'turn-a' } });
  };
  return { bridge: new CodexBridge({ executable: process.execPath, spawnImpl, logger: () => {} }), emit, child: () => child };
}

test('JSONL chunks, early turn events, cancellation confirmation, and busy state', async () => {
  const { bridge, emit } = fakeBridge();
  const started = await bridge.start({ prompt: 'hello', cwd: process.cwd() });
  assert.equal(started.status, 'running'); assert.equal(started.turnId, 'turn-a');
  await assert.rejects(() => bridge.start({ prompt: 'second', cwd: process.cwd() }), /busy/);
  assert.deepEqual(await bridge.cancel(started.jobId), { jobId: started.jobId, state: 'requested', status: 'running' });
  assert.equal(bridge.status(started.jobId).status, 'running');
  emit({ method: 'item/agentMessage/delta', params: { threadId: 'thread-a', turnId: 'turn-a', delta: 'CODEX_' } });
  emit({ method: 'item/agentMessage/delta', params: { threadId: 'thread-a', turnId: 'turn-a', delta: 'OK' } });
  emit({ method: 'turn/completed', params: { threadId: 'thread-a', turn: { id: 'turn-a', status: 'interrupted' } } });
  assert.equal(bridge.status(started.jobId).status, 'cancelled'); assert.equal(bridge.status(started.jobId).assistantReply, 'CODEX_OK');
  await bridge.close();
});

test('app-server exit marks active work failed', async () => {
  const { bridge, child } = fakeBridge(); const started = await bridge.start({ prompt: 'hello', cwd: process.cwd() });
  child().emit('exit', 1, null);
  assert.equal(bridge.status(started.jobId).status, 'failed'); assert.match(bridge.status(started.jobId).error, /exited/);
});

test('status cursor returns only new output and can wait for a change', async () => {
  const { bridge, emit } = fakeBridge(); const job = await bridge.start({ prompt: 'hello', cwd: process.cwd() });
  emit({ method: 'item/agentMessage/delta', params: { threadId: job.threadId, turnId: job.turnId, delta: 'one' } });
  const first = bridge.status(job.jobId); assert.equal(first.outputCursor, 3);
  setTimeout(() => emit({ method: 'item/agentMessage/delta', params: { threadId: job.threadId, turnId: job.turnId, delta: ' two' } }), 10);
  const next = await bridge.status(job.jobId, { cursor: first.outputCursor, waitMs: 1000 });
  assert.equal(next.assistantReply, ' two'); assert.equal(next.outputCursor, 7); await bridge.close();
});

test('steering and user-input wait state do not broaden approval permissions', async () => {
  const { bridge, emit } = fakeBridge(); const job = await bridge.start({ prompt: 'hello', cwd: process.cwd() });
  assert.equal((await bridge.steer({ jobId: job.jobId, prompt: 'focus on tests' })).state, 'steered');
  emit({ id: 'question-1', method: 'item/tool/requestUserInput', params: { threadId: job.threadId, turnId: job.turnId, questions: [{ id: 'q', question: 'continue?' }] } });
  const waiting = bridge.status(job.jobId); assert.equal(waiting.status, 'waiting_for_input'); assert.ok(waiting.pendingInput.inputId);
  assert.equal((await bridge.answerInput({ inputId: waiting.pendingInput.inputId, answers: { q: 'yes' } })).state, 'answered');
  assert.equal(bridge.status(job.jobId).status, 'running'); await bridge.close();
});

test('remote mode authenticates, does not validate local cwd, and marks a dropped task unknown', async () => {
  let authorization; let peer;
  const server = new WebSocketServer({ port: 0 });
  await new Promise((resolve) => server.once('listening', resolve));
  server.on('connection', (socket, request) => {
    peer = socket; authorization = request.headers.authorization;
    socket.on('message', (raw) => {
      const msg = JSON.parse(raw.toString()); if (!msg.id) return;
      if (msg.method === 'initialize') socket.send(JSON.stringify({ id: msg.id, result: { platformFamily: 'linux' } }));
      else if (msg.method === 'thread/start') socket.send(JSON.stringify({ id: msg.id, result: { thread: { id: 'remote-thread' } } }));
      else if (msg.method === 'turn/start') { socket.send(JSON.stringify({ method: 'turn/started', params: { threadId: 'remote-thread', turn: { id: 'remote-turn' } } })); socket.send(JSON.stringify({ id: msg.id, result: { turn: { id: 'remote-turn' } } })); }
    });
  });
  const port = server.address().port;
  const secretDir = await mkdtemp(path.join(tmpdir(), 'codex-bridge-test-')); const secretFile = path.join(secretDir, 'token'); await writeFile(secretFile, 'test-secret\n');
  try {
    const bridge = new CodexBridge({ remoteUrl: `ws://127.0.0.1:${port}`, remoteTokenFile: secretFile, logger: () => {} });
    const job = await bridge.start({ prompt: 'hello', cwd: '/remote/path/that-does-not-exist' });
    assert.equal(job.mode, 'remote'); assert.equal(authorization, 'Bearer test-secret');
    peer.close(); await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(bridge.status(job.jobId).status, 'unknown'); assert.match(bridge.status(job.jobId).error, /not retried/);
    await bridge.close();
  } finally { await rm(secretDir, { recursive: true, force: true }); await new Promise((resolve) => server.close(resolve)); }
});
