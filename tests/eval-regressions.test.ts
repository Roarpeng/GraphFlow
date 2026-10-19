/**
 * GraphFlow 3.6.2 regressions from the graphflow-eval 3.6.1 run:
 * qualified rename + override hierarchy, Rust macro/`impl Trait` blast,
 * doc↔code link precision, read budget, auto instruction log, MISS Jaccard,
 * and structural MCP task-run exit codes.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  TASK_LOG_REL_PATH,
  V3_TOOL_DEFINITIONS,
  autoLogExecutedCommand,
  buildDocCodeLinks,
  computeBlastRadius,
  executeSurgicalEdit,
  executeSurgicalRead,
  executeV3ToolCall,
  getToolDefinitions,
  getWorkspaceAstIndex,
  interceptPostToolUse,
  listTasks,
  recordTaskUse,
  runTask,
} from "../src/index.js";

let passed = 0;
let failed = 0;

function check(name: string, fn: () => void): void {
  try {
    fn();
    passed += 1;
    console.log(`  PASS ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`  FAIL ${name}`);
    console.error(err);
  }
}

function writeFile(root: string, relPath: string, content: string): void {
  const abs = join(root, relPath);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, content, "utf8");
}

function tempRoot(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

check("qualified rename updates the base method and super call, not the override or a foreign class", () => {
  const root = tempRoot("gf-rename-qual-");
  try {
    writeFile(
      root,
      "order-service.ts",
      [
        "export class OrderService {",
        "  cancel(order: string): string {",
        "    return order;",
        "  }",
        "}",
        "",
      ].join("\n")
    );
    writeFile(
      root,
      "vip-order-service.ts",
      [
        "import { OrderService } from './order-service';",
        "export class VipOrderService extends OrderService {",
        "  override cancel(order: string): string {",
        "    return super.cancel(order);",
        "  }",
        "}",
        "",
      ].join("\n")
    );
    writeFile(
      root,
      "refund-service.ts",
      [
        "export class RefundService {",
        "  cancel(order: string): string {",
        "    return order;",
        "  }",
        "}",
        "",
      ].join("\n")
    );
    writeFile(
      root,
      "checkout.ts",
      [
        "import { OrderService } from './order-service';",
        "export function checkout(orders: OrderService, order: string): string {",
        "  return orders.cancel(order);",
        "}",
        "",
      ].join("\n")
    );
    writeFile(
      root,
      "vip-desk.ts",
      [
        "import { VipOrderService } from './vip-order-service';",
        "export function desk(vip: VipOrderService, order: string): string {",
        "  return vip.cancel(order);",
        "}",
        "",
      ].join("\n")
    );
    const refundBefore = readFileSync(join(root, "refund-service.ts"), "utf8");
    const deskBefore = readFileSync(join(root, "vip-desk.ts"), "utf8");

    const renamed = executeSurgicalEdit({
      rootDir: root,
      file: "order-service.ts",
      symbol: "OrderService.cancel",
      renameTo: "cancelOrder",
    });
    assert.equal(renamed.ok, true, renamed.text);
    const order = readFileSync(join(root, "order-service.ts"), "utf8");
    const vip = readFileSync(join(root, "vip-order-service.ts"), "utf8");
    const checkout = readFileSync(join(root, "checkout.ts"), "utf8");
    assert.match(order, /cancelOrder\(order: string\)/);
    assert.doesNotMatch(order, /\bcancel\(order/);
    assert.match(vip, /override cancel\(order: string\)/);
    assert.match(vip, /super\.cancelOrder\(order\)/);
    assert.doesNotMatch(vip, /super\.cancel\(/);
    assert.match(checkout, /orders\.cancelOrder\(order\)/);
    assert.equal(readFileSync(join(root, "refund-service.ts"), "utf8"), refundBefore);
    assert.equal(readFileSync(join(root, "vip-desk.ts"), "utf8"), deskBefore);
    assert.ok(renamed.touchedFiles.includes("vip-order-service.ts"), renamed.text);
    assert.ok(!renamed.touchedFiles.includes("refund-service.ts"), renamed.text);
    assert.ok(!renamed.touchedFiles.includes("vip-desk.ts"), renamed.text);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

check("unqualified rename of a unique base method is not rejected because a subclass overrides it", () => {
  const root = tempRoot("gf-rename-bare-");
  try {
    writeFile(
      root,
      "order-service.ts",
      "export class OrderService {\n  cancel(order: string): string { return order; }\n}\n"
    );
    writeFile(
      root,
      "vip-order-service.ts",
      [
        "import { OrderService } from './order-service';",
        "export class VipOrderService extends OrderService {",
        "  override cancel(order: string): string { return super.cancel(order); }",
        "}",
        "",
      ].join("\n")
    );
    const renamed = executeSurgicalEdit({
      rootDir: root,
      file: "order-service.ts",
      symbol: "cancel",
      renameTo: "cancelOrder",
    });
    assert.equal(renamed.ok, true, renamed.text);
    assert.doesNotMatch(renamed.text, /ambiguous-symbol/);
    const vip = readFileSync(join(root, "vip-order-service.ts"), "utf8");
    assert.match(vip, /override cancel\(/);
    assert.match(vip, /super\.cancelOrder\(/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

check("Python qualified rename follows super().refund and leaves the override declaration", () => {
  const root = tempRoot("gf-rename-py-");
  try {
    writeFile(
      root,
      "billing/refund.py",
      [
        "class RefundPolicy:",
        "    def refund(self, amount: int) -> int:",
        "        return amount",
        "",
      ].join("\n")
    );
    writeFile(
      root,
      "billing/partial.py",
      [
        "from billing.refund import RefundPolicy",
        "",
        "class PartialRefundPolicy(RefundPolicy):",
        "    def refund(self, amount: int) -> int:",
        "        return super().refund(amount)",
        "",
      ].join("\n")
    );
    writeFile(
      root,
      "billing/settle_full.py",
      [
        "from billing.refund import RefundPolicy",
        "",
        "def settle_full(policy: RefundPolicy, amount: int) -> int:",
        "    return policy.refund(amount)",
        "",
      ].join("\n")
    );
    writeFile(
      root,
      "billing/settle_partial.py",
      [
        "from billing.partial import PartialRefundPolicy",
        "",
        "def settle_partial(policy: PartialRefundPolicy, amount: int) -> int:",
        "    return policy.refund(amount)",
        "",
      ].join("\n")
    );
    const partialBeforeCalls = readFileSync(join(root, "billing/settle_partial.py"), "utf8");
    const read = executeSurgicalRead({
      rootDir: root,
      targets: ["billing/refund.py#RefundPolicy.refund"],
      includeCallers: true,
    });
    assert.match(read.text, /super\(\)\.refund/);
    assert.match(read.text, /in settle_full\(\)/);
    assert.doesNotMatch(read.text, /settle_partial/);

    const renamed = executeSurgicalEdit({
      rootDir: root,
      file: "billing/refund.py",
      symbol: "RefundPolicy.refund",
      renameTo: "refundInvoice",
    });
    assert.equal(renamed.ok, true, renamed.text);
    const refund = readFileSync(join(root, "billing/refund.py"), "utf8");
    const partial = readFileSync(join(root, "billing/partial.py"), "utf8");
    const full = readFileSync(join(root, "billing/settle_full.py"), "utf8");
    assert.match(refund, /def refundInvoice\(/);
    assert.match(partial, /def refund\(/);
    assert.match(partial, /super\(\)\.refundInvoice\(/);
    assert.match(full, /policy\.refundInvoice\(/);
    assert.equal(readFileSync(join(root, "billing/settle_partial.py"), "utf8"), partialBeforeCalls);
    assert.ok(!renamed.touchedFiles.some((file) => file.endsWith("settle_partial.py")), renamed.text);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

check("Rust impl Trait calls inside macros are in the trait method blast radius", () => {
  const root = tempRoot("gf-rust-impl-");
  try {
    writeFile(
      root,
      "src/device.rs",
      [
        "pub trait Device {",
        "    fn read(&self) -> i32;",
        "    fn id(&self) -> String;",
        "}",
        "",
        "pub struct Sensor;",
        "",
        "impl Device for Sensor {",
        "    fn read(&self) -> i32 { 1 }",
        "    fn id(&self) -> String { String::from(\"s\") }",
        "}",
        "",
      ].join("\n")
    );
    writeFile(
      root,
      "src/dispatch.rs",
      [
        "use crate::device::{Device, Sensor};",
        "",
        "pub fn poll_reading(device: &dyn Device) -> i32 {",
        "    device.read()",
        "}",
        "",
        "pub fn describe(device: impl Device) -> String {",
        "    format!(\"{}={}\", device.id(), device.read())",
        "}",
        "",
        "pub fn sensor_reading(sensor: &Sensor) -> i32 {",
        "    sensor.read()",
        "}",
        "",
      ].join("\n")
    );
    const index = getWorkspaceAstIndex(root);
    const deviceBlast = computeBlastRadius(index, "src/device.rs", "Device.read", 20);
    const deviceCallers = deviceBlast.callSites.map((site) => site.caller).filter(Boolean);
    assert.ok(deviceCallers.includes("poll_reading"), `dyn caller missing: ${JSON.stringify(deviceBlast.callSites)}`);
    assert.ok(deviceCallers.includes("describe"), `impl Trait macro caller missing: ${JSON.stringify(deviceBlast.callSites)}`);
    assert.ok(!deviceCallers.includes("sensor_reading"), `concrete impl leaked onto the trait: ${deviceCallers.join(",")}`);

    const sensorBlast = computeBlastRadius(index, "src/device.rs", "Sensor.read", 20);
    const sensorCallers = sensorBlast.callSites.map((site) => site.caller).filter(Boolean);
    assert.ok(sensorCallers.includes("sensor_reading"), `impl caller missing: ${JSON.stringify(sensorBlast.callSites)}`);
    assert.ok(!sensorCallers.includes("describe"), `describe must stay on the trait: ${sensorCallers.join(",")}`);
    assert.ok(!sensorCallers.includes("poll_reading"), `poll_reading must stay on the trait: ${sensorCallers.join(",")}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

check("doc links keep constants, skip generic buyer words, and cap a section at 3", () => {
  const root = tempRoot("gf-doclink-");
  try {
    writeFile(
      root,
      "src/order-service.ts",
      [
        "export function handleDingDanChaoShi(order: string): string {",
        "  return order;",
        "}",
        "",
        "export const TIMEOUT_WINDOW_MS = 30 * 60 * 1000;",
        "",
        "export class OrderService {",
        "  timeout(order: string): string { return order; }",
        "  cancel(order: string): string { return order; }",
        "  pay(order: string): string { return order; }",
        "}",
        "",
      ].join("\n")
    );
    writeFile(
      root,
      "tests/test_refund.py",
      [
        "class RefundTests:",
        "    def setUp(self):",
        "        self.buyer = '买家丙'",
        "",
      ].join("\n")
    );
    writeFile(
      root,
      "docs/订单超时.md",
      [
        "# 订单超时",
        "",
        "## 关单路径",
        "",
        "未支付订单由 `handleDingDanChaoShi` 调用 `OrderService.timeout`。",
        "窗口常量是 `TIMEOUT_WINDOW_MS`（30 分钟）。",
        "",
        "## 业务背景",
        "",
        "超时之后买家不能再付款。客服常见问法是怎么取消、能不能退款，",
        "但本页只定义关单，不展开那些流程。",
        "",
      ].join("\n")
    );
    const index = getWorkspaceAstIndex(root);
    const links = buildDocCodeLinks(index).filter((link) => link.docPath.endsWith("订单超时.md"));
    const section = links.filter((link) => link.sectionTitle === "关单路径");
    const names = section.map((link) => link.symbolName).sort();
    assert.ok(names.includes("handleDingDanChaoShi"), `missing handler: ${JSON.stringify(links)}`);
    assert.ok(names.includes("timeout"), `missing method: ${JSON.stringify(links)}`);
    assert.ok(names.includes("TIMEOUT_WINDOW_MS"), `missing constant: ${JSON.stringify(links)}`);
    assert.ok(section.length <= 3, `section cap exceeded: ${JSON.stringify(section)}`);
    assert.equal(
      links.filter((link) => link.sectionTitle === "业务背景").length,
      0,
      `generic section linked: ${JSON.stringify(links)}`
    );
    assert.ok(!links.some((link) => link.symbolName === "setUp"), `test symbol linked: ${JSON.stringify(links)}`);
    assert.ok(!links.some((link) => link.symbolName === "cancel"), `cancel must not link: ${JSON.stringify(links)}`);
    assert.ok(links.length <= 3, `doc emitted ${links.length} edges`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

check("read budget trims oversized slices and can be disabled", () => {
  const root = tempRoot("gf-budget-");
  const previous = process.env.GRAPHFLOW_READ_BUDGET_RATIO;
  try {
    const body = Array.from({ length: 80 }, (_, i) => `  const v${i} = ${i};`).join("\n");
    const source = [
      "export function huge(): number {",
      body,
      "  return v79; // MARKER_TAIL",
      "}",
      "",
      "export function tiny(): number {",
      "  return 1; // TINY_MARK",
      "}",
      "",
    ].join("\n");
    writeFile(root, "src/big.ts", source);
    const rawBytes = Buffer.byteLength(source, "utf8");
    delete process.env.GRAPHFLOW_READ_BUDGET_RATIO;
    const over = executeSurgicalRead({
      rootDir: root,
      targets: ["src/big.ts#huge"],
      includeCallers: false,
    });
    assert.ok(over.text.length <= rawBytes, `budget ${over.text.length} > raw ${rawBytes}`);
    assert.match(over.text, /function huge/);

    const tiny = executeSurgicalRead({
      rootDir: root,
      targets: ["src/big.ts#tiny"],
      includeCallers: false,
    });
    assert.match(tiny.text, /TINY_MARK/);
    assert.ok(tiny.text.length <= rawBytes, "small slice must stay within the file");

    process.env.GRAPHFLOW_READ_BUDGET_RATIO = "0";
    const full = executeSurgicalRead({
      rootDir: root,
      targets: ["src/big.ts#huge"],
      includeCallers: false,
    });
    assert.match(full.text, /MARKER_TAIL/);
    assert.ok(full.text.length > rawBytes, "disabling the guard must keep the numbered slice");
  } finally {
    if (previous === undefined) delete process.env.GRAPHFLOW_READ_BUDGET_RATIO;
    else process.env.GRAPHFLOW_READ_BUDGET_RATIO = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

check("auto log records shell runs from the hook and gf_exec, and a repeat promotes a task", () => {
  const root = tempRoot("gf-autolog-");
  const previous = process.env.GRAPHFLOW_AUTO_LOG;
  try {
    delete process.env.GRAPHFLOW_AUTO_LOG;
    const command = "node -e \"process.stdout.write('gf-auto-log')\"";
    interceptPostToolUse(
      {
        tool_name: "Bash",
        tool_input: { command, instruction: "print the auto log marker" },
        tool_response: { stdout: "gf-auto-log", exit_code: 0 },
      },
      { rootDir: root }
    );
    const logPath = join(root, TASK_LOG_REL_PATH);
    assert.ok(existsSync(logPath), "PostToolUse must append the instruction log");
    const first = readFileSync(logPath, "utf8");
    assert.match(first, /print the auto log marker/);
    assert.match(first, /gf-auto-log/);

    autoLogExecutedCommand(root, "echo skipped-noise");
    assert.equal(readFileSync(logPath, "utf8"), first, "noise commands must not be logged");

    process.env.GRAPHFLOW_AUTO_LOG = "0";
    autoLogExecutedCommand(root, "node -e \"process.stdout.write('off')\"");
    assert.equal(readFileSync(logPath, "utf8"), first, "GRAPHFLOW_AUTO_LOG=0 must skip logging");
    delete process.env.GRAPHFLOW_AUTO_LOG;

    const exec = executeV3ToolCall(
      "gf_exec",
      { cmd: command, run: true, rootDir: root },
      root
    );
    assert.ok((exec.content[0]?.text ?? "").length > 0, "gf_exec should return text");
    executeV3ToolCall("gf_exec", { cmd: command, run: true, rootDir: root }, root);
    const tasks = listTasks(root);
    assert.ok(tasks.some((task) => task.count >= 2), `repeat must harvest: ${JSON.stringify(tasks)}`);
    assert.ok(
      tasks.some((task) => task.scriptPath),
      `second identical command must promote: ${JSON.stringify(tasks)}`
    );
  } finally {
    if (previous === undefined) delete process.env.GRAPHFLOW_AUTO_LOG;
    else process.env.GRAPHFLOW_AUTO_LOG = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

check("MISS responses include the best Jaccard score and task-run exposes exitCode", () => {
  const root = tempRoot("gf-miss-");
  try {
    recordTaskUse(root, "alpha beta gamma delta epsilon zeta eta", ["node -e \"process.exit(0)\""]);
    recordTaskUse(root, "alpha beta gamma delta epsilon zeta eta", ["node -e \"process.exit(0)\""]);
    const dropped = runTask(root, "alpha beta gamma delta epsilon zeta");
    assert.equal(dropped.hit, false);
    assert.equal(dropped.exitCode, 1);
    assert.ok(dropped.text.startsWith("MISS [no-reflected-task]"), dropped.text);
    assert.match(dropped.text, /jaccard=0\.857/);
    assert.ok(typeof dropped.score === "number" && dropped.score > 0 && dropped.score < 1);

    const unrelated = runTask(root, "deploy the production kubernetes cluster");
    assert.match(unrelated.text, /jaccard=0\.000/);
    assert.equal(unrelated.score, 0);

    const viaTool = executeV3ToolCall("gf_macro", {
      action: "task-run",
      instruction: "alpha beta gamma delta epsilon zeta",
      rootDir: root,
    });
    assert.equal(viaTool.structuredContent?.exitCode, 1);
    assert.equal(viaTool.structuredContent?.hit, false);
    assert.ok(typeof viaTool.structuredContent?.score === "number");

  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

check("MCP surface stays at 4 tools and the wire schema stays under 460 tokens", () => {
  assert.equal(V3_TOOL_DEFINITIONS.length, 4);
  const wire = getToolDefinitions();
  assert.equal(wire.length, 4);
  const wireChars = Buffer.byteLength(JSON.stringify(wire), "utf8");
  const wireTokens = Math.ceil(wireChars / 4);
  console.log(`  [wire] ${wireChars} chars / ${wireTokens} tokens`);
  assert.ok(wireTokens < 460, `wire tokens ${wireTokens}`);
  assert.equal(readdirSync(join(__dirname)).filter((name) => name.endsWith(".test.ts")).length >= 25, true);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
