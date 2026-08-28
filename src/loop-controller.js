// chatgpt-codex-orchestrator: LoopController - closes the Brain <-> Codex executor loop.
// ChatGPT = planner/reviewer. Codex = executor. The loop continues until DONE or ASK_USER.
import { parseControl, extractDirective } from './directives.js';

export class LoopController {
  constructor({ brain, executor, logger = () => {}, maxTurns = 20 }) {
    this.brain = brain;         // BrainSession (send(text) -> { reply, conversationId, ... })
    this.executor = executor;   // CodexExecutor (execute(prompt) -> { resultText, success, sessionId })
    this.logger = logger;
    this.maxTurns = maxTurns;
    this.turns = 0;
    this.conversationId = null;
    this.executorSessionId = null;
  }

  async run(goal) {
    const log = [];
    this.logger('SENDING_GOAL', goal.slice(0, 120) + '...');
    let reply = (await this.brain.send(goal)).reply;
    this.conversationId = this.brain.conversationId;
    let control = parseControl(reply);
    log.push({ sender: 'chatgpt', round: 0, control, text: reply });

    while ((control === 'TASK' || control === 'REVISE') && this.turns < this.maxTurns) {
      this.turns++;
      const directive = extractDirective(reply, control);
      this.logger('EXECUTING', control + ': ' + directive.slice(0, 120) + '...');
      const res = await this.executor.execute(directive);
      this.executorSessionId = res.sessionId;
      log.push({ sender: 'codex', round: this.turns, sessionId: res.sessionId, success: res.success, result: res.resultText, error: res.error });

      const resultMessage = `Codex result (round ${this.turns}):\n${res.resultText || '(no result produced)'}`;
      this.logger('SENDING_RESULT', resultMessage.slice(0, 120) + '...');
      reply = (await this.brain.send(resultMessage)).reply;
      control = parseControl(reply);
      log.push({ sender: 'chatgpt', round: this.turns, control, text: reply });
    }

    return {
      done: control === 'DONE',
      stoppedAt: control || 'null',
      turns: this.turns,
      conversationId: this.conversationId,
      executorSessionId: this.executorSessionId,
      log,
    };
  }
}