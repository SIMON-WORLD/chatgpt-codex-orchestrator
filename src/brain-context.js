// chatgpt-codex-orchestrator: Brain Context / local project binding (Batch C2).
// A repoDir maps to one local Brain Project Profile, which can back many task
// conversations. Task State stores only a reference + a small snapshot, not whole
// context. No fragile DOM / ChatGPT project-id guessing in Alpha.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { runtimePaths } from './runtime-paths.js';
import { normalizeRepoDir } from './safety.js';

export function newBrainContext({ projectId = null, instructions = '', conversationMode = 'new', metadata = {} } = {}) {
  return { projectId, instructions, conversationMode, metadata };
}

export class ProjectStore {
  constructor({ bindDir } = {}) { this.bindDir = bindDir || runtimePaths().projects;
    this.bindDir = bindDir;
    fs.mkdirSync(this.bindDir, { recursive: true });
  }
  _key(repoDir) { return normalizeRepoDir(repoDir).replace(/[^a-zA-Z0-9]/g, '_').slice(0, 120); }
  _file(repoDir) { return path.join(this.bindDir, this._key(repoDir) + '.json'); }

  bindProject(repoDir, brainProfile) {
    const abs = normalizeRepoDir(repoDir);
    const rec = {
      version: 1,
      projectId: brainProfile.projectId || crypto.randomUUID(),
      repoDir: abs,
      brainProfile: { instructions: brainProfile.instructions || '', conversationMode: brainProfile.conversationMode || 'new', metadata: brainProfile.metadata || {} },
      boundAt: new Date().toISOString(),
    };
    fs.mkdirSync(this.bindDir, { recursive: true });
    fs.writeFileSync(this._file(abs), JSON.stringify(rec, null, 2), 'utf8');
    return rec;
  }

  getProjectBinding(repoDir) {
    const abs = normalizeRepoDir(repoDir);
    try { return JSON.parse(fs.readFileSync(this._file(abs), 'utf8')); }
    catch (e) { return null; }
  }
}