/**
 * SkillOpt-lite: bounded heuristic edits over skill guidance text.
 * Pure local optimizer — no external LLM.
 *
 * Playbook path (Experience v2): {@link applyPlaybookDelta} applies incremental
 * helpful/harmful counters and appends lessons. It never wholesale-rewrites
 * existing bullet text.
 */

import type { PlaybookBullet } from "./skill-types";
import { serializePlaybookGuidance } from "./skill-types";

export type SkillOptEditOp = "add" | "delete" | "replace";

export interface SkillOptEdit {
  op: SkillOptEditOp;
  /** 0-based line index for delete/replace; insert-after index for add. */
  lineIndex: number;
  oldText?: string;
  newText?: string;
  reason?: string;
}

export interface SkillOptInput {
  /** Current skill guidance text (multi-line bullets or prose). */
  skillText: string;
  /** Recent outcome lessons (bridge report_outcome / episode lessons). */
  lessons?: string[];
  /** Optional recent outcomes for light polarity bias. */
  outcomes?: Array<{ success: boolean; text?: string }>;
  /** Maximum accepted edits (default 3). */
  maxEdits?: number;
  /** Higher is better. Defaults to {@link defaultSkillOptScore}. */
  validate?: (candidate: string) => number;
}

export interface SkillOptResult {
  originalText: string;
  optimizedText: string;
  appliedEdits: SkillOptEdit[];
  rejectedEdits: SkillOptEdit[];
  scoreBefore: number;
  scoreAfter: number;
  improved: boolean;
}

const DEFAULT_MAX_EDITS = 3;

const STOPWORDS = new Set([
  "update",
  "readme",
  "add",
  "fix",
  "file",
  "files",
  "module",
  "the",
  "and",
  "with",
  "in",
  "a",
  "an",
  "to",
  "for",
  "of",
  "on",
  "at",
  "by",
  "from",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "or",
  "not",
  "but",
  "this",
  "that",
  "it",
  "as",
  "if",
  "do",
  "done",
  "ok",
  "success",
]);

const SYMBOL_PATTERNS: RegExp[] = [
  /[a-z0-9_./-]+\.[a-z0-9]{2,8}\b/gi,
  /\b[a-z0-9_-]+\/[a-z0-9_./-]+\b/gi,
  /[a-z]+[A-Z][a-zA-Z0-9]*/g,
  /\b[a-z0-9]+(?:_[a-z0-9]+)+\b/gi,
];

function extractSymbolTokens(text: string): string[] {
  const out = new Set<string>();
  if (!text) {
    return [];
  }
  for (const pattern of SYMBOL_PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      const token = match[0]?.trim();
      if (token) {
        out.add(token);
      }
    }
  }
  return Array.from(out);
}

function isAllStopwordPhrase(text: string): boolean {
  const tokens = text
    .toLowerCase()
    .split(/[^a-z0-9\u4e00-\u9fa5]+/i)
    .map((t) => t.trim())
    .filter(Boolean);
  return tokens.length > 0 && tokens.every((t) => STOPWORDS.has(t));
}

function splitLines(text: string): string[] {
  if (!text) {
    return [];
  }
  return text.replace(/\r\n/g, "\n").split("\n");
}

function joinLines(lines: string[]): string {
  return lines.join("\n").trim();
}

function normalizeBullet(raw: string): string {
  const trimmed = raw.trim().replace(/^[-*•]\s+/, "").trim();
  if (!trimmed) {
    return "";
  }
  return `- ${trimmed}`;
}

/**
 * Heuristic quality score: reward project-symbol evidence, penalize stopword-only noise.
 */
export function defaultSkillOptScore(text: string): number {
  const lines = splitLines(text)
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length === 0) {
    return 0;
  }
  let score = 0;
  for (const line of lines) {
    const body = line.replace(/^[-*•]\s+/, "").trim();
    if (!body) {
      continue;
    }
    if (isAllStopwordPhrase(body)) {
      score -= 2;
      continue;
    }
    const symbols = extractSymbolTokens(body);
    score += 1 + symbols.length * 2;
    score += Math.min(2, Math.floor(body.length / 40));
  }
  return score;
}

const DEFAULT_MAX_PLAYBOOK_BULLETS = 8;

function stripBulletPrefix(raw: string): string {
  return raw.trim().replace(/^[-*•]\s+/, "").trim();
}

function playbookBulletKey(text: string): string {
  return stripBulletPrefix(text).toLowerCase().replace(/\s+/g, " ");
}

function bulletsAreSimilar(a: string, b: string): boolean {
  if (a === b) {
    return true;
  }
  if (a.length >= 12 && b.length >= 12 && (a.includes(b) || b.includes(a))) {
    return true;
  }
  return false;
}

function makePlaybookId(key: string, index: number): string {
  const slug = key.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  return `pb:${slug || index}`;
}

function playbookFromGuidance(guidance: string | undefined): PlaybookBullet[] {
  if (!guidance?.trim()) {
    return [];
  }
  const bullets: PlaybookBullet[] = [];
  const seen = new Set<string>();
  for (const line of splitLines(guidance)) {
    const text = stripBulletPrefix(line);
    if (!text) {
      continue;
    }
    const key = playbookBulletKey(text);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    bullets.push({
      id: makePlaybookId(key, bullets.length),
      text,
      helpful: 0,
      harmful: 0,
    });
  }
  return bullets;
}

/**
 * Incremental playbook update: count helpful/harmful on matching bullets and
 * append new lessons. Never replaces the whole array unless it was empty.
 * Dedupes similar texts. Caps at ~8 bullets by dropping the worst score.
 */
export function applyPlaybookDelta(
  playbook: PlaybookBullet[] | undefined,
  lessons: string[],
  passed: boolean,
  maxBullets = DEFAULT_MAX_PLAYBOOK_BULLETS
): PlaybookBullet[] {
  const existing = playbook ?? [];
  const next: PlaybookBullet[] =
    existing.length > 0
      ? existing.map((bullet) => ({ ...bullet }))
      : [];
  const cleanedLessons = lessons.map((lesson) => lesson.trim()).filter((lesson) => lesson.length > 0);

  for (const lesson of cleanedLessons) {
    const key = playbookBulletKey(lesson);
    if (!key) {
      continue;
    }
    const match = next.find((bullet) => bulletsAreSimilar(playbookBulletKey(bullet.text), key));
    if (match) {
      if (passed) {
        match.helpful += 1;
      } else {
        match.harmful += 1;
      }
      continue;
    }
    next.push({
      id: makePlaybookId(key, next.length),
      text: stripBulletPrefix(lesson),
      helpful: passed ? 1 : 0,
      harmful: passed ? 0 : 1,
    });
  }

  const cap = Math.max(1, maxBullets);
  while (next.length > cap) {
    let worstIndex = 0;
    let worstScore = next[0]!.helpful - next[0]!.harmful;
    for (let i = 1; i < next.length; i += 1) {
      const score = next[i]!.helpful - next[i]!.harmful;
      if (score < worstScore) {
        worstScore = score;
        worstIndex = i;
      }
    }
    next.splice(worstIndex, 1);
  }
  return next;
}

/**
 * Seed a playbook from legacy guidance text when no bullets exist yet.
 */
export function seedPlaybookFromGuidance(guidance: string | undefined): PlaybookBullet[] {
  return playbookFromGuidance(guidance);
}

export { serializePlaybookGuidance };

function proposeEdits(input: SkillOptInput, lines: string[]): SkillOptEdit[] {
  const proposals: SkillOptEdit[] = [];
  const lessons = (input.lessons ?? [])
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .slice(0, 6);

  for (let i = 0; i < lines.length; i += 1) {
    const body = lines[i]!.replace(/^[-*•]\s+/, "").trim();
    if (body && isAllStopwordPhrase(body)) {
      proposals.push({
        op: "delete",
        lineIndex: i,
        ...(lines[i] !== undefined ? { oldText: lines[i]! } : {}),
        reason: "stopword-noise",
      });
    }
  }

  const symbolLessons = lessons.filter((l) => extractSymbolTokens(l).length > 0);
  for (let i = 0; i < lines.length; i += 1) {
    const body = lines[i]!.replace(/^[-*•]\s+/, "").trim();
    if (!body || isAllStopwordPhrase(body)) {
      continue;
    }
    if (extractSymbolTokens(body).length > 0) {
      continue;
    }
    const replacement = symbolLessons.find(
      (lesson) => normalizeBullet(lesson) !== normalizeBullet(body)
    );
    if (replacement) {
      proposals.push({
        op: "replace",
        lineIndex: i,
        ...(lines[i] !== undefined ? { oldText: lines[i]! } : {}),
        newText: normalizeBullet(replacement),
        reason: "inject-symbol-evidence",
      });
    }
  }

  const existing = new Set(
    lines
      .map((l) => l.replace(/^[-*•]\s+/, "").trim().toLowerCase())
      .filter(Boolean)
  );
  for (const lesson of lessons) {
    const key = lesson.toLowerCase();
    if (existing.has(key)) {
      continue;
    }
    if (isAllStopwordPhrase(lesson) && extractSymbolTokens(lesson).length === 0) {
      continue;
    }
    if (extractSymbolTokens(lesson).length === 0 && lesson.length < 12) {
      continue;
    }
    proposals.push({
      op: "add",
      lineIndex: lines.length - 1,
      newText: normalizeBullet(lesson),
      reason: "lesson-bullet",
    });
    existing.add(key);
  }

  const hadFailure = (input.outcomes ?? []).some((o) => !o.success);
  if (hadFailure) {
    for (let i = 0; i < lines.length; i += 1) {
      const body = lines[i]!.replace(/^[-*•]\s+/, "").trim().toLowerCase();
      if (body === "done" || body === "ok" || body === "success") {
        proposals.push({
          op: "delete",
          lineIndex: i,
          ...(lines[i] !== undefined ? { oldText: lines[i]! } : {}),
          reason: "empty-success-fluff",
        });
      }
    }
  }

  return proposals;
}

function applyEdit(lines: string[], edit: SkillOptEdit): string[] | undefined {
  const next = [...lines];
  if (edit.op === "delete") {
    if (edit.lineIndex < 0 || edit.lineIndex >= next.length) {
      return undefined;
    }
    next.splice(edit.lineIndex, 1);
    return next;
  }
  if (edit.op === "replace") {
    if (edit.lineIndex < 0 || edit.lineIndex >= next.length || !edit.newText) {
      return undefined;
    }
    next[edit.lineIndex] = edit.newText;
    return next;
  }
  if (edit.op === "add") {
    if (!edit.newText) {
      return undefined;
    }
    const insertAt = Math.min(Math.max(edit.lineIndex + 1, 0), next.length);
    next.splice(insertAt, 0, edit.newText);
    return next;
  }
  return undefined;
}

/**
 * Propose at most `maxEdits` accepted changes; rejected proposals stay in the buffer.
 */
export function optimizeSkillLite(input: SkillOptInput): SkillOptResult {
  const maxEdits = Math.max(0, input.maxEdits ?? DEFAULT_MAX_EDITS);
  const validate = input.validate ?? defaultSkillOptScore;
  const originalText = input.skillText ?? "";
  let lines = splitLines(originalText);
  const scoreBefore = validate(joinLines(lines));
  let score = scoreBefore;

  const appliedEdits: SkillOptEdit[] = [];
  const rejectedEdits: SkillOptEdit[] = [];
  const proposals = proposeEdits(input, lines);

  for (const edit of proposals) {
    if (appliedEdits.length >= maxEdits) {
      rejectedEdits.push({
        ...edit,
        ...(edit.reason ? { reason: `${edit.reason}|budget` } : { reason: "budget" }),
      });
      continue;
    }
    const candidateLines = applyEdit(lines, edit);
    if (!candidateLines) {
      rejectedEdits.push(edit);
      continue;
    }
    const candidateText = joinLines(candidateLines);
    const nextScore = validate(candidateText);
    if (nextScore > score) {
      lines = candidateLines;
      score = nextScore;
      appliedEdits.push(edit);
    } else {
      rejectedEdits.push(edit);
    }
  }

  const optimizedText = joinLines(lines);
  return {
    originalText,
    optimizedText,
    appliedEdits,
    rejectedEdits,
    scoreBefore,
    scoreAfter: score,
    improved: score > scoreBefore,
  };
}
