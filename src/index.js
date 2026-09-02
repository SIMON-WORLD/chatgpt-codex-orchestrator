export {
  BrainSession,
  InAppBrowserTransport,
  createTabFacade,
  openBrainSession, openBrainSessionExisting, openCurrentConversation, captureCurrentConversation, reopenConversationFromBinding, ConversationIdentityMismatchError, IABUnavailableError,
} from './iab-transport.js';
export {
  AtomicTurnController,
  ComposerTimeoutError,
  ComposerUnavailableError,
  ReplyTimeoutError,
  ConversationMismatchError,
  TabLostError,
  DEFAULT_TURN_OPTIONS,
  extractConversationId,
} from './atomic-turn.js';
export { CodexExecutor, loadCodexConfig, defaultSpawn } from './codex-executor.js';
export { LoopController } from './loop-controller.js';
export { parseControl, extractDirective } from './directives.js';
export { TaskManager } from './task-manager.js';
export { TaskService } from './task-service.js';
export { TaskLock, TaskLockedError } from './task-lock.js';
export * as safety from './safety.js';
export { doctorStatic, doctorLiveIo, doctorGit, doctorIpc, doctorProviderConfig, doctorCompat, formatDoctor, DEFAULT_CODEX_JS } from './doctor.js';
export { newBrainContext, ProjectStore } from './brain-context.js';
export { PacketContextProvider } from './context-provider.js';
export { getDataRoot, DEFAULT_DATA_ROOT, runtimePaths } from './runtime-paths.js';
export { resolveDataRoot, probeWritable } from './data-root.js';
export { loadAlphaConfig, DEFAULT_ALPHA_CONFIG } from './config.js';
export * as taskState from './task-state.js';
export * as protocol from './protocol.js';
export * as verification from './verification.js';
export * as bootstrap from './bootstrap.js';
export { loadBrainCommandConfig, writeBrainCommandConfig, codexHome, brainCommandConfigPath, DEFAULT_BRAIN_COMMAND_CONFIG, BrainCommandConfigError, resolveRepoDir, resolveOrchestratorRoot, fastPreflight, fullDoctor, isBrainCommandTrigger, newBootstrapMetrics, recordBootstrapMetric, bootstrapElapsedMs, setupBrainCommand, installBrainCommandSkill, brainCommandInstalled, installedBrainCommandSkillPath, legacyBrainCommandSkillPath, sourceBrainCommandSkillPath, userHome, inferRepoRoot, discoverBroadRepoDir, markBroadDiscovery, brainCommandStatus, formatBrainCommandStatus } from './bootstrap.js';
export { resolveVerificationLevel, shouldRunFullSuite, resolveVerificationCommands, buildVerificationPlan, normalizeVerificationPolicy, canDowngrade, VERIFICATION_TIERS, TIER_RANK, VerificationPolicyError, isMandatoryBoundary, assertMandatoryVerification } from './verification.js';

export * as publish from './publish-policy.js';
export * as protocolIntegrity from './protocol-integrity.js';
export { evaluateDirectAcceptanceGate, createProofLedger, planVerification, verifyTierPrecondition, buildBootstrapEvidence, createDirectMetrics, attemptLateReplyRecovery } from './direct-governance.js';
export { createPublicationTransaction, publicationReadyForDone, buildExternalEvidence, parseRemoteRef } from './publication-transaction.js';

export { CodexWorkerClient } from './worker-client.js';
export { createChatGPTBrowserProvider, DEFAULT_DIRECT_CONFIG, DIRECT_MODE_REQUIRES, BRAIN_PROVIDERS, DEFAULT_TAKEOVER_MESSAGE, ConversationNotFoundError, ConversationAmbiguityError, newDirectTaskState, evaluatePublicationGate, evaluateDoneGate, isPublishForbiddenState } from './direct-mode.js';

export { createDirectRun, DIRECT_ALPHA4_MODE, assertDirectAlpha4Mode } from './direct-run-controller.js';

// --- v0.2 M1: Codex App Server executor (additive, non-default) ---------------
export { AppServerClient, DEFAULT_APP_SERVER_LISTEN, DEFAULT_CODEX_BIN } from './executor/app-server-client.js';
export { AppServerExecutor, TERMINAL_TURN_STATES } from './executor/app-server-executor.js';
export { JobMap, makeJobId } from './executor/job-map.js';
export { normalizeApproval, isApprovalMethod, mapDecision, approvalKind, SUPPORTED_BINARY_METHODS, APPROVAL_DECISIONS, ApprovalError, UnsupportedApprovalMethodError } from './executor/approval.js';
export { MutationOwner, MutationOwnerError, MUTATION_OWNERS } from './state/mutation-owner.js';

// --- v0.2 M2: local MCP server + read-only Direct Local (additive, non-default) ---
export { startMcpServer } from './mcp/server.js';
export { createToolsServer } from './mcp/tools.js';
export { WorkspaceRegistry, WorkspaceError, detectGitRepo } from './local/workspace.js';
export { readFile, READ_DEFAULTS } from './local/read.js';
export { search, SEARCH_DEFAULTS } from './local/search.js';
export { gitStatus, gitDiff, GIT_DIFF_MODES } from './local/git.js';

// --- v0.2 M3: bounded Direct Local edit + verify (additive, non-default) -------
export { ChangeSetService, computeSha256, EDIT_BOUNDS } from './local/change-set.js';
export { OperationState, OPERATION_STATUSES } from './state/operation-state.js';
export { VerifyService, VERIFY_EFFECTS } from './local/verify.js';
export { isBlockedMutationPath } from './local/sensitive.js';

// --- v0.2 M4: Capability Router + Governance (additive, non-default) ---------
export { CapabilityRouter, createCapabilityRouter, decideRoute, normalizeFacts, RouterError, ROUTES, FACT_KEYS, MUTATION_OWNERS as ROUTE_MUTATION_OWNERS } from './router/capability-router.js';
export { buildHandoff, validateHandoff, HANDOFF_FIELDS, HandoffError } from './state/handoff.js';
export { GovernanceService, createGovernanceService, GovernanceError, GOV_CONTROLS, GOV_ROUTES, governanceGateOk } from './governance/index.js';
