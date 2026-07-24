/**
 * st-analyzer.ts — IEC 61131-3 Structured Text code analysis utility
 *
 * Extracts POU calls, data flow (variable reads/writes), and control flow
 * from ST code embedded in PLCopen XML. Called by the plcopen-xml indexer
 * to enhance its ExtractionResult.
 *
 * Integration guide for the plcopen-xml indexer:
 *
 *   import { analyzeStCode } from "./st-analyzer";
 *
 *   for (const pou of pouData) {
 *     if (pou.stCode !== undefined) {
 *       const analysis = analyzeStCode(pou.name, pou.stCode);
 *       // Merge analysis.calls into ExtractionResult.calls
 *       // Store analysis.dataFlow / analysis.controlFlow in POU symbol metadata
 *       stCalls.push(...analysis.calls);
 *     }
 *   }
 */

import type { CallRelation } from "./index.js";

// ── Exported types ───────────────────────────────────────────────────

export interface StDataFlow {
  /** Qualified source: `${pouName}.${varName}` */
  from: string;
  /** Qualified target: `${pouName}.${varName}` or `${pouName}.IF_12` for conditions */
  to: string;
  kind: "reads" | "writes";
  line: number;
}

export interface StControlFlow {
  /** Parent block name or "entry" */
  from: string;
  /** Block label, e.g. "IF_3", "FOR_8", "CASE_12" */
  to: string;
  /** Condition expression (abbreviated), if applicable */
  condition?: string;
  type: "if" | "elsif" | "else" | "for" | "while" | "repeat" | "case" | "case_entry";
  line: number;
}

export interface StAnalysisResult {
  /** POU call relations extracted from ST code */
  calls: CallRelation[];
  /** Variable-level read / write edges within the POU */
  dataFlow: StDataFlow[];
  /** High-level control structure for code understanding */
  controlFlow: StControlFlow[];
}

// ── Keyword sets ─────────────────────────────────────────────────────

/** IEC 61131-3 language keywords — never POU calls. */
const ST_KEYWORDS = new Set([
  "IF", "ELSIF", "ELSE", "THEN", "END_IF", "END_IF",
  "FOR", "TO", "BY", "DO", "END_FOR",
  "WHILE", "END_WHILE",
  "REPEAT", "UNTIL", "END_REPEAT",
  "CASE", "OF", "END_CASE",
  "RETURN", "EXIT", "CONTINUE",
  "VAR", "VAR_INPUT", "VAR_OUTPUT", "VAR_IN_OUT", "VAR_GLOBAL",
  "VAR_TEMP", "VAR_STAT", "VAR_CONFIG", "VAR_ACCESS", "VAR_EXTERNAL",
  "END_VAR",
  "FUNCTION", "FUNCTION_BLOCK", "PROGRAM",
  "END_FUNCTION", "END_FUNCTION_BLOCK", "END_PROGRAM",
  "TYPE", "END_TYPE", "STRUCT", "END_STRUCT",
  "ARRAY", "AT",
  "CONSTANT", "RETAIN", "PERSISTENT", "NON_RETAIN",
  "TRUE", "FALSE", "NULL",
  "NOT", "AND", "OR", "XOR", "MOD",
  "AND_THEN", "OR_ELSE",
  "SHR", "SHL", "ROR", "ROL",
  "ACTION", "END_ACTION",
  "TRANSITION", "END_TRANSITION",
  "STEP", "END_STEP", "INITIAL_STEP",
  "METHOD", "END_METHOD",
  "PROPERTY", "END_PROPERTY",
  "INTERFACE", "END_INTERFACE",
  "IMPLEMENTS", "EXTENDS",
  "ABSTRACT", "FINAL", "OVERRIDE",
  "SUPER", "THIS", "REF", "REF_TO",
  "CAL", "CALC", "CALCN",
  "JMP", "JMPC", "JMPCN",
  "SEL", "MAX", "MIN", "LIMIT", "MUX",
  "GT", "GE", "EQ", "LT", "LE", "NE",
  "ADD", "SUB", "MUL", "DIV", "EXPT", "MOVE",
  "ABS", "SQRT", "LN", "LOG", "EXP",
  "SIN", "COS", "TAN", "ASIN", "ACOS", "ATAN",
  "TRUNC",
  "TIME_TO_DINT", "DINT_TO_TIME",
  "BOOL_TO_INT", "INT_TO_BOOL",
  "REAL_TO_INT", "INT_TO_REAL",
]);

/** Standard IEC 61131-3 function-block type names. */
const ST_FB_TYPES = new Set([
  "TON", "TOF", "TP",
  "R_TRIG", "F_TRIG",
  "CTU", "CTD", "CTUD",
  "SR", "RS",
  "SEMA",
]);

function isStKeyword(name: string): boolean {
  const upper = name.toUpperCase();
  return ST_KEYWORDS.has(upper) || ST_FB_TYPES.has(upper);
}

// ── Comment / string stripping ───────────────────────────────────────

/**
 * Replace ST comments and string literals with equivalent whitespace
 * so line positions are preserved.  Handles:
 *   - `//` single-line comments
 *   - `(* ... *)` nested block comments
 *   - `'...'` string literals
 *   - `"..."` string literals (some compilers)
 *   - `$'...'` / `$"..."` wide strings
 */
function stripStComments(code: string): string {
  let result = "";
  let i = 0;
  while (i < code.length) {
    if (code[i] === "/" && code[i + 1] === "/") {
      while (i < code.length && code[i] !== "\n") {
        result += " ";
        i++;
      }
    } else if (code[i] === "(" && code[i + 1] === "*") {
      let depth = 1;
      result += "  ";
      i += 2;
      while (i < code.length && depth > 0) {
        if (code[i] === "(" && code[i + 1] === "*") {
          depth++;
          result += "  ";
          i += 2;
        } else if (code[i] === "*" && code[i + 1] === ")") {
          depth--;
          result += "  ";
          i += 2;
        } else {
          result += code[i] === "\n" ? "\n" : " ";
          i++;
        }
      }
    } else if (code[i] === "'" || code[i] === '"') {
      const quote = code[i]!;
      result += code[i]!;
      i++;
      while (i < code.length && code[i] !== quote) {
        result += code[i]!;
        i++;
      }
      if (i < code.length) {
        result += code[i]!;
        i++;
      }
    } else if (code[i] === "$" && i + 1 < code.length && (code[i + 1] === "'" || code[i + 1] === '"')) {
      result += code[i]!;
      result += code[i + 1]!;
      const innerQuote = code[i + 1]!;
      i += 2;
      while (i < code.length && code[i] !== innerQuote) {
        result += code[i]!;
        i++;
      }
      if (i < code.length) {
        result += code[i]!;
        i++;
      }
    } else {
      result += code[i]!;
      i++;
    }
  }
  return result;
}

// ── Condition helpers ────────────────────────────────────────────────

function extractCondition(line: string, key: string, endKey: string): string | null {
  const re = new RegExp(`${key}\\s+(.+?)\\s+${endKey}`, "i");
  const m = line.match(re);
  return m ? condAbbrev(m[1]!) : null;
}

/** Extract CASE variable:  CASE state OF  → "state" */
function extractCaseVariable(line: string): string | null {
  const m = line.match(/CASE\s+(\w+)\s+OF/i);
  return m ? condAbbrev(m[1]!) : null;
}

/** Extract FOR loop header:  FOR i := 0 TO 10 BY 1 DO  → "i=0..10" */
function extractForCond(line: string): string | null {
  const m = line.match(/FOR\s+(.+?)\s+DO/i);
  return m ? condAbbrev(m[1]!) : null;
}

/** Shorten a condition expression to ≤40 chars. */
function condAbbrev(cond: string): string {
  const s = cond.replace(/\)\(/g, ") && (").replace(/\s+/g, " ").trim();
  return s.length <= 40 ? s : s.slice(0, 37) + "...";
}

// ── Expression ident extraction ──────────────────────────────────────

function extractExpressionReads(
  dataFlow: StDataFlow[],
  expression: string,
  pouName: string,
  targetLabel: string,
  lineNum: number,
): void {
  const seen = new Set<string>();
  const re = /\b([A-Za-z_]\w*)\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(expression)) !== null) {
    const name = m[1]!;
    if (isStKeyword(name) || seen.has(name)) continue;
    seen.add(name);
    dataFlow.push({
      from: `${pouName}.${name}`,
      to: `${pouName}.${targetLabel}`,
      kind: "reads",
      line: lineNum,
    });
  }
}

/**
 * Extract ident reads from an IF / ELSIF / WHILE / UNTIL condition.
 */
function extractConditionReads(
  dataFlow: StDataFlow[],
  line: string,
  pouName: string,
  controlLabel: string,
  lineNum: number,
): void {
  const m = line.match(/(?:IF|ELSIF|WHILE|UNTIL)\s+(.+?)\s+(?:THEN|DO|END_REPEAT)/i);
  if (!m) return;
  extractExpressionReads(dataFlow, m[1]!, pouName, controlLabel, lineNum);
}

// ── Main analyzer ────────────────────────────────────────────────────

export function analyzeStCode(pouName: string, stCode: string): StAnalysisResult {
  const calls: CallRelation[] = [];
  const dataFlow: StDataFlow[] = [];
  const controlFlow: StControlFlow[] = [];

  const cleaned = stripStComments(stCode);
  const rawLines = stCode.split("\n");
  const cleanedLines = cleaned.split("\n");

  let parenDepth = 0;
  let pendingCallName: string | null = null;
  let pendingCallLine = 0;

  /** IF / ELSIF / ELSE frame stack for nesting. */
  const ifStack: Array<{ name: string; line: number }> = [];
  /** FOR / WHILE / REPEAT / CASE frame stack. */
  const loopStack: Array<{ name: string; line: number }> = [];

  // ──────────────────────────────────────────────────────────────────
  // PASS 1 — line-by-line detection
  // ──────────────────────────────────────────────────────────────────
  for (let li = 0; li < rawLines.length; li++) {
    const lineNum = li + 1;
    const cline = (cleanedLines[li] ?? "").trim();
    if (cline.length === 0) continue;

    // ── Track parentheses for multi-line call detection ──────────
    for (let ci = 0; ci < cline.length; ci++) {
      if (cline[ci] === "(") parenDepth++;
      else if (cline[ci] === ")") parenDepth--;
    }

    if (parenDepth === 0 && pendingCallName) {
      if (!isStKeyword(pendingCallName)) {
        calls.push({ callee: pendingCallName, caller: pouName, line: pendingCallLine });
      }
      pendingCallName = null;
      pendingCallLine = 0;
    }

    // ── Skip label-only lines (step1:) ──────────────────────────
    if (parenDepth === 0 && /^\w+\s*:\s*(?!:)/i.test(cline) && !cline.includes(":=")) {
      continue;
    }

    // ── Control flow ─────────────────────────────────────────────

    /* ---- IF ---- */
    if (/^IF\b/i.test(cline)) {
      const cond = extractCondition(cline, "IF", "THEN");
      const label = `IF_${lineNum}`;
      controlFlow.push({
        from: ifStack.length > 0 ? ifStack[ifStack.length - 1]!.name : "entry",
        to: label,
        ...(cond ? { condition: cond } : {}),
        type: "if",
        line: lineNum,
      });
      ifStack.push({ name: label, line: lineNum });
      extractConditionReads(dataFlow, cline, pouName, label, lineNum);
    }

    /* ---- ELSIF ---- */
    if (/^ELSIF\b/i.test(cline)) {
      const cond = extractCondition(cline, "ELSIF", "THEN");
      const label = `ELSIF_${lineNum}`;
      controlFlow.push({
        from: ifStack.length > 0 ? ifStack[ifStack.length - 1]!.name : "entry",
        to: label,
        ...(cond ? { condition: cond } : {}),
        type: "elsif",
        line: lineNum,
      });
      ifStack.push({ name: label, line: lineNum });
      extractConditionReads(dataFlow, cline, pouName, label, lineNum);
    }

    /* ---- ELSE (standalone, not ELSIF) ---- */
    if (/^ELSE\b/i.test(cline) && !/ELSIF/i.test(cline) && !/END_IF/i.test(cline)) {
      const label = `ELSE_${lineNum}`;
      controlFlow.push({
        from: ifStack.length > 0 ? ifStack[ifStack.length - 1]!.name : "entry",
        to: label,
        type: "else",
        line: lineNum,
      });
      ifStack.push({ name: label, line: lineNum });
    }

    /* ---- END_IF ---- */
    if (/^END_IF\b/i.test(cline)) {
      while (ifStack.length > 0 && !ifStack[ifStack.length - 1]!.name.startsWith("IF_")) {
        ifStack.pop();
      }
      if (ifStack.length > 0) ifStack.pop();
    }

    /* ---- CASE ---- */
    if (/^CASE\b/i.test(cline)) {
      const cond = extractCaseVariable(cline);
      const label = `CASE_${lineNum}`;
      controlFlow.push({
        from: loopStack.length > 0 ? loopStack[loopStack.length - 1]!.name : "entry",
        to: label,
        ...(cond ? { condition: cond } : {}),
        type: "case",
        line: lineNum,
      });
      loopStack.push({ name: label, line: lineNum });
    }

    /* CASE entries:  0:  /  1:  /  0..5:  */
    if (/^\s*\d+(?:\.\.\d+)?\s*:/.test(cline) && loopStack.length > 0) {
      const m = cline.match(/^\s*(\d+(?:\.\.\d+)?)\s*:/);
      if (m) {
        const entryVal = m[1]!;
        const lastCase = loopStack[loopStack.length - 1]!;
        controlFlow.push({
          from: lastCase.name,
          to: `CASE_${entryVal}_${lineNum}`,
          condition: entryVal,
          type: "case_entry",
          line: lineNum,
        });
      }
    }

    /* ---- END_CASE ---- */
    if (/^END_CASE\b/i.test(cline)) {
      while (loopStack.length > 0) {
        const top = loopStack[loopStack.length - 1]!;
        loopStack.pop();
        if (top.name.startsWith("CASE_")) break;
      }
    }

    /* ---- FOR ---- */
    if (/^FOR\b/i.test(cline)) {
      const cond = extractForCond(cline);
      const label = `FOR_${lineNum}`;
      controlFlow.push({
        from: loopStack.length > 0 ? loopStack[loopStack.length - 1]!.name : "entry",
        to: label,
        ...(cond ? { condition: cond } : {}),
        type: "for",
        line: lineNum,
      });
      loopStack.push({ name: label, line: lineNum });
    }

    /* ---- WHILE ---- */
    if (/^WHILE\b/i.test(cline)) {
      const cond = extractCondition(cline, "WHILE", "DO");
      const label = `WHILE_${lineNum}`;
      controlFlow.push({
        from: loopStack.length > 0 ? loopStack[loopStack.length - 1]!.name : "entry",
        to: label,
        ...(cond ? { condition: cond } : {}),
        type: "while",
        line: lineNum,
      });
      loopStack.push({ name: label, line: lineNum });
      extractConditionReads(dataFlow, cline, pouName, label, lineNum);
    }

    /* ---- REPEAT ---- */
    if (/^REPEAT\b/i.test(cline)) {
      const label = `REPEAT_${lineNum}`;
      controlFlow.push({
        from: loopStack.length > 0 ? loopStack[loopStack.length - 1]!.name : "entry",
        to: label,
        type: "repeat",
        line: lineNum,
      });
      loopStack.push({ name: label, line: lineNum });
    }

    /* ---- UNTIL (end of REPEAT) ---- */
    if (/^UNTIL\b/i.test(cline)) {
      extractConditionReads(dataFlow, cline, pouName, `REPEAT_${lineNum}`, lineNum);
      while (loopStack.length > 0) {
        const top = loopStack[loopStack.length - 1]!;
        loopStack.pop();
        if (top.name.startsWith("REPEAT_")) break;
      }
    }

    /* ---- END_FOR / END_WHILE / END_REPEAT ---- */
    if (/^(END_FOR|END_WHILE|END_REPEAT)\b/i.test(cline)) {
      if (loopStack.length > 0) loopStack.pop();
    }

    // ── Assignment detection ─────────────────────────────────────
    const assignMatch = cline.match(/^([\w.]+)\s*:=\s*(.+)\s*;?$/);
    if (assignMatch) {
      const targetVar = assignMatch[1]!;
      const expression = assignMatch[2]!;

      dataFlow.push({
        from: `${pouName}.${targetVar}`,
        to: `${pouName}.${targetVar}`,
        kind: "writes",
        line: lineNum,
      });

      extractExpressionReads(dataFlow, expression, pouName, targetVar, lineNum);
    }

    // ── POU call detection ──────────────────────────────────────
    if (parenDepth === 0) {
      const callRe = /([A-Za-z_]\w*)\s*\(/g;
      let cm: RegExpExecArray | null;
      while ((cm = callRe.exec(cline)) !== null) {
        const name = cm[1]!;
        if (!isStKeyword(name) && name !== pouName) {
          calls.push({ callee: name, caller: pouName, line: lineNum });
        }
      }
    } else if (!pendingCallName) {
      const callRe = /([A-Za-z_]\w*)\s*\(/g;
      let cm: RegExpExecArray | null;
      while ((cm = callRe.exec(cline)) !== null) {
        const name = cm[1]!;
        if (!isStKeyword(name)) {
          pendingCallName = name;
          pendingCallLine = lineNum;
          break;
        }
      }
    }

    // ── Field-access reads ──────────────────────────────────────
    const fieldRe = /(\w+)\.(\w+)/g;
    let fm: RegExpExecArray | null;
    while ((fm = fieldRe.exec(cline)) !== null) {
      const inst = fm[1]!;
      const field = fm[2]!;
      if (isStKeyword(inst) || isStKeyword(field)) continue;

      const full = `${inst}.${field}`;
      // Skip if this is the left-hand side of := (i.e. a write target)
      const lhs = cline.match(/^(\w+\.\w+)\s*:=/);
      if (lhs && lhs[1] === full) continue;

      dataFlow.push({
        from: `${pouName}.${inst}`,
        to: `${pouName}.${field}`,
        kind: "reads",
        line: lineNum,
      });
    }
  }

  return { calls, dataFlow, controlFlow };
}
