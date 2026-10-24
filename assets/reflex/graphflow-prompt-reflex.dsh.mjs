/**
 * GraphFlow prompt reflex for DeepSeek Harness (dsh) — Tier-2 adaptation.
 *
 * Listens to the `agent/pre-step` waterfall; on each claimed batch that
 * contains a user-authored prompt, runs `graphflow hook user-prompt`
 * (stdin: {prompt, cwd, session_id}; generic dialect):
 *   - exit 2 + stderr summary  -> macro ran locally: rewrite the batch to the
 *     summary and enter (reject carries no user-visible text in dsh), or
 *     `{kind:'reject'}` with onMacro:'reject' (summary only in the log);
 *   - exit 0 + stdout {"hookSpecificOutput":{...,"additionalContext":hint}}
 *     -> append one context message (same pattern as dsh runtime-context);
 *   - anything else            -> accept unchanged.
 * Never throws, never blocks longer than timeoutMs, no dependencies.
 * Kill switch: GRAPHFLOW_PROMPT_REFLEX=0.
 */
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

export const name = 'graphflow-prompt-reflex';

const SOURCE = 'graphflow-prompt-reflex';

export function apply(ctx, config = {}) {
  const bin = config.bin ?? 'graphflow';
  const npxArgs = config.npxArgs ?? ['-y', '--package=@roarpeng/graphflow', 'graphflow'];
  const timeoutMs = config.timeoutMs ?? 20000;
  const onMacro = config.onMacro ?? 'rewrite';

  ctx.on('agent/pre-step', async (payload, next) => {
    // Wrap first: the downstream decision (incl. the runtime-context message the
    // fallback appends) is preserved by spreading it, per the documented contract.
    const decision = await next();
    try {
      if (process.env.GRAPHFLOW_PROMPT_REFLEX === '0') return decision;
      if (decision.kind !== 'enter' || payload.signal?.aborted) return decision;

      const userMessages = decision.messages.filter((m) => m.source?.kind === 'user');
      if (userMessages.length === 0) return decision; // empty claim / mid-turn step: accept
      const prompt = userMessages
        .flatMap((m) => m.content.filter((b) => b.type === 'text').map((b) => b.text))
        .join('\n').trim();
      if (prompt === '') return decision;

      const cwd = cwdFor(ctx, payload);
      const input = JSON.stringify({ prompt, cwd, session_id: sessionId(payload) }) + '\n';
      const result = runHook(bin, npxArgs, input, cwd, timeoutMs);
      if (result === undefined) return decision; // spawn failed twice: pass through
      const { status, stdout, stderr } = result;

      if (status === 2) {
        const summary = stderr.trim() || 'GraphFlow executed a matching macro locally.';
        if (onMacro === 'reject') {
          ctx.logger.warn(`[${SOURCE}] turn blocked: ${summary}`);
          return { kind: 'reject' };
        }
        const first = userMessages[0];
        const rewritten = Object.freeze({
          ...first,
          content: Object.freeze([Object.freeze({ type: 'text', text:
            `[GraphFlow prompt reflex] Your prompt matched a macro that already ran locally:\n\n${summary}\n\nThe command above was already executed — do not run it again. Acknowledge the result briefly.` })]),
        });
        return { ...decision, messages: [rewritten, ...decision.messages.filter((m) => m.source?.kind !== 'user')] };
      }

      if (status === 0) {
        const hint = parseHint(stdout);
        if (hint === undefined) return decision; // silent allow
        const hintMessage = Object.freeze({
          role: 'user',
          id: randomUUID(), // same scheme as dsh's createUserMessage
          content: Object.freeze([Object.freeze({ type: 'text', text: `[GraphFlow context]\n${hint}` })]),
          source: Object.freeze({ kind: SOURCE }), // unknown producer kinds are documented as tolerated
        });
        return { ...decision, messages: [...decision.messages, hintMessage] };
      }

      ctx.logger.warn(`[${SOURCE}] hook exit ${String(status)}; passing prompt through`);
      return decision;
    } catch (error) {
      ctx.logger.warn(`[${SOURCE}] unexpected failure (passing through): ${error instanceof Error ? error.message : String(error)}`);
      return decision;
    }
  });
}

/** First successful spawn wins: bin, then npx fallback (Windows .cmd needs a shell). */
function runHook(bin, npxArgs, input, cwd, timeoutMs) {
  const base = { input, cwd, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 1024 * 1024, env: process.env, windowsHide: true };
  const opts = { ...base, shell: process.platform === 'win32' };
  let res = spawnSync(bin, ['hook', 'user-prompt'], opts);
  if (res.error) res = spawnSync(process.platform === 'win32' ? 'npx.cmd' : 'npx', [...npxArgs, 'hook', 'user-prompt'], opts);
  if (res.error) return undefined;
  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

function parseHint(stdout) {
  try {
    const parsed = JSON.parse(stdout);
    const hint = parsed.hookSpecificOutput?.hookEventName === 'UserPromptSubmit' ? parsed.hookSpecificOutput.additionalContext : undefined;
    return typeof hint === 'string' && hint.trim() !== '' ? hint : undefined;
  } catch { return undefined; }
}

function cwdFor(ctx, payload) {
  try {
    const wd = ctx.get('workingDirectory');
    return wd?.get(payload.agent.session) ?? process.cwd();
  } catch { return process.cwd(); }
}

function sessionId(payload) {
  return typeof payload.agent.session.id === 'string' ? payload.agent.session.id : '';
}
