#!/usr/bin/env node
// Deterministic stand-in executor for plumbing smoke runs of `eff-agent bench run`.
// It reads the prompt from stdin, changes nothing and answers with a fixed line,
// so oracle verdicts measure the harness (worktrees, ordering, judging), never
// agent quality. A smoke run with this executor must not be reported as a score.
let prompt = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => (prompt += chunk));
process.stdin.on("end", () => {
  process.stdout.write(`noop-agent: made no changes (prompt ${prompt.length} chars)\n`);
});
