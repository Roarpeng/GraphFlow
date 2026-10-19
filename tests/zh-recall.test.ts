/**
 * Held-out Chinese→English recall (phrasings that are not in the L0 glossary)
 * plus the adaptive search budget. Temp dirs only.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CJK_ENGINEERING_GLOSSARY,
  executeSurgicalRead,
  tokenizeBilingualQuery,
  tokenizeEnglish,
} from "../src/index.js";
import { CURATED_ZH_EN } from "../src/zh-lexicon.js";
import {
  expandUncoveredChinese,
  filterEcdictTranslations,
  getZhRecallBundle,
  isGlossaryCovered,
  mineZhIdentifierMap,
  registerZhEnModel,
  resetZhRecallCache,
} from "../src/zh-recall.js";

interface Case {
  zh: string;
  symbol: string;
  group: "l1" | "l2" | "miss";
}

const L1: Case[] = [
  ["妥投回执", "buildDeliveryReceipt"],
  ["面单号", "assignWaybillNumber"],
  ["拣货波次", "schedulePickwave"],
  ["库位盘点", "startBincountAudit"],
  ["报损", "recordScrapQty"],
  ["在途件数", "sumInboundTransit"],
  ["拆单", "splitConsignment"],
  ["合单", "mergeCarton"],
  ["凑单", "applyBundleThreshold"],
  ["手续费", "postFeeLedger"],
  ["汇率", "convertFxrate"],
  ["税额", "applyTaxlevy"],
  ["灰度", "readCanaryFlag"],
  ["降级", "enterFallbackPath"],
  ["探活", "runHealthProbe"],
  ["背压", "readQueueWatermark"],
  ["分片", "resolveShardKey"],
  ["埋点", "emitTelemetryEvent"],
  ["幂等键", "readIdempotencyKey"],
  ["补偿", "enqueueCompensateJob"],
  ["对账", "openReconcileBatch"],
  ["清分", "postClearingResult"],
  ["分账", "applyAllotmentRule"],
  ["签收", "stampReceivedAt"],
  ["售后", "openAftersaleTicket"],
  ["发货", "createConsignNote"],
  ["发票", "setInvoiceTitle"],
  ["运费", "loadFreightTemplate"],
  ["水位", "readBacklogGauge"],
  ["心跳", "nextHeartbeatInterval"],
].map(([zh, symbol]) => ({ zh: zh!, symbol: symbol!, group: "l1" as const }));

const L2: Case[] = [
  ["搞定发货", "dispatchHaulage"],
  ["卡住了", "releaseStuckLock"],
  ["跑挂了", "markWorkerCrashed"],
  ["对不上", "reportAmountMismatch"],
  ["多退少补", "applyPriceDelta"],
  ["抹零", "roundCashPayable"],
  ["催单", "sendDunNotice"],
  ["拦单", "holdFraudOrder"],
  ["补差价", "collectDifference"],
  ["开发票", "issueFapiaoDoc"],
  ["看物流", "trackCourierHop"],
  ["拒收", "rejectParcelScan"],
  ["改地址", "updateStreetAddress"],
  ["缺货", "markShortageFlag"],
  ["超卖", "preventOversellQty"],
  ["预售", "openPresaleRound"],
  ["拼团", "matchGroupbuyDeal"],
  ["秒杀", "reserveFlashSale"],
  ["优惠码", "redeemPromoCode"],
  ["包邮", "waivePostageFee"],
  ["退货", "acceptReturngoods"],
  ["换货", "performExchangeitem"],
  ["查轨迹", "traceHoppath"],
  ["打单", "printShiplabel"],
  ["揽收", "pickupSatchel"],
  ["清关", "clearCustomsHold"],
  ["保税", "storeBondedLot"],
  ["调拨", "transferBinlot"],
  ["滞销", "flagSlowmover"],
  ["临期", "flagNearExpiry"],
  ["串号", "traceSerialNumber"],
  ["防伪", "verifyAntifakeSeal"],
  ["抬头", "normalizePayerTitle"],
  ["红冲", "reverseCreditnote"],
  ["扎帐", "closeDayledger"],
].map(([zh, symbol]) => ({ zh: zh!, symbol: symbol!, group: "l2" as const }));

const MISS: Case[] = [
  "老板说的那个数",
  "昨晚那个红灯",
  "群里有人问",
  "先这样吧",
  "回头再说",
  "感觉不太对",
  "帮我瞅瞅",
  "怎么又这样",
  "那个红色按钮",
  "财务那边要的表",
  "仓库小伙说的",
  "临时加的需求",
  "线上突然不行",
  "隔壁组骂人的那个",
  "顺丰那个单",
].map((zh) => ({ zh, symbol: "quarantineLot", group: "miss" as const }));

const CASES = [...L1, ...L2, ...MISS];
const DECOYS = [
  "formatLabel",
  "parseHeader",
  "widgetCount",
  "alphaBeta",
  "noopEcho",
  "colorSwatch",
  "paddingBox",
  "localeTag",
  "unicodeFold",
  "marginNote",
  "spacerLine",
  "bulletList",
  "captionText",
  "footerNote",
  "headerBand",
];

function git(root: string, args: string[]): void {
  execFileSync("git", args, {
    cwd: root,
    stdio: "ignore",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "gf",
      GIT_AUTHOR_EMAIL: "gf@example.com",
      GIT_COMMITTER_NAME: "gf",
      GIT_COMMITTER_EMAIL: "gf@example.com",
    },
  });
}

function writeCorpus(root: string): void {
  const fields = Array.from({ length: 40 }, (_, i) => `  field${i}: string;`).join("\n");
  const symbols = [...CASES.map((item) => item.symbol), ...DECOYS];
  const unique = [...new Set(symbols)];
  const fns = unique
    .map(
      (name) =>
        `/** English-only worker. */\nexport function ${name}(order: BulkyOrder): boolean {\n  return order.field0.length > 0;\n}`
    )
    .join("\n\n");
  const source = `export interface BulkyOrder {\n${fields}\n}\n\n${fns}\n`;
  writeFileSync(join(root, "warehouse.ts"), source, "utf8");
  git(root, ["init"]);
  git(root, ["add", "warehouse.ts"]);
  git(root, ["commit", "-m", "init sources"]);
  for (const item of L1) {
    git(root, ["commit", "--allow-empty", "-m", `${item.zh} ${item.symbol}`]);
  }
}

function ranks(root: string, query: string): string[] {
  return executeSurgicalRead({ rootDir: root, query, topK: 5 }).matchedSymbols.map((symbol) => symbol.name);
}

function summarize(rows: Array<{ names: string[]; expected: string }>): { p1: number; mrr: number; r3: number; n: number } {
  let p1 = 0;
  let mrr = 0;
  let r3 = 0;
  for (const row of rows) {
    const idx = row.names.indexOf(row.expected);
    if (idx === 0) p1 += 1;
    if (idx >= 0 && idx < 3) r3 += 1;
    if (idx >= 0) mrr += 1 / (idx + 1);
  }
  const n = rows.length || 1;
  return { n: rows.length, p1: p1 / n, mrr: mrr / n, r3: r3 / n };
}

function measure(root: string, cases: Case[]): { p1: number; mrr: number; r3: number; n: number; misses: string[] } {
  const rows = cases.map((item) => ({ names: ranks(root, item.zh), expected: item.symbol }));
  const misses = cases
    .map((item, index) => ({ item, names: rows[index]!.names }))
    .filter((row) => row.names[0] !== row.item.symbol)
    .slice(0, 8)
    .map((row) => `${row.item.group} ${row.item.zh} -> ${row.names.slice(0, 3).join(",") || "(none)"} want ${row.item.symbol}`);
  return { ...summarize(rows), misses };
}

function withEnv(vars: Record<string, string | undefined>, fn: () => void): void {
  const prev = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(vars)) {
    prev.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    fn();
  } finally {
    for (const [key, value] of prev) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function fmt(label: string, report: { n: number; p1: number; mrr: number; r3: number }): string {
  return `${label} n=${report.n} P@1=${report.p1.toFixed(3)} MRR=${report.mrr.toFixed(3)} R@3=${report.r3.toFixed(3)}`;
}

const root = mkdtempSync(join(tmpdir(), "gf-zh-recall-"));
try {
  for (const item of [...L1, ...L2, ...MISS]) {
    assert.equal(isGlossaryCovered(item.zh), false, `${item.zh} is already covered by the L0 glossary`);
    assert.equal(CJK_ENGINEERING_GLOSSARY[item.zh], undefined);
  }
  for (const key of Object.keys(CURATED_ZH_EN)) {
    assert.equal(isGlossaryCovered(key), false, `curated key overlaps L0: ${key}`);
  }
  const curatedBytes = Buffer.byteLength(JSON.stringify(CURATED_ZH_EN));
  assert.ok(curatedBytes < 1_000_000, `curated lexicon is ${curatedBytes} bytes`);
  for (const item of L2) {
    assert.ok(CURATED_ZH_EN[item.zh], `missing curated entry for ${item.zh}`);
    const symbolTokens = new Set(tokenizeEnglish(item.symbol).words);
    for (const token of CURATED_ZH_EN[item.zh] ?? []) {
      assert.ok(symbolTokens.has(token), `${item.zh} token ${token} not in ${item.symbol}`);
    }
  }

  const mined = mineZhIdentifierMap([
    { zh: ["妥投"], en: ["delivery"] },
    { zh: ["其它"], en: ["noise"] },
  ]);
  assert.deepEqual(mined.get("妥投"), ["delivery"]);
  assert.deepEqual(mined.get("其它"), ["noise"]);
  const shared = mineZhIdentifierMap([
    { zh: ["甲"], en: ["shared"] },
    { zh: ["乙"], en: ["shared"] },
    { zh: ["丙"], en: ["shared"] },
  ]);
  assert.equal(shared.has("甲"), false);

  const ecdict = filterEcdictTranslations("coldchain\t\t\t冷链专车\t\nmissing\t\t\t不在词表\t\n", new Set(["coldchain"]));
  assert.ok((ecdict.get("冷链专车") ?? []).includes("coldchain"));
  assert.equal([...ecdict.values()].some((row) => row.includes("missing")), false);

  writeCorpus(root);
  resetZhRecallCache();

  let baseline: ReturnType<typeof measure> | undefined;
  let l1only: ReturnType<typeof measure> | undefined;
  let both: ReturnType<typeof measure> | undefined;
  withEnv({ GRAPHFLOW_ZH_L1: "0", GRAPHFLOW_ZH_L2: "0", GRAPHFLOW_ZH_EN_MODEL: undefined }, () => {
    baseline = measure(root, CASES);
  });
  withEnv({ GRAPHFLOW_ZH_L1: undefined, GRAPHFLOW_ZH_L2: "0", GRAPHFLOW_ZH_EN_MODEL: undefined }, () => {
    l1only = measure(root, CASES);
  });
  withEnv({ GRAPHFLOW_ZH_L1: undefined, GRAPHFLOW_ZH_L2: undefined, GRAPHFLOW_ZH_EN_MODEL: undefined }, () => {
    both = measure(root, CASES);
  });
  assert.ok(baseline && l1only && both);
  const l1Cases = CASES.filter((item) => item.group === "l1");
  const l2Cases = CASES.filter((item) => item.group === "l2");
  const missCases = CASES.filter((item) => item.group === "miss");
  let l1Group: ReturnType<typeof measure> | undefined;
  let l2Group: ReturnType<typeof measure> | undefined;
  let missGroup: ReturnType<typeof measure> | undefined;
  let baselineL1: ReturnType<typeof measure> | undefined;
  let baselineL2: ReturnType<typeof measure> | undefined;
  withEnv({ GRAPHFLOW_ZH_L1: "0", GRAPHFLOW_ZH_L2: "0" }, () => {
    baselineL1 = measure(root, l1Cases);
    baselineL2 = measure(root, l2Cases);
  });
  withEnv({ GRAPHFLOW_ZH_L2: "0" }, () => {
    l1Group = measure(root, l1Cases);
  });
  withEnv({}, () => {
    l2Group = measure(root, l2Cases);
    missGroup = measure(root, missCases);
  });
  assert.ok(l1Group && l2Group && missGroup && baselineL1 && baselineL2);

  console.log(`[zh-recall] ${fmt("baseline", baseline)}`);
  console.log(`[zh-recall] ${fmt("+L1", l1only)}`);
  console.log(`[zh-recall] ${fmt("+L1+L2", both)}`);
  console.log(`[zh-recall] ${fmt("L1-subset baseline", baselineL1)} ${fmt("+L1", l1Group)}`);
  console.log(`[zh-recall] ${fmt("L2-subset baseline", baselineL2)} ${fmt("+L1+L2", l2Group)}`);
  console.log(`[zh-recall] ${fmt("miss-subset +L1+L2", missGroup)}`);
  for (const line of [...l1Group.misses, ...l2Group.misses]) {
    console.log(`[zh-recall] unexpected ${line}`);
  }

  assert.ok(baseline.p1 < 0.2, `baseline P@1 too high (${baseline.p1}) — held-out set leaked into L0`);
  assert.ok(l1Group.p1 >= 0.8, `L1 subset P@1 ${l1Group.p1}`);
  assert.ok(l1Group.p1 > baselineL1.p1 + 0.5, "L1 did not beat baseline on its subset");
  assert.ok(baselineL2.p1 < 0.2, `L2 baseline P@1 ${baselineL2.p1}`);
  assert.ok(l2Group.p1 >= 0.8, `L2 subset P@1 ${l2Group.p1}`);
  assert.ok(both.p1 > baseline.p1 + 0.4, `full-set gain too small ${baseline.p1} -> ${both.p1}`);
  assert.ok(both.mrr > baseline.mrr, "MRR did not improve");
  assert.ok(both.r3 > baseline.r3, "R@3 did not improve");
  assert.ok(missGroup.p1 <= 0.15, `miss subset should stay a gap, P@1=${missGroup.p1}`);

  let adaptiveTokens = 0;
  let explicitTokens = 0;
  let adaptiveP1 = 0;
  for (const item of CASES) {
    const adaptive = executeSurgicalRead({ rootDir: root, query: item.zh });
    const explicit = executeSurgicalRead({ rootDir: root, query: item.zh, topK: 3 });
    adaptiveTokens += adaptive.estimatedTokens;
    explicitTokens += explicit.estimatedTokens;
    if (adaptive.matchedSymbols[0]?.name === item.symbol) adaptiveP1 += 1;
  }
  console.log(
    `[zh-recall] tokens held-out adaptive=${adaptiveTokens} explicitTopK3=${explicitTokens} ` +
      `adaptiveP@1=${(adaptiveP1 / CASES.length).toFixed(3)}`
  );
  assert.ok(adaptiveTokens < explicitTokens, "adaptive search did not shrink tokens");
  assert.ok(adaptiveP1 / CASES.length + 0.02 >= both.p1, "adaptive topK dropped confident rank-1 hits");

  const cachePath = join(root, ".graphflow", "zh-identifier-map.json");
  const cacheBytes = statSync(cachePath).size;
  assert.ok(cacheBytes < 1_000_000, `recall cache is ${cacheBytes} bytes`);
  const bundle = getZhRecallBundle(root, [{ relPath: "warehouse.ts", content: readFileSync(join(root, "warehouse.ts"), "utf8") }]);
  const planProbe = tokenizeBilingualQuery("妥投回执");
  const started = performance.now();
  for (let i = 0; i < 1000; i += 1) expandUncoveredChinese(planProbe, bundle);
  const avgMs = (performance.now() - started) / 1000;
  console.log(`[zh-recall] warm lookup ${avgMs.toFixed(4)} ms, cache ${cacheBytes} bytes, l1=${bundle.l1.size} l2=${bundle.l2.size}`);
  assert.ok(avgMs < 1, `lookup ${avgMs} ms`);

  let modelCalls = 0;
  registerZhEnModel({
    translate(text: string) {
      modelCalls += 1;
      return text === "隔壁组骂人的那个" ? ["quarantine"] : [];
    },
  });
  withEnv({ GRAPHFLOW_ZH_EN_MODEL: "1" }, () => {
    const hit = executeSurgicalRead({ rootDir: root, query: "隔壁组骂人的那个", topK: 1 });
    assert.ok(hit.matchedSymbols.some((symbol) => symbol.name === "quarantineLot"), "L3 hook should bridge a miss");
    assert.ok(modelCalls > 0);
  });
  registerZhEnModel(undefined);
  withEnv({ GRAPHFLOW_ZH_EN_MODEL: undefined }, () => {
    const quiet = executeSurgicalRead({ rootDir: root, query: "隔壁组骂人的那个", topK: 1 });
    assert.equal(quiet.matchedSymbols.some((symbol) => symbol.name === "quarantineLot"), false);
  });

  const tieRoot = mkdtempSync(join(tmpdir(), "gf-zh-tie-"));
  try {
    const tieSource = [
      "export interface BulkyOrder {",
      ...Array.from({ length: 40 }, (_, i) => `  field${i}: string;`),
      "}",
      "/** 订单超时。 */",
      "export function timeoutWindow(order: BulkyOrder): boolean { return order.field0.length > 0; }",
      "/** 订单超时。 */",
      "export function timeoutSweep(order: BulkyOrder): boolean { return order.field1.length > 0; }",
      "/** 取消订单并释放库存。 */",
      "export function cancelOrder(order: BulkyOrder): boolean {",
      "  const a = order.field2;",
      "  const b = order.field3;",
      "  const c = order.field4;",
      "  const d = order.field5;",
      "  const e = order.field6;",
      "  const f = order.field7;",
      "  const g = order.field8;",
      "  const h = order.field9;",
      "  const i = order.field10;",
      "  const j = order.field11;",
      "  const k = order.field12;",
      "  const l = order.field13;",
      "  const m = order.field14;",
      "  const n = order.field15;",
      "  const o = order.field16;",
      "  const p = order.field17;",
      "  const q = order.field18;",
      "  const marker = order.field19; // EXPLICIT_BODY_TAIL",
      "  return a.length + b.length + c.length + d.length + e.length + f.length + g.length + h.length + i.length + j.length + k.length + l.length + m.length + n.length + o.length + p.length + marker.length > 0;",
      "}",
      "export function formatLabel(order: BulkyOrder): boolean { return order.field3.length > 0; }",
    ].join("\n");
    writeFileSync(join(tieRoot, "orders.ts"), tieSource, "utf8");
    resetZhRecallCache();
    const single = executeSurgicalRead({ rootDir: tieRoot, query: "取消订单" });
    const full = executeSurgicalRead({ rootDir: tieRoot, query: "取消订单", topK: 3 });
    assert.equal(single.matchedSymbols[0]?.name, "cancelOrder");
    assert.equal(single.matchedSymbols.length, 1, "confident query should slice one symbol");
    assert.ok(full.matchedSymbols.length > single.matchedSymbols.length, "explicit topK keeps additional hits");
    assert.ok(single.estimatedTokens < full.estimatedTokens, `${single.estimatedTokens} vs ${full.estimatedTokens}`);
    const tie = executeSurgicalRead({ rootDir: tieRoot, query: "订单超时" });
    const tieNames = tie.matchedSymbols.map((symbol) => symbol.name);
    assert.ok(tieNames.includes("timeoutWindow") && tieNames.includes("timeoutSweep"), tieNames.join(","));
    console.log(
      `[zh-recall] adaptive confident ${single.estimatedTokens} tok vs explicit ${full.estimatedTokens} tok; near-tie ${tieNames.join(",")}`
    );
  } finally {
    rmSync(tieRoot, { recursive: true, force: true });
  }

  console.log("PASS [zh-recall] L1 PMI map, L2 curated lexicon, L3 hook, adaptive topK");
} finally {
  registerZhEnModel(undefined);
  resetZhRecallCache();
  rmSync(root, { recursive: true, force: true });
}
