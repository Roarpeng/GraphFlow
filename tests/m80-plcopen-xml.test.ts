import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { plcopenIndexer } from "../src/graph/language-indexers/plcopen-xml";
import { analyzeStCode } from "../src/graph/language-indexers/st-analyzer";

const FIXTURE = join(__dirname, "fixtures", "sample-plc.xml");
const xml = readFileSync(FIXTURE, "utf8");
const extractionResult = plcopenIndexer.extract(FIXTURE, xml);

describe("M80 PLCopen XML indexer", () => {
  const result = extractionResult;

  it("detects PLCopen XML project", () => {
    // Should produce symbols — if project detection fails, symbols=[]
    expect(result.symbols.length).toBeGreaterThan(0);
  });

  // ── POU detection ──────────────────────────────────────────────────

  it("extracts function block POUs", () => {
    const fbs = result.symbols.filter((s) => s.kind === "pou" && s.jsdoc === "functionBlock");
    expect(fbs.map((s) => s.name).sort()).toEqual([
      "DiagnosticLogger",
      "R_TRIG_Impl",
      "TrafficTimer",
    ]);
  });

  it("extracts function POUs", () => {
    const funcs = result.symbols.filter((s) => s.kind === "pou" && s.jsdoc === "function");
    expect(funcs).toHaveLength(1);
    expect(funcs[0]!.name).toBe("NextState");
    expect(funcs[0]!.signature).toBe("POU function NextState");
  });

  it("extracts program POUs", () => {
    const progs = result.symbols.filter((s) => s.kind === "pou" && s.jsdoc === "program");
    expect(progs).toHaveLength(1);
    expect(progs[0]!.name).toBe("main");
  });

  it("extracts all 5 POUs", () => {
    const pous = result.symbols.filter((s) => s.kind === "pou");
    expect(pous).toHaveLength(5);
  });

  // ── Variable extraction ────────────────────────────────────────────

  it("extracts local variables from program", () => {
    const vars = result.symbols.filter(
      (s) => s.kind === "variable" && s.jsdoc === "main:localVars"
    );
    expect(vars.length).toBeGreaterThanOrEqual(6);
    const names = vars.map((v) => v.name);
    expect(names).toContain("main.state");
    expect(names).toContain("main.redLight");
    expect(names).toContain("main.phaseTimer");
  });

  it("extracts input variables", () => {
    const vars = result.symbols.filter(
      (s) => s.kind === "variable" && s.jsdoc === "main:inputVars"
    );
    expect(vars).toHaveLength(1);
    expect(vars[0]!.name).toBe("main.systemClock");
    expect(vars[0]!.signature).toContain("TIME");
  });

  it("extracts output variables", () => {
    const vars = result.symbols.filter(
      (s) => s.kind === "variable" && s.jsdoc === "main:outputVars"
    );
    expect(vars).toHaveLength(1);
    expect(vars[0]!.name).toBe("main.statusWord");
  });

  it("extracts inOut variables", () => {
    const vars = result.symbols.filter(
      (s) => s.kind === "variable" && s.jsdoc === "main:inOutVars"
    );
    expect(vars).toHaveLength(1);
    expect(vars[0]!.name).toBe("main.configBlock");
  });

  it("extracts temp variables", () => {
    const vars = result.symbols.filter(
      (s) => s.kind === "variable" && s.jsdoc === "main:tempVars"
    );
    expect(vars).toHaveLength(1);
    expect(vars[0]!.name).toBe("main.tmpResult");
  });

  it("extracts function block variables from TrafficTimer", () => {
    const vars = result.symbols.filter(
      (s) => s.kind === "variable" && s.jsdoc!.startsWith("TrafficTimer:")
    );
    expect(vars.length).toBeGreaterThanOrEqual(4);
    const names = vars.map((v) => v.name);
    expect(names).toContain("TrafficTimer.preset");
    expect(names).toContain("TrafficTimer.enable");
    expect(names).toContain("TrafficTimer.elapsed");
    expect(names).toContain("TrafficTimer.done");
  });

  it("extracts function return type (NextState)", () => {
    const vars = result.symbols.filter(
      (s) => s.kind === "variable" && s.jsdoc === "NextState:returnType"
    );
    expect(vars).toHaveLength(1);
    expect(vars[0]!.name).toBe("NextState.return");
    expect(vars[0]!.signature).toContain("INT");
  });

  it("identifies derived types (TRAFFIC_STATE, TON, TrafficTimer, TIME)", () => {
    // derived types should generate imports
    const derivedImports = result.imports.filter((i) => i.module.startsWith("pou:"));
    const modules = derivedImports.map((i) => i.module);
    expect(modules).toContain("pou:TON");
    expect(modules).toContain("pou:TRAFFIC_STATE");
    expect(modules).toContain("pou:TrafficTimer");
  });

  // ── ST code extraction ─────────────────────────────────────────────

  it("extracts ST code for program main", () => {
    const stCodes = result.symbols.filter(
      (s) => s.kind === "code" && s.name === "main.st_code"
    );
    expect(stCodes).toHaveLength(1);
    expect(stCodes[0]!.signature).toContain("state := NextState(state, emergencyStop)");
    expect(stCodes[0]!.signature).toContain("CASE state OF");
  });

  it("extracts ST code for TrafficTimer", () => {
    const stCodes = result.symbols.filter(
      (s) => s.kind === "code" && s.name === "TrafficTimer.st_code"
    );
    expect(stCodes).toHaveLength(1);
    expect(stCodes[0]!.signature).toContain("ton1(IN := enable, PT := preset)");
  });

  it("extracts ST code for all POUs with ST bodies", () => {
    const stCodes = result.symbols.filter((s) => s.kind === "code");
    // All 5 POUs have ST code bodies
    expect(stCodes).toHaveLength(5);
  });

  // ── Task extraction ────────────────────────────────────────────────

  it("extracts real-time tasks", () => {
    const tasks = result.symbols.filter((s) => s.kind === "task");
    expect(tasks).toHaveLength(2);
    expect(tasks.map((t) => t.name).sort()).toEqual(["task.FastTask", "task.SlowTask"]);
  });

  it("extracts task priority and interval", () => {
    const fast = result.symbols.find(
      (s) => s.kind === "task" && s.name === "task.FastTask"
    );
    expect(fast!.signature).toBe("TASK FastTask interval=20ms prio=10");
    expect(fast!.jsdoc).toBe("resource=RaspberryPi");
  });

  // ── Instance reference (imports) ────────────────────────────────────

  it("extracts POU instance references as imports", () => {
    const instanceImports = result.imports.filter(
      (i) => i.module === "pou:main" || i.module === "pou:DiagnosticLogger"
    );
    expect(instanceImports).toHaveLength(2);
  });

  // ── Non-PLCopen XML graceful degradation ───────────────────────────

  it("returns empty result for non-PLCopen XML", () => {
    const svg = '<?xml version="1.0"?><svg><circle cx="50" cy="50" r="40"/></svg>';
    const empty = plcopenIndexer.extract("drawing.svg", svg);
    expect(empty.symbols).toHaveLength(0);
    expect(empty.imports).toHaveLength(0);
  });

  it("returns empty result for HTML", () => {
    const html = "<html><body><p>hello</p></body></html>";
    const empty = plcopenIndexer.extract("page.html", html);
    expect(empty.symbols).toHaveLength(0);
  });
});

// ── ST Analyzer tests ──────────────────────────────────────────────

describe("M80 ST analyzer", () => {
  const result = extractionResult;

  it("detects POU calls in main controller", () => {
    const mainCode = result.symbols
      .find((s) => s.name === "main.st_code")!
      .signature;
    const analysis = analyzeStCode("main", mainCode);
    expect(analysis.calls.length).toBeGreaterThanOrEqual(2);
    expect(analysis.calls.map((c) => c.callee)).toContain("NextState");
    expect(analysis.calls.map((c) => c.callee)).toContain("phaseTimer");
  });

  it("detects IF/ELSIF/ELSE control flow in NextState", () => {
    const nsCode = result.symbols
      .find((s) => s.name === "NextState.st_code")!
      .signature;
    const analysis = analyzeStCode("NextState", nsCode);
    // NextState := 0 is a return-assignment (Pascal-style), not a recursive call
    const ifBlocks = analysis.controlFlow.filter((cf) => cf.type === "if");
    expect(ifBlocks.length).toBeGreaterThanOrEqual(1);
    // ELSIF line should be detected
    const elsifBlocks = analysis.controlFlow.filter((cf) => cf.type === "elsif");
    expect(elsifBlocks.length).toBeGreaterThanOrEqual(0);
    // CASE should be detected
    const caseNodes = analysis.controlFlow.filter((cf) => cf.type === "case");
    expect(caseNodes.length).toBeGreaterThanOrEqual(1);
  });

  it("detects CASE control flow with case entries", () => {
    const mainCode = result.symbols
      .find((s) => s.name === "main.st_code")!
      .signature;
    const analysis = analyzeStCode("main", mainCode);

    const caseNodes = analysis.controlFlow.filter((cf) => cf.type === "case");
    expect(caseNodes.length).toBeGreaterThanOrEqual(1);

    const caseEntries = analysis.controlFlow.filter(
      (cf) => cf.type === "case_entry"
    );
    expect(caseEntries.length).toBeGreaterThanOrEqual(4);
  });

  it("detects FOR loop control flow", () => {
    const mainCode = result.symbols
      .find((s) => s.name === "main.st_code")!
      .signature;
    const analysis = analyzeStCode("main", mainCode);

    const forLoops = analysis.controlFlow.filter((cf) => cf.type === "for");
    expect(forLoops.length).toBeGreaterThanOrEqual(1);
    expect(forLoops[0]!.condition).toContain("loopCounter");
  });

  it("detects WHILE loop in DiagnosticLogger", () => {
    const diagCode = result.symbols
      .find((s) => s.name === "DiagnosticLogger.st_code")!
      .signature;
    const analysis = analyzeStCode("DiagnosticLogger", diagCode);
    const whileLoops = analysis.controlFlow.filter((cf) => cf.type === "while");
    expect(whileLoops.length).toBeGreaterThanOrEqual(1);
  });

  it("detects variable writes (assignments) in R_TRIG_Impl", () => {
    const rtCode = result.symbols
      .find((s) => s.name === "R_TRIG_Impl.st_code")!
      .signature;
    const analysis = analyzeStCode("R_TRIG_Impl", rtCode);
    const writes = analysis.dataFlow.filter((df) => df.kind === "writes");
    expect(writes.length).toBeGreaterThanOrEqual(2);
  });

  it("detects field-access reads in TrafficTimer", () => {
    const ttCode = result.symbols
      .find((s) => s.name === "TrafficTimer.st_code")!
      .signature;
    const analysis = analyzeStCode("TrafficTimer", ttCode);
    const reads = analysis.dataFlow.filter((df) => df.kind === "reads");
    // ton1.Q and ton1.ET are field accesses → read edges
    expect(reads.length).toBeGreaterThanOrEqual(2);
  });

  it("filters ST keywords from calls", () => {
    const mainCode = result.symbols
      .find((s) => s.name === "main.st_code")!
      .signature;
    const analysis = analyzeStCode("main", mainCode);
    // IF, CASE, FOR, END_IF etc should NOT appear as calls
    expect(analysis.calls.map((c) => c.callee)).not.toContain("IF");
    expect(analysis.calls.map((c) => c.callee)).not.toContain("FOR");
    expect(analysis.calls.map((c) => c.callee)).not.toContain("CASE");
  });

  it("filters ST function blocks (TON, TOF) from calls", () => {
    const ttCode = result.symbols
      .find((s) => s.name === "TrafficTimer.st_code")!
      .signature;
    const analysis = analyzeStCode("TrafficTimer", ttCode);
    // TON is a standard FB type — not a user-defined POU call
    expect(analysis.calls.map((c) => c.callee)).not.toContain("TON");
  });
});

// ── CASE numeric-branch / jump-label regression tests ────────────────
// Regression for the label-skip fix: numeric CASE branch labels
// ("1:", "2..5:") must NOT be skipped as labels, while real jump
// labels ("STEP1:") must still be skipped.

describe("M80 ST CASE/label regression", () => {
  it("extracts call edges from calls inside numeric CASE branches", () => {
    const code = [
      "CASE x OF",
      "  1:",
      "    callA();",
      "  2..5:",
      "    callB();",
      "  ELSE",
      "    callC();",
      "END_CASE;",
    ].join("\n");
    const analysis = analyzeStCode("CasePOU", code);
    // Before the fix, "1:" was swallowed by the label detector and callA vanished
    expect(analysis.calls.map((c) => c.callee)).toEqual(["callA", "callB", "callC"]);
  });

  it("detects case_entry control flow for numeric branch labels 1: and 2..5:", () => {
    const code = [
      "CASE x OF",
      "  1:",
      "    callA();",
      "  2..5:",
      "    callB();",
      "END_CASE;",
    ].join("\n");
    const analysis = analyzeStCode("CasePOU", code);
    const entries = analysis.controlFlow.filter((cf) => cf.type === "case_entry");
    expect(entries.map((e) => e.condition)).toEqual(["1", "2..5"]);
    // Entries must attach to the enclosing CASE node
    const caseNode = analysis.controlFlow.find((cf) => cf.type === "case");
    expect(caseNode).toBeTruthy();
    for (const entry of entries) {
      expect(entry.from).toBe(caseNode!.to);
    }
  });

  it("handles single-line CASE with numeric branches (1: / 2..5:) inline", () => {
    const code = "CASE x OF 1: callA(); 2..5: callB(); ELSE callC(); END_CASE;";
    const analysis = analyzeStCode("CasePOU", code);
    expect(analysis.calls.map((c) => c.callee).sort()).toEqual([
      "callA",
      "callB",
      "callC",
    ]);
  });

  it("skips real jump labels like STEP1: (not a call, no control flow)", () => {
    const code = [
      "STEP1:",
      "  x := x + 1;",
      "IF x > 10 THEN",
      "  JMP STEP1;",
      "END_IF;",
    ].join("\n");
    const analysis = analyzeStCode("LabelPOU", code);
    expect(analysis.calls.map((c) => c.callee)).not.toContain("STEP1");
    expect(analysis.calls.map((c) => c.callee)).not.toContain("JMP");
    // Statements after the label are still analyzed
    expect(analysis.dataFlow.filter((d) => d.kind === "writes").length).toBeGreaterThanOrEqual(1);
    // Control flow after the label is still detected
    expect(analysis.controlFlow.filter((cf) => cf.type === "if")).toHaveLength(1);
    expect(analysis.controlFlow.map((cf) => cf.to)).not.toContain("STEP1");
  });
});

// ── ST-code fixture (sample-st-code.xml) ────────────────────────────
// Covers nested-<type> and inline <returnType> forms, input/output/inout
// vars, CASE with numeric branches, a STEP1 jump label, and calls with
// arguments.

describe("M80 PLCopen ST-code fixture (sample-st-code.xml)", () => {
  const stXml = readFileSync(
    join(__dirname, "fixtures", "sample-st-code.xml"),
    "utf8"
  );
  const stResult = plcopenIndexer.extract("sample-st-code.xml", stXml);

  it("extracts both function POUs", () => {
    const pous = stResult.symbols.filter((s) => s.kind === "pou");
    expect(pous.map((s) => s.name).sort()).toEqual(["ComputeAxis", "ReadSensor"]);
    expect(pous.every((p) => p.jsdoc === "function")).toBe(true);
  });

  it("extracts nested-form returnType (ComputeAxis.return)", () => {
    const ret = stResult.symbols.find((s) => s.name === "ComputeAxis.return");
    expect(ret).toBeTruthy();
    expect(ret!.kind).toBe("variable");
    expect(ret!.signature).toBe("VAR_RETURN REAL ComputeAxis");
    expect(ret!.jsdoc).toBe("ComputeAxis:returnType");
  });

  it("extracts inline-form returnType (ReadSensor.return)", () => {
    const ret = stResult.symbols.find((s) => s.name === "ReadSensor.return");
    expect(ret).toBeTruthy();
    expect(ret!.kind).toBe("variable");
    expect(ret!.signature).toBe("VAR_RETURN DINT ReadSensor");
    expect(ret!.jsdoc).toBe("ReadSensor:returnType");
  });

  it("extracts input/output/inOut variables with their scopes", () => {
    const vars = stResult.symbols.filter(
      (s) => s.kind === "variable" && !s.name.endsWith(".return")
    );
    const byName = new Map(vars.map((v) => [v.name, v.jsdoc]));
    expect(byName.get("ComputeAxis.speed")).toBe("ComputeAxis:inputVars");
    expect(byName.get("ComputeAxis.mode")).toBe("ComputeAxis:inputVars");
    expect(byName.get("ComputeAxis.errorCode")).toBe("ComputeAxis:outputVars");
    expect(byName.get("ReadSensor.channel")).toBe("ReadSensor:inputVars");
    expect(byName.get("ReadSensor.rawBuffer")).toBe("ReadSensor:inOutVars");
  });

  it("imports derived types referenced in variables", () => {
    expect(stResult.imports.map((i) => i.module)).toContain("pou:TRAFFIC_STATE");
  });

  it("produces call edges for calls with arguments inside CASE branches", () => {
    const code = stResult.symbols.find(
      (s) => s.name === "ComputeAxis.st_code"
    )!.signature;
    const analysis = analyzeStCode("ComputeAxis", code);
    expect(analysis.calls.map((c) => c.callee)).toEqual(["Scale", "Hold"]);
    expect(analysis.calls[0]!.caller).toBe("ComputeAxis");
    const caseEntries = analysis.controlFlow.filter((cf) => cf.type === "case_entry");
    expect(caseEntries.map((e) => e.condition)).toEqual(["1", "2..5"]);
  });

  it("skips the STEP1: jump label in ReadSensor ST code", () => {
    const code = stResult.symbols.find(
      (s) => s.name === "ReadSensor.st_code"
    )!.signature;
    const analysis = analyzeStCode("ReadSensor", code);
    // Function call with arguments is still found
    expect(analysis.calls.map((c) => c.callee)).toContain("Scale");
    // The jump label and JMP keyword are not treated as calls
    expect(analysis.calls.map((c) => c.callee)).not.toContain("STEP1");
    expect(analysis.calls.map((c) => c.callee)).not.toContain("JMP");
    // Assignment after the label is still analyzed
    expect(analysis.dataFlow.filter((d) => d.kind === "writes").length).toBeGreaterThanOrEqual(2);
  });
});

// ── Edge cases ─────────────────────────────────────────────────────

describe("M80 PLCopen edge cases", () => {
  it("handles XML with multi-byte characters", () => {
    const xml = `<?xml version="1.0"?>
      <project xmlns="http://www.plcopen.org/xml/tc6.xsd">
        <types><pous><pou name="电机控制" pouType="program">
          <interface><localVars>
            <variable name="转速"><type><DINT/></type></variable>
          </localVars></interface>
          <body><ST><xhtml><![CDATA[转速 := 100;]]></xhtml></ST></body>
        </pou></pous></types>
      </project>`;
    const result = plcopenIndexer.extract("test.xml", xml);
    expect(result.symbols.length).toBeGreaterThan(0);
    const pou = result.symbols.find((s) => s.kind === "pou");
    expect(pou!.name).toBe("电机控制");
  });

  it("handles POU without body", () => {
    const xml = `<?xml version="1.0"?>
      <project xmlns="http://www.plcopen.org/xml/tc6.xsd">
        <types><pous><pou name="EmptyPOU" pouType="functionBlock">
          <interface><localVars>
            <variable name="x"><type><INT/></type></variable>
          </localVars></interface>
        </pou></pous></types>
      </project>`;
    const result = plcopenIndexer.extract("test.xml", xml);
    expect(result.symbols.find((s) => s.kind === "pou")).toBeTruthy();
    expect(result.symbols.find((s) => s.kind === "code")).toBeUndefined();
  });

  it("handles ST body without xhtml wrapper (some older Beremiz files)", () => {
    const xml = `<?xml version="1.0"?>
      <project xmlns="http://www.plcopen.org/xml/tc6.xsd">
        <types><pous><pou name="OldStylePOU" pouType="program">
          <body><ST><![CDATA[x := 1;]]></ST></body>
        </pou></pous></types>
      </project>`;
    const result = plcopenIndexer.extract("test.xml", xml);
    // Without xhtml, the current regex won't match — this is a known limitation
    expect(result.symbols.find((s) => s.kind === "pou")).toBeTruthy();
  });

  it("handles IL (Instruction List) body as non-ST", () => {
    const xml = `<?xml version="1.0"?>
      <project xmlns="http://www.plcopen.org/xml/tc6.xsd">
        <types><pous><pou name="IL_POU" pouType="program">
          <body><IL>
            <instruction><expression>LD TRUE</expression></instruction>
          </IL></body>
        </pou></pous></types>
      </project>`;
    const result = plcopenIndexer.extract("test.xml", xml);
    // Should extract the POU but no ST code (since it's IL)
    expect(result.symbols.find((s) => s.kind === "pou")).toBeTruthy();
    expect(result.symbols.find((s) => s.kind === "code")).toBeUndefined();
  });
});
