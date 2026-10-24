#!/usr/bin/env node
// GraphFlow Prompt Reflex adapter — Cline UserPromptSubmit.
// Maps `graphflow hook user-prompt --protocol generic` onto Cline's
// {cancel, contextModification, errorMessage}. Always exit 0; fail open.
// Managed by `graphflow install` (Cline declares hook files Unix-only).
'use strict';
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const emit = (o) => { process.stdout.write(JSON.stringify(o) + '\n'); process.exit(0); };

let input = {};
try {
  const p = JSON.parse(fs.readFileSync(0, 'utf8') || '{}');
  if (p && typeof p === 'object' && !Array.isArray(p)) input = p;
} catch {}
const prompt = typeof (input.userPromptSubmit || {}).prompt === 'string' ? input.userPromptSubmit.prompt : '';
if (!prompt.trim()) emit({ cancel: false });

// Repo root: stdin workspaceRoots first; else derive from this script's location
// (graphflow install places it at <home>/Documents/Cline/Hooks/UserPromptSubmit,
// but a workspace .clinerules/hooks copy resolves its repo root the same way
// from two levels up).
const roots = Array.isArray(input.workspaceRoots) ? input.workspaceRoots.filter((r) => typeof r === 'string') : [];
const root = roots[0] || path.resolve(__dirname, '..', '..');
// Injecting cwd makes the CLI's `.graphflow` root walk deterministic.
const payload = JSON.stringify({ prompt, cwd: root, ...(input.taskId ? { session_id: input.taskId } : {}) });

const attempts = [
  ['graphflow', ['hook', 'user-prompt', '--protocol', 'generic'], 20000],
  ['npx', ['-y', '--package=@roarpeng/graphflow', 'graphflow', 'hook', 'user-prompt', '--protocol', 'generic'], 9000],
];
let res = null;
for (const [cmd, args, ms] of attempts) {
  const r = spawnSync(cmd, args, { input: payload, encoding: 'utf8', timeout: ms, shell: process.platform === 'win32' });
  if (r.error && r.error.code === 'ENOENT') continue; // binary absent -> npx fallback
  res = r;
  break;
}
if (!res) emit({ cancel: false }); // graphflow unavailable: never block the user

if (res.status === 2) {
  // Macro executed locally (0 LLM): block the prompt, show the summary to the user.
  const summary = String(res.stderr || '').trim().slice(0, 400);
  emit({ cancel: true, errorMessage: summary || '[GraphFlow] macro executed locally' });
}
// Exit 0: surface an additionalContext hint, if any (generic dialect), under the 50KB cap.
try {
  const o = JSON.parse(String(res.stdout || '').trim() || '{}');
  const hint = o?.hookSpecificOutput?.additionalContext;
  if (typeof hint === 'string' && hint) emit({ cancel: false, contextModification: hint.slice(0, 50000) });
} catch {}
emit({ cancel: false });
