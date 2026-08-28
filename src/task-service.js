// chatgpt-codex-orchestrator: unified task entry / lifecycle (Batch B1).
// The caller only calls startTask / resumeTask / getTaskStatus / cancelTask.
// Worker + Brain + state + loop are managed internally via an injected `runtime`.
// A task lock prevents two runtimes from driving the same task simultaneously.
import path from 'node:path';
import { TaskManager } from './task-manager.js';
import { newTaskState } from './task-state.js';
import { TaskLock } from './task-lock.js';
import { makeTaskId } from './task-state.js';

export class TaskService {
  constructor({ stateDir, runtime }) {
    this.stateDir = stateDir || path.join(process.cwd(), '.state', 'tasks');
    this.dataStore = runtime && typeof runtime.makeDataStore === 'function' ? runtime.makeDataStore() : null;
    this.mgr = new TaskManager({ stateDir: this.stateDir, dataStore: this.dataStore });
    this.locks = new TaskLock({ lockDir: path.join(path.dirname(this.stateDir), 'locks') });
    this.runtime = runtime;
  }

  async startTask({ goal, repoDir, conversation = 'new', maxRounds = Infinity, allowCloseOwnedTab = true } = {}) {
    const taskId = makeTaskId();
    const releaseLock = this._acquireLock(taskId);
    let worker = null, brain = null;
    try {
      worker = this.runtime && typeof this.runtime.startWorker === 'function' ? await this.runtime.startWorker(taskId) : null;
      brain = await this._openBrain(conversation);
      const executor = this.runtime ? this.runtime.makeExecutor(worker) : null;
      const { state } = await this.mgr.startTask({ taskId, goal, repoDir, brain, executor, maxRounds, conversationMode: conversation, adopted: conversation === 'current' });
      this._teardown(worker, state, allowCloseOwnedTab);
      return { taskId, state };
    } catch (e) {
      this._teardown(worker, null, allowCloseOwnedTab);
      throw e;
    } finally {
      this._releaseLock(releaseLock);
    }
  }

  // Alias: adopt the current existing ChatGPT conversation (no new conversation).
  async adoptConversation({ goal, repoDir, maxRounds = Infinity }) {
    return this.startTask({ goal, repoDir, conversation: 'current', maxRounds, allowCloseOwnedTab: false });
  }

  // Create a task WITHOUT running the engine. The host then loops advanceTask(taskId).
  async createTask({ goal, repoDir, conversation = 'new', allowCloseOwnedTab = true } = {}) {
    const taskId = makeTaskId();
    const state = newTaskState({ taskId, repoDir, goal, conversationMode: conversation, adopted: conversation === 'current' });
    // Freeze real conversation identity at creation time (adopt / explicit id).
    if (conversation === 'current' && this.runtime && typeof this.runtime.captureConversation === 'function') {
      const cap = await this.runtime.captureConversation();
      state.conversationId = cap.conversationId;
      state.conversationUrl = cap.conversationUrl;
      state.ownedTabId = cap.tabId;
      state.adopted = true;
    } else if (typeof conversation === 'string' && conversation !== 'new' && this.runtime && typeof this.runtime.resolveConversation === 'function') {
      const cap = await this.runtime.resolveConversation(conversation);
      state.conversationId = cap.conversationId;
      state.conversationUrl = cap.conversationUrl;
      state.ownedTabId = cap.tabId;
    }
    this.persist(state);
    return { taskId, state };
  }

  async _openBrain(conversation) {
    if (!this.runtime) return null;
    if (conversation === 'current') {
      if (typeof this.runtime.adoptBrain === 'function') return this.runtime.adoptBrain();
      throw new Error('runtime does not support adopting current conversation');
    }
    if (typeof conversation === 'string' && conversation !== 'new') {
      // treat as a conversationId -> bind existing conversation by id
      if (typeof this.runtime.openBrainWithId === 'function') return this.runtime.openBrainWithId(conversation);
    }
    return this.runtime.openBrain();
  }

  async resumeTask({ taskId, maxRounds = Infinity }) {
    const state = this.mgr.load(taskId);
    const releaseLock = this._acquireLock(taskId);   // throws TaskLockedError if held
    let worker = null;
    try {
      worker = this.runtime ? await this.runtime.connectWorker(taskId, state) : null;
      const executor = this.runtime ? this.runtime.makeExecutor(worker) : null;
      const sessionFactory = this.runtime && typeof this.runtime.reopenBrain === 'function'
        ? (opts) => this.runtime.reopenBrain(opts) : null;
      const r = await this.mgr.resumeTask({ taskId, brain: null, executor, sessionFactory, maxRounds });
      this._teardown(worker, r.state);
      return { taskId, state: r.state };
    } catch (e) {
      this._teardown(worker, null);
      throw e;
    } finally {
      this._releaseLock(releaseLock);
    }
  }

  // Turn-sliced: load durable state, do ONE bounded unit, persist, return a compact
  // status. Each unit is a single Brain send or a single Codex exec or a state
  // transition, so a single node-REPL call stays well under the tool time cap.
  async advanceTask(taskId, { brain = null, executor = null, sessionFactory = null } = {}) {
    const state = this.mgr.load(taskId);
    if (state.status === 'completed' || state.status === 'cancelled') {
      return { taskId, status: state.status, progressed: false, nextAction: state.pendingControl?.control || state.lastControl };
    }
    if (this.mgr._needsRecovery(state)) {
      state.status = 'recovery_required';
      this.mgr.persist(state);
      return { taskId, status: state.status, progressed: false, nextAction: 'recovery_required' };
    }
    const lock = this._acquireLock(taskId);
    try {
      let ctx = { brain, executor, sessionFactory };
      if (state.conversationId && this.runtime && typeof this.runtime.rebindBrain === 'function') {
        ctx.brain = await this.runtime.rebindBrain(state); // never follows tabs.selected()
        ctx.sessionFactory = null;
      } else {
        ctx.brain = await this.mgr._bindBrain(ctx.brain, ctx.sessionFactory, state);
      }
      const stop = await this.mgr.advanceOne(state, ctx);
      this.mgr.persist(state);
      return { taskId, status: state.status, progressed: !stop, nextAction: state.pendingControl?.control || state.lastControl };
    } finally { this._releaseLock(lock); }
  }

  getTaskStatus(taskId) { return this.mgr.getTaskStatus(taskId); }

  async cancelTask(taskId) {
    this.locks.release(taskId);
    return this.mgr.cancelTask(taskId);
  }

  persist(state) { this.mgr.persist(state); }

  _acquireLock(taskId) {
    if (this.dataStore && typeof this.dataStore.acquireLock === 'function') return this.dataStore.acquireLock(taskId);
    return this.locks.acquire(taskId);
  }
  _releaseLock(releaseLock) { if (typeof releaseLock === 'function') releaseLock(); else if (this.dataStore && typeof this.dataStore.releaseLock === 'function') this.dataStore.releaseLock(); }

  _teardown(worker, state, allowCloseOwnedTab = true) {
    if (worker && this.runtime && typeof this.runtime.teardownWorker === 'function') {
      try { this.runtime.teardownWorker(worker, state, allowCloseOwnedTab); } catch (e) {}
    }
  }
}