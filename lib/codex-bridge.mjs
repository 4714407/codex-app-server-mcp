import { spawn } from 'node:child_process';
import { access, readFile, stat } from 'node:fs/promises';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';

const MAX_JOBS = 100;
const MAX_OUTPUT = 256 * 1024;

export class CodexBridge {
  constructor(options = {}) {
    const sandboxMode = options.sandboxMode ?? process.env.CODEX_SANDBOX_MODE ?? 'read-only';
    if (!['read-only', 'workspace-write'].includes(sandboxMode)) {
      throw new Error('CODEX_SANDBOX_MODE must be read-only or workspace-write');
    }
    Object.defineProperty(this, 'sandboxMode', { value: sandboxMode, enumerable: true });
    const model = options.model ?? process.env.CODEX_MODEL;
    if (model !== undefined && (typeof model !== 'string' || !model.trim())) {
      throw new Error('CODEX_MODEL must be a non-empty model id, or unset to use the Codex default');
    }
    Object.defineProperty(this, 'model', { value: model?.trim() ?? null, enumerable: true });
    this.remoteUrl = options.remoteUrl ?? process.env.CODEX_APP_SERVER_URL ?? null;
    this.executable = options.executable || process.env.CODEX_EXECUTABLE || null;
    this.remoteToken = options.remoteToken;
    this.remoteTokenFile = options.remoteTokenFile ?? process.env.CODEX_REMOTE_TOKEN_FILE ?? null;
    this.allowedRoots = this.#parseAllowedRoots(options.allowedRoots ?? process.env.CODEX_ALLOWED_ROOTS);
    this.statePath = options.statePath ?? process.env.CODEX_STATE_PATH ?? null;
    this.inputTimeoutMs = options.inputTimeoutMs ?? Number(process.env.CODEX_INPUT_TIMEOUT_MS || 300_000);
    this.spawnImpl = options.spawnImpl || spawn;
    this.WebSocketImpl = options.WebSocketImpl || WebSocket;
    this.requestTimeoutMs = options.requestTimeoutMs || 30_000;
    this.initTimeoutMs = options.initTimeoutMs || 20_000;
    this.logger = options.logger || ((line) => process.stderr.write(`[codex-bridge] ${line}\n`));
    this.proc = null; this.socket = null; this.buffer = ''; this.stderrTail = ''; this.nextId = 1; this.pending = new Map();
    this.jobs = new Map(); this.activeJobId = null; this.threadCwds = new Map(); this.pendingInputs = new Map(); this.initialized = false; this.readyPromise = null;
    this.#loadState();
  }

  get mode() { return this.remoteUrl ? 'remote' : 'local'; }

  async doctor() {
    let executable = null; let executableError = null;
    if (this.mode === 'local') { try { executable = await this.#resolveExecutable(); } catch (error) { executableError = this.#message(error); } }
    return { mode: this.mode, sandboxMode: this.sandboxMode, configuredModel: this.model, allowedRoots: this.allowedRoots, statePath: this.statePath, executable, executableError, connected: this.#connected(), initialized: this.initialized, activeJobId: this.activeJobId, pendingInputCount: this.pendingInputs.size };
  }

  async listModels({ cursor, limit = 50 } = {}) {
    if (cursor !== undefined && (typeof cursor !== 'string' || !cursor)) throw new Error('cursor must be a non-empty string');
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('limit must be an integer from 1 to 100');
    await this.ensureReady();
    const result = await this.request('model/list', { ...(cursor ? { cursor } : {}), limit, includeHidden: false });
    if (!Array.isArray(result?.data)) throw new Error('model/list returned an incompatible response');
    return {
      configuredModel: this.model,
      sandboxMode: this.sandboxMode,
      models: result.data.map((model) => ({
        id: model.id,
        model: model.model,
        displayName: model.displayName,
        description: model.description,
        isDefault: model.isDefault,
        defaultReasoningEffort: model.defaultReasoningEffort,
        supportedReasoningEfforts: model.supportedReasoningEfforts,
        availabilityMessage: model.availabilityNux?.message ?? null,
      })),
      nextCursor: result.nextCursor ?? null,
    };
  }

  async ensureReady() {
    if (this.initialized && this.#connected()) return;
    if (this.readyPromise) return this.readyPromise;
    this.readyPromise = this.#initialize();
    try { await this.readyPromise; } finally { this.readyPromise = null; }
  }

  async #initialize() {
    if (this.mode === 'remote') await this.#connectRemote(); else await this.#startLocal();
    const result = await this.request('initialize', { clientInfo: { name: 'codex-app-server-mcp', title: 'Codex App Server MCP', version: '1.1.0' } }, this.initTimeoutMs);
    if (!result) throw new Error('Codex app-server initialization returned no result; the remote protocol may be incompatible');
    this.notify('initialized', {}); this.initialized = true;
  }

  async start({ prompt, cwd, threadId, model }) {
    if (model !== undefined && (typeof model !== 'string' || !model.trim())) throw new Error('model must be a non-empty model id');
    const requestedModel = model?.trim() ?? this.model;
    if (this.activeJobId) throw new Error('busy: another Codex task is active in this bridge process');
    if (typeof prompt !== 'string' || !prompt.trim()) throw new Error('prompt must be a non-empty string');
    if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) throw new Error('cwd must be an absolute directory path');
    this.#assertAllowedCwd(cwd);
    if (this.mode === 'local') {
      let info; try { info = await stat(cwd); } catch { throw new Error('cwd must be an existing absolute directory in local mode'); }
      if (!info.isDirectory()) throw new Error('cwd must be an existing absolute directory in local mode');
    }
    if (threadId && this.threadCwds.has(threadId) && this.threadCwds.get(threadId) !== cwd) throw new Error('cwd is incompatible with the existing thread');
    const job = { jobId: randomUUID(), threadId: threadId || null, turnId: null, status: 'starting', output: '', truncated: false, progress: [], error: null, cancelRequested: false, cwd, createdAt: Date.now(), mode: this.mode, sandboxMode: this.sandboxMode, requestedModel };
    this.jobs.set(job.jobId, job); this.activeJobId = job.jobId; this.#trimJobs();
    try {
      await this.ensureReady();
      let thread;
      if (threadId) {
        const stored = (await this.request('thread/read', { threadId, includeTurns: false })).thread;
        if (!stored?.cwd) throw new Error('cannot verify cwd and permissions of the existing thread');
        if (stored.cwd !== cwd) throw new Error('cwd is incompatible with the existing thread');
        thread = (await this.request('thread/resume', { threadId, cwd, approvalPolicy: 'never', sandbox: this.sandboxMode, ...(requestedModel ? { model: requestedModel } : {}), serviceName: 'codex-app-server-mcp' })).thread;
      } else {
        thread = (await this.request('thread/start', { cwd, approvalPolicy: 'never', sandbox: this.sandboxMode, ...(requestedModel ? { model: requestedModel } : {}), serviceName: 'codex-app-server-mcp' })).thread;
      }
      if (!thread?.id) throw new Error('Codex did not return a thread id; the app-server protocol may be incompatible');
      job.threadId = thread.id; this.threadCwds.set(thread.id, cwd);
      const turn = (await this.request('turn/start', { threadId: thread.id, input: [{ type: 'text', text: prompt }], cwd, approvalPolicy: 'never', sandboxPolicy: this.#sandboxPolicy(cwd), ...(requestedModel ? { model: requestedModel } : {}) })).turn;
      if (!turn?.id) throw new Error('Codex did not return a turn id; the app-server protocol may be incompatible');
      job.turnId = turn.id; if (job.status === 'starting') job.status = 'running';
      this.#persist(); return this.status(job.jobId);
    } catch (error) { job.status = 'failed'; job.error = this.#message(error); this.#release(job); throw error; }
  }

  status(jobId, { cursor, waitMs = 0 } = {}) {
    if (!Number.isInteger(waitMs) || waitMs < 0 || waitMs > 30_000) throw new Error('waitMs must be an integer from 0 to 30000');
    if (cursor !== undefined && (!Number.isInteger(cursor) || cursor < 0)) throw new Error('cursor must be a non-negative integer');
    const snapshot = () => this.#status(jobId, cursor);
    const first = snapshot();
    if (!waitMs || first.assistantReply || this.#terminal(first.status) || cursor === undefined) return first;
    return new Promise((resolve) => {
      const timer = setTimeout(() => { this.statusWaiters.delete(waiter); resolve(snapshot()); }, waitMs);
      const waiter = () => { clearTimeout(timer); this.statusWaiters.delete(waiter); resolve(snapshot()); };
      this.statusWaiters ??= new Set(); this.statusWaiters.add(waiter);
    });
  }
  #status(jobId, cursor) { const j = this.jobs.get(jobId); if (!j) throw new Error('unknown jobId'); const start = cursor === undefined ? 0 : Math.min(cursor, j.output.length); return { jobId: j.jobId, threadId: j.threadId, turnId: j.turnId, status: j.status, mode: j.mode, sandboxMode: j.sandboxMode, requestedModel: j.requestedModel, assistantReply: j.output.slice(start), outputCursor: j.output.length, outputTruncated: j.truncated, error: j.error, cancelRequested: j.cancelRequested, pendingInput: j.pendingInput ?? null, progress: j.progress.slice(-8) }; }
  async cancel(jobId) { const j = this.jobs.get(jobId); if (!j) throw new Error('unknown jobId'); if (['completed', 'failed', 'cancelled', 'unknown'].includes(j.status)) return { jobId, state: 'already-ended', status: j.status }; if (j.cancelRequested) return { jobId, state: 'already-requested', status: j.status }; if (!j.threadId || !j.turnId) return { jobId, state: 'not-ready', status: j.status }; this.#dismissPendingInput(j); await this.request('turn/interrupt', { threadId: j.threadId, turnId: j.turnId }); j.cancelRequested = true; j.progress.push('Cancellation requested; waiting for turn/completed confirmation.'); this.#changed(); return { jobId, state: 'requested', status: j.status }; }
  async steer({ jobId, prompt }) { const j = this.jobs.get(jobId); if (!j) throw new Error('unknown jobId'); if (j.status !== 'running' || !j.threadId || !j.turnId) throw new Error('job is not a steerable running turn'); if (typeof prompt !== 'string' || !prompt.trim()) throw new Error('prompt must be a non-empty string'); const result = await this.request('turn/steer', { threadId: j.threadId, expectedTurnId: j.turnId, input: [{ type: 'text', text: prompt }] }); j.progress.push('Additional instruction sent to the active turn.'); this.#changed(); return { jobId, threadId: j.threadId, turnId: result.turnId ?? j.turnId, state: 'steered' }; }
  async answerInput({ inputId, answers }) { const pending = this.pendingInputs.get(inputId); if (!pending) throw new Error('unknown or expired inputId'); if (!answers || typeof answers !== 'object' || Array.isArray(answers)) throw new Error('answers must be an object'); clearTimeout(pending.timer); this.pendingInputs.delete(inputId); const j = this.jobs.get(pending.jobId); if (j) { j.status = 'running'; j.pendingInput = null; j.progress.push('User input supplied; Codex turn resumed.'); } this.#send({ id: pending.requestId, result: { answers } }); this.#changed(); return { inputId, jobId: pending.jobId, state: 'answered' }; }
  async review({ threadId, target, delivery = 'inline' }) { if (!target || typeof target !== 'object') throw new Error('target is required'); if (target.type === 'baseBranch' && !target.branch) throw new Error('baseBranch review requires target.branch'); if (target.type === 'commit' && !target.sha) throw new Error('commit review requires target.sha'); if (target.type === 'custom' && !target.instructions) throw new Error('custom review requires target.instructions'); return this.#startNativeTurn('review/start', { threadId, target, delivery }, 'review'); }
  async compact({ threadId }) { return this.#startNativeTurn('thread/compact/start', { threadId }, 'compaction'); }
  async #startNativeTurn(method, params, kind) {
    if (this.activeJobId) throw new Error('busy: another Codex task is active in this bridge process');
    if (typeof params.threadId !== 'string' || !params.threadId) throw new Error('threadId must be a non-empty string');
    await this.ensureReady();
    const stored = (await this.request('thread/read', { threadId: params.threadId, includeTurns: false })).thread;
    if (!stored?.cwd) throw new Error('cannot verify cwd and permissions of the existing thread');
    this.#assertAllowedCwd(stored.cwd);
    const j = this.#createJob({ cwd: stored.cwd, threadId: params.threadId, kind });
    try {
      const result = await this.request(method, params);
      if (!result?.turn?.id) throw new Error(`${method} did not return a turn id; the app-server protocol may be incompatible`);
      j.threadId = result.reviewThreadId ?? params.threadId; j.turnId = result.turn.id; j.status = 'running'; this.threadCwds.set(j.threadId, stored.cwd); this.#changed();
      return this.status(j.jobId);
    } catch (error) { j.status = 'failed'; j.error = this.#message(error); this.#release(j); this.#changed(); throw error; }
  }
  notify(method, params) { this.#send({ method, params }); }
  request(method, params, timeout = this.requestTimeoutMs) {
    if (!this.#connected()) return Promise.reject(new Error(`Codex app-server is not connected (${this.mode} mode)`));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${method} timed out after ${timeout}ms`)); }, timeout);
      this.pending.set(id, { resolve, reject, timer, method });
      try { this.#send({ method, id, params }); } catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }

  #sandboxPolicy(cwd) {
    return this.sandboxMode === 'workspace-write'
      ? { type: 'workspaceWrite', writableRoots: [cwd], networkAccess: false }
      : { type: 'readOnly', networkAccess: false };
  }

  async #startLocal() {
    const executable = await this.#resolveExecutable();
    this.proc = this.spawnImpl(executable, ['app-server', '--listen', 'stdio://'], { stdio: ['pipe', 'pipe', 'pipe'], shell: false, windowsHide: true, env: process.env });
    this.stderrTail = ''; this.proc.stdout.setEncoding('utf8'); this.proc.stderr.setEncoding('utf8');
    this.proc.stdout.on('data', (chunk) => this.#onStdout(chunk));
    this.proc.stderr.on('data', (chunk) => { this.stderrTail = `${this.stderrTail}${chunk}`.slice(-4096); this.logger(`codex stderr: ${chunk.trimEnd()}`); });
    this.proc.on('error', (error) => this.#onLocalExit(error));
    this.proc.on('exit', (code, signal) => this.#onLocalExit(new Error(`Codex app-server exited (${code ?? 'null'}, ${signal ?? 'none'})`)));
  }
  async #connectRemote() {
    const url = this.#validateRemoteUrl(this.remoteUrl);
    const token = await this.#readRemoteToken();
    const headers = token ? { Authorization: `Bearer ${token}` } : undefined;
    await new Promise((resolve, reject) => {
      const socket = new this.WebSocketImpl(url, headers ? { headers } : undefined);
      const timer = setTimeout(() => { socket.terminate?.(); reject(new Error(`remote WebSocket connection timed out after ${this.initTimeoutMs}ms`)); }, this.initTimeoutMs);
      socket.once('open', () => { clearTimeout(timer); this.socket = socket; socket.on('message', (data) => this.#onRemoteMessage(data)); socket.on('close', (code) => this.#onRemoteClose(code)); socket.on('error', (error) => this.#onRemoteError(error)); resolve(); });
      socket.once('error', (error) => { clearTimeout(timer); reject(new Error(`remote WebSocket connection failed: ${this.#message(error)}`)); });
    });
  }
  async #readRemoteToken() {
    if (this.remoteToken !== undefined) return this.remoteToken || null;
    if (process.env.CODEX_REMOTE_BEARER_TOKEN) return process.env.CODEX_REMOTE_BEARER_TOKEN;
    if (this.remoteTokenFile) {
      try { const token = (await readFile(this.remoteTokenFile, 'utf8')).trim(); if (!token) throw new Error('is empty'); return token; }
      catch (error) { throw new Error(`cannot read CODEX_REMOTE_TOKEN_FILE: ${this.#message(error)}`); }
    }
    return null;
  }
  #validateRemoteUrl(value) {
    let url; try { url = new URL(value); } catch { throw new Error('CODEX_APP_SERVER_URL must be a valid ws:// or wss:// URL'); }
    if (!['ws:', 'wss:'].includes(url.protocol) || url.username || url.password) throw new Error('CODEX_APP_SERVER_URL must be a credential-free ws:// or wss:// URL');
    if (url.protocol === 'ws:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('remote Codex requires wss://; ws:// is allowed only for localhost or an SSH tunnel');
    return url;
  }
  #connected() { return this.mode === 'remote' ? this.socket?.readyState === this.WebSocketImpl.OPEN : Boolean(this.proc?.stdin?.writable); }
  #send(message) { const encoded = JSON.stringify(message); if (this.mode === 'remote') { if (!this.#connected()) throw new Error('remote Codex connection is closed'); this.socket.send(encoded); } else if (this.proc?.stdin?.writable) this.proc.stdin.write(`${encoded}\n`); else throw new Error('local Codex app-server is not running'); }
  #onStdout(chunk) { this.buffer += chunk; for (;;) { const i = this.buffer.indexOf('\n'); if (i < 0) break; const line = this.buffer.slice(0, i).trim(); this.buffer = this.buffer.slice(i + 1); if (!line) continue; try { this.#onMessage(JSON.parse(line)); } catch (e) { this.logger(`invalid Codex JSONL: ${this.#message(e)}`); } } }
  #onRemoteMessage(data) { try { this.#onMessage(JSON.parse(data.toString())); } catch (error) { this.#onRemoteDisconnect(new Error(`invalid remote WebSocket JSON-RPC message: ${this.#message(error)}`)); } }
  #onMessage(msg) {
    if (Object.hasOwn(msg, 'id') && (Object.hasOwn(msg, 'result') || Object.hasOwn(msg, 'error'))) { const p = this.pending.get(msg.id); if (!p) return; clearTimeout(p.timer); this.pending.delete(msg.id); if (msg.error) p.reject(new Error(`${p.method}: ${msg.error.message || JSON.stringify(msg.error)}`)); else p.resolve(msg.result); return; }
    if (Object.hasOwn(msg, 'id') && msg.method) { this.#serverRequest(msg); return; }
    if (!msg.method) return; const p = msg.params || {}; const eventTurnId = p.turnId ?? p.turn?.id; const j = this.jobs.get(this.activeJobId); if (!j || j.threadId !== p.threadId || (eventTurnId && j.turnId && j.turnId !== eventTurnId)) return;
    if (msg.method === 'item/agentMessage/delta') this.#append(j, p.delta || p.text || '');
    if (msg.method === 'item/completed' && p.item?.type === 'agentMessage') { const finalText = p.item.text || ''; if (finalText && !j.output.includes(finalText)) this.#append(j, finalText); }
    if (msg.method === 'turn/started') { if (!j.turnId && p.turn?.id) j.turnId = p.turn.id; j.status = 'running'; this.#changed(); }
    if (msg.method === 'turn/completed') { const status = p.turn?.status; if (status === 'completed') j.status = 'completed'; else if (status === 'interrupted') j.status = 'cancelled'; else { j.status = 'failed'; j.error = p.turn?.error?.message || `Codex turn ended with ${status || 'unknown status'}`; } this.#dismissPendingInput(j); j.progress.push(`Turn finished: ${status || 'unknown'}`); this.#release(j); this.#changed(); }
    else if (msg.method === 'error' || msg.method === 'warning') j.progress.push(p.message || msg.method);
  }
  #serverRequest(msg) { const p = msg.params || {}; const j = [...this.jobs.values()].find(x => x.threadId === p.threadId && (!p.turnId || x.turnId === p.turnId));
    if (msg.method === 'item/tool/requestUserInput' && j) { const inputId = randomUUID(); const timer = setTimeout(() => { this.pendingInputs.delete(inputId); if (j.pendingInput?.inputId === inputId) { j.pendingInput = null; j.status = 'failed'; j.error = 'Timed out waiting for user input'; j.progress.push(j.error); this.#send({ id: msg.id, result: { answers: {} } }); this.#release(j); this.#changed(); } }, this.inputTimeoutMs); this.pendingInputs.set(inputId, { inputId, requestId: msg.id, jobId: j.jobId, timer }); j.status = 'waiting_for_input'; j.pendingInput = { inputId, questions: p.questions ?? p.input ?? null }; j.progress.push('Codex is waiting for user input.'); this.#changed(); return; }
    if (j) { j.progress.push(`Codex requested ${msg.method}; bridge denied it.`); if (p.turnId && j.status === 'running') j.error = `Codex requested unsupported/approval-gated capability: ${msg.method}`; }
    const denial = msg.method === 'item/commandExecution/requestApproval' || msg.method === 'item/fileChange/requestApproval' ? { decision: 'cancel' } : msg.method === 'applyPatchApproval' || msg.method === 'execCommandApproval' ? { decision: 'abort' } : msg.method === 'item/tool/requestUserInput' ? { answers: {} } : null;
    this.#send(denial ? { id: msg.id, result: denial } : { id: msg.id, error: { code: -32601, message: `Unsupported server request: ${msg.method}` } });
  }
  #append(j, text) { if (typeof text !== 'string' || !text) return; const room = MAX_OUTPUT - j.output.length; if (room <= 0) { j.truncated = true; this.#changed(); return; } j.output += text.slice(0, room); if (text.length > room) j.truncated = true; this.#changed(); }
  #onLocalExit(error) { this.initialized = false; this.proc = null; const detail = this.stderrTail.trim(); this.#failConnection(detail ? new Error(`${this.#message(error)}: ${detail}`) : error, 'failed'); }
  #onRemoteError(error) { if (this.socket?.readyState !== this.WebSocketImpl.OPEN) this.#onRemoteDisconnect(new Error(`remote WebSocket error: ${this.#message(error)}`)); }
  #onRemoteClose(code) { this.#onRemoteDisconnect(new Error(`remote Codex WebSocket disconnected (close code ${code}); task status is unknown and was not retried`)); }
  #onRemoteDisconnect(error) { if (!this.socket && !this.initialized) return; this.socket = null; this.initialized = false; this.#failConnection(error, 'unknown'); }
  #failConnection(error, status) { for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(error); } this.pending.clear(); for (const j of this.jobs.values()) if (['starting', 'running', 'waiting_for_input'].includes(j.status)) { j.status = status; j.error = this.#message(error); j.pendingInput = null; j.progress.push(status === 'unknown' ? 'Remote connection lost; task was not retried.' : 'Codex app-server exited.'); this.#release(j); } this.#changed(); }
  #release(j) { if (this.activeJobId === j.jobId) this.activeJobId = null; }
  #trimJobs() { while (this.jobs.size > MAX_JOBS) this.jobs.delete(this.jobs.keys().next().value); }
  #createJob({ cwd, threadId = null, kind = 'task' }) { const job = { jobId: randomUUID(), threadId, turnId: null, status: 'starting', output: '', truncated: false, progress: [], error: null, cancelRequested: false, pendingInput: null, cwd, kind, createdAt: Date.now(), mode: this.mode, sandboxMode: this.sandboxMode, requestedModel: this.model }; this.jobs.set(job.jobId, job); this.activeJobId = job.jobId; this.#trimJobs(); return job; }
  #dismissPendingInput(j) { const inputId = j.pendingInput?.inputId; if (!inputId) return; const pending = this.pendingInputs.get(inputId); if (pending) { clearTimeout(pending.timer); this.pendingInputs.delete(inputId); try { this.#send({ id: pending.requestId, result: { answers: {} } }); } catch { /* connection has already closed */ } } j.pendingInput = null; }
  #terminal(status) { return ['completed', 'failed', 'cancelled', 'unknown'].includes(status); }
  #changed() { this.#persist(); for (const waiter of this.statusWaiters ?? []) waiter(); }
  #parseAllowedRoots(value) { if (value === undefined || value === null || value === '') return []; let roots; try { roots = Array.isArray(value) ? value : value.trim().startsWith('[') ? JSON.parse(value) : value.split(';'); } catch { throw new Error('CODEX_ALLOWED_ROOTS must be a semicolon-separated list or JSON string array'); } if (!Array.isArray(roots) || roots.some(x => typeof x !== 'string' || !x.trim())) throw new Error('CODEX_ALLOWED_ROOTS must contain non-empty directory paths'); return roots.map(x => x.trim().replace(/[\\/]+$/, '')); }
  #assertAllowedCwd(cwd) { if (this.sandboxMode !== 'workspace-write') return; if (!this.allowedRoots.length) throw new Error('workspace-write requires CODEX_ALLOWED_ROOTS to restrict writable directories'); const normalized = cwd.replace(/[\\/]+$/, ''); const allowed = this.allowedRoots.some(root => normalized === root || normalized.startsWith(`${root}\\`) || normalized.startsWith(`${root}/`)); if (!allowed) throw new Error('cwd is outside CODEX_ALLOWED_ROOTS'); }
  #loadState() { if (!this.statePath || !existsSync(this.statePath)) return; try { const saved = JSON.parse(readFileSync(this.statePath, 'utf8')); if (!Array.isArray(saved?.jobs)) throw new Error('jobs must be an array'); for (const data of saved.jobs.slice(-MAX_JOBS)) { if (!data?.jobId) continue; const restarted = !this.#terminal(data.status); const job = { ...data, status: restarted ? 'unknown' : data.status, error: restarted ? 'MCP restarted before task completion; Codex thread can be resumed manually.' : data.error ?? null, output: '', progress: [restarted ? 'Restored after restart; prior active task was not retried.' : 'Restored from local task index.'], pendingInput: null, cancelRequested: false, truncated: Boolean(data.truncated) }; this.jobs.set(job.jobId, job); if (job.threadId && job.cwd) this.threadCwds.set(job.threadId, job.cwd); } } catch (error) { this.logger(`cannot load task index: ${this.#message(error)}`); } }
  #persist() { if (!this.statePath) return; try { const directory = path.dirname(this.statePath); mkdirSync(directory, { recursive: true }); const jobs = [...this.jobs.values()].map(({ jobId, threadId, turnId, status, cwd, kind, createdAt, mode, sandboxMode, requestedModel, error, truncated }) => ({ jobId, threadId, turnId, status, cwd, kind, createdAt, mode, sandboxMode, requestedModel, error, truncated })); const temporary = `${this.statePath}.tmp`; writeFileSync(temporary, JSON.stringify({ version: 1, jobs }, null, 2), { encoding: 'utf8', mode: 0o600 }); renameSync(temporary, this.statePath); } catch (error) { this.logger(`cannot persist task index: ${this.#message(error)}`); } }
  async #resolveExecutable() { if (this.executable) { await access(this.executable); return this.executable; } const paths = (process.env.PATH || '').split(path.delimiter).filter(Boolean); const names = process.platform === 'win32' ? ['codex.exe', 'codex.cmd', 'codex.bat'] : ['codex']; for (const directory of paths) for (const name of names) { const candidate = path.join(directory, name); try { await access(candidate); return candidate; } catch { /* continue */ } } throw new Error('Codex executable was not found on PATH. Install Codex or set CODEX_EXECUTABLE to the absolute path of the codex executable.'); }
  #message(e) { return e instanceof Error ? e.message : String(e); }
  async close() { for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error('bridge closed')); } this.pending.clear(); if (this.mode === 'remote') { const socket = this.socket; this.socket = null; this.initialized = false; if (socket && socket.readyState === this.WebSocketImpl.OPEN) socket.close(); } else { if (this.proc && !this.proc.killed) this.proc.kill(); this.proc = null; this.initialized = false; } }
}
