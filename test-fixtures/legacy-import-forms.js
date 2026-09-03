// chatgpt-codex-orchestrator: M6 R2 fixture for the import-isolation gate.
// This file is NOT executed or imported. It exists so the canonical import-scanner
// test can prove it detects a legacy import in EVERY form a canonical module could use:
//   1. import ... from '...'
//   2. export ... from '...'
//   3. side-effect import '...'
//   4. dynamic import('...')
import { a } from './legacy/direct-run-controller.js';
export { b } from './legacy/direct-mode.js';
import './legacy/iab-transport.js';
const m = await import('./legacy/worker-client.js');
