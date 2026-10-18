/**
 * GraphFlow — Bilingual (English/Chinese/pinyin/mixed) retrieval recall parity test.
 *
 * Builds a deterministic fixture corpus of ~35 symbols whose identifiers are English while their
 * JSDoc/docstrings are Chinese (plus Pinyin-named / English-only / CJK-only adversarial symbols),
 * then measures recall@1/@3/@5 of `executeSurgicalRead({ query })` for paired English and Chinese
 * queries (plus pinyin / mixed / synonym / homophone-typo variants).
 *
 * Targets:
 *   - Both EN and ZH recall >= 0.90 at @1/@3/@5.
 *   - ZH recall >= EN recall - 0.05 at every k (parity, not just a raw score).
 *   - Pinyin / mixed / synonym query families also >= 0.90.
 *   - Deterministic results, fixture build/measure runtime budget.
 *
 * Also guards the tokenizer asymmetries that were fixed:
 *   - Chinese terms forward-map to the same English identifier tokens as the reverse direction.
 *   - Morphological derivatives are not rescued as typos (`handle` must not become `handler`).
 *   - Pinyin keys bridge EN <-> ZH <-> identifier names.
 *
 * Temp dirs only. Exits non-zero on failure.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  executeSurgicalRead,
  stemEnglishWord,
  tokenizeBilingualQuery,
  tokenizeEnglish,
} from "../src/index.js";

interface FixtureSymbol {
  dir: string;
  name: string;
  zh: string;
  en?: string;
}

// 30 main-corpus symbols: English identifiers + Chinese-only docstrings (the parity stress case).
const SYMBOLS: FixtureSymbol[] = [
  { dir: "orders", name: "cancelOrder", zh: "取消订单并释放库存", en: "cancel a pending order" },
  { dir: "orders", name: "createOrder", zh: "创建订单", en: "create an order" },
  { dir: "subscriptions", name: "cancelSubscription", zh: "取消订阅", en: "cancel a subscription" },
  { dir: "payments", name: "handlePayment", zh: "处理支付回调", en: "handle a payment callback" },
  { dir: "payments", name: "verifySignature", zh: "验证签名", en: "verify the signature" },
  { dir: "payments", name: "refundPayment", zh: "退款支付", en: "refund a payment" },
  { dir: "auth", name: "refreshToken", zh: "刷新令牌", en: "refresh the token" },
  { dir: "auth", name: "createUser", zh: "创建用户", en: "create a user" },
  { dir: "auth", name: "deleteAccount", zh: "删除账号", en: "delete an account" },
  { dir: "inventory", name: "updateInventory", zh: "更新库存并扣减数量", en: "update inventory" },
  { dir: "inventory", name: "checkStock", zh: "检查库存", en: "check stock" },
  { dir: "inventory", name: "reserveStock", zh: "预留库存", en: "reserve stock" },
  { dir: "queue", name: "enqueueJob", zh: "加入队列任务入队", en: "enqueue a job" },
  { dir: "queue", name: "dequeueJob", zh: "任务出队", en: "dequeue a job" },
  { dir: "queue", name: "retryPolicy", zh: "重试策略与退避", en: "retry policy" },
  { dir: "infra", name: "connectDatabase", zh: "连接数据库", en: "connect the database" },
  { dir: "infra", name: "rollbackTransaction", zh: "回滚事务", en: "rollback a transaction" },
  { dir: "infra", name: "circuitBreaker", zh: "熔断器", en: "circuit breaker" },
  { dir: "infra", name: "rateLimit", zh: "限流", en: "rate limit" },
  { dir: "cache", name: "cacheEviction", zh: "缓存淘汰", en: "cache eviction" },
  { dir: "cache", name: "loadMacro", zh: "加载宏", en: "load a macro" },
  { dir: "cache", name: "searchIndex", zh: "搜索索引", en: "search the index" },
  { dir: "notify", name: "sendNotification", zh: "发送通知", en: "send a notification" },
  { dir: "notify", name: "handleWebhook", zh: "处理回调 webhook", en: "handle a webhook callback" },
  { dir: "parse", name: "parseConfig", zh: "解析配置", en: "parse the config" },
  { dir: "parse", name: "validateSchema", zh: "验证结构模式", en: "validate the schema" },
  { dir: "parse", name: "generateReport", zh: "生成报告", en: "generate a report" },
  { dir: "io", name: "uploadFile", zh: "上传文件", en: "upload a file" },
  { dir: "io", name: "downloadFile", zh: "下载文件", en: "download a file" },
  { dir: "io", name: "compressOutput", zh: "压缩输出", en: "compress the output" },
];

// Adversarial symbols (outside the parity metric).
const ADVERSARIAL: FixtureSymbol[] = [
  // Pinyin-named identifier with a Chinese docstring.
  { dir: "adv", name: "handleDingDanZhiFu", zh: "处理微信支付回调", en: "handle wechat payment callback" },
  // Opaque English identifier whose only documentation is Chinese.
  { dir: "adv", name: "ddfProcess", zh: "订单数据处理" },
  // English-only symbol with no Chinese documentation at all.
  { dir: "adv", name: "resolveBudgetLimit", zh: "", en: "resolve budget limit" },
];

interface QueryPair {
  en: string;
  zh: string;
  expected: string;
  pinyin?: string;
  mixed?: string;
  synonym?: string;
}

const PAIRS: QueryPair[] = [
  { en: "cancel order", zh: "取消订单", expected: "cancelOrder", pinyin: "quxiao dingdan", mixed: "取消 order", synonym: "撤销订单" },
  { en: "create order", zh: "创建订单", expected: "createOrder", mixed: "创建 order" },
  { en: "cancel subscription", zh: "取消订阅", expected: "cancelSubscription", pinyin: "quxiao dingyue" },
  { en: "payment callback", zh: "支付回调", expected: "handlePayment", pinyin: "zhifu huidiao", mixed: "支付 callback", synonym: "付款回调" },
  { en: "verify signature", zh: "验证签名", expected: "verifySignature", pinyin: "yanzheng qianming", mixed: "验证 signature", synonym: "验签" },
  { en: "refund payment", zh: "退款", expected: "refundPayment", mixed: "退款 payment", synonym: "退款" },
  { en: "refresh token", zh: "刷新令牌", expected: "refreshToken", pinyin: "shuaxin lingpai", mixed: "刷新 token" },
  { en: "create user", zh: "创建用户", expected: "createUser", mixed: "创建 user" },
  { en: "delete account", zh: "删除账号", expected: "deleteAccount", pinyin: "shanchu zhanghao", synonym: "删除用户" },
  { en: "update inventory", zh: "更新库存", expected: "updateInventory", pinyin: "gengxin kucun", synonym: "扣减库存" },
  { en: "check stock", zh: "检查库存", expected: "checkStock", pinyin: "jiancha kucun" },
  { en: "reserve stock", zh: "预留库存", expected: "reserveStock", pinyin: "yuliu kucun" },
  { en: "enqueue job", zh: "加入队列", expected: "enqueueJob", mixed: "入队 job", synonym: "任务入队" },
  { en: "dequeue job", zh: "任务出队", expected: "dequeueJob", pinyin: "renwu chudui", mixed: "出队 job" },
  { en: "retry policy", zh: "重试策略", expected: "retryPolicy", pinyin: "chongshi celue", mixed: "重试 policy", synonym: "重试退避" },
  { en: "connect database", zh: "连接数据库", expected: "connectDatabase", pinyin: "lianjie shujuku", synonym: "数据库连接" },
  { en: "rollback transaction", zh: "回滚事务", expected: "rollbackTransaction", pinyin: "huigun shiwu", synonym: "事务回滚" },
  { en: "circuit breaker", zh: "熔断器", expected: "circuitBreaker", pinyin: "rongduan" },
  { en: "rate limit", zh: "限流", expected: "rateLimit", pinyin: "xianliu", synonym: "限速" },
  { en: "cache eviction", zh: "缓存淘汰", expected: "cacheEviction", pinyin: "huancun taotai", synonym: "缓存清理" },
  { en: "load macro", zh: "加载宏", expected: "loadMacro", pinyin: "jiazai hong" },
  { en: "search index", zh: "搜索索引", expected: "searchIndex", pinyin: "sousuo suoyin" },
  { en: "send notification", zh: "发送通知", expected: "sendNotification", pinyin: "fasong tongzhi", mixed: "发送 notification", synonym: "消息通知" },
  { en: "handle webhook", zh: "处理回调", expected: "handleWebhook", pinyin: "chuli huidiao", mixed: "webhook 回调" },
  { en: "parse config", zh: "解析配置", expected: "parseConfig", pinyin: "jiexi peizhi", synonym: "配置解析" },
  { en: "validate schema", zh: "验证结构", expected: "validateSchema", pinyin: "yanzheng jiegou", synonym: "校验模式" },
  { en: "generate report", zh: "生成报告", expected: "generateReport", pinyin: "shengcheng baogao", mixed: "生成 report" },
  { en: "upload file", zh: "上传文件", expected: "uploadFile", pinyin: "shangchuan wenjian", mixed: "上传 file" },
  { en: "download file", zh: "下载文件", expected: "downloadFile", pinyin: "xiazai wenjian", mixed: "下载 file" },
  { en: "compress output", zh: "压缩输出", expected: "compressOutput", pinyin: "yasuo shuchu", synonym: "脱水压缩" },
];

type QueryFamily = "en" | "zh" | "pinyin" | "mixed" | "synonym";

interface RecallReport {
  n: number;
  r1: number;
  r3: number;
  r5: number;
  failures: string[];
}

function writeFixture(root: string): void {
  let index = 0;
  for (const sym of [...SYMBOLS, ...ADVERSARIAL]) {
    const lines: string[] = [];
    if (sym.zh) lines.push(`/** ${sym.zh}。 */`);
    else if (sym.en) lines.push(`/** ${sym.en}. */`);
    lines.push(`export function ${sym.name}(input: string): boolean {`, "  return input.length > 0;", "}");
    lines.push("");
    const fileName = `${String(index).padStart(2, "0")}-${sym.dir}.ts`;
    index += 1;
    const abs = join(root, "src", fileName);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, lines.join("\n"), "utf8");
  }
}

function matchedSymbolNames(root: string, query: string, topK: number): string[] {
  const result = executeSurgicalRead({ rootDir: root, query, topK });
  return result.matchedSymbols.map((symbol) => symbol.name);
}

function measureFamily(root: string, family: QueryFamily): RecallReport {
  const available = PAIRS.filter((pair) => pair[family] !== undefined);
  const hits = [0, 0, 0];
  const failures: string[] = [];
  for (const pair of available) {
    const query = pair[family]!;
    const at1 = matchedSymbolNames(root, query, 1).includes(pair.expected);
    const at3 = matchedSymbolNames(root, query, 3).includes(pair.expected);
    const at5 = matchedSymbolNames(root, query, 5).includes(pair.expected);
    if (at1) hits[0] += 1;
    if (at3) hits[1] += 1;
    if (at5) hits[2] += 1;
    if (!at1) {
      failures.push(
        `@1 ${JSON.stringify(query)} -> ${matchedSymbolNames(root, query, 1).join(",") || "(none)"} (want ${pair.expected})`
      );
    }
  }
  const n = available.length || 1;
  return {
    n: available.length,
    r1: hits[0]! / n,
    r3: hits[1]! / n,
    r5: hits[2]! / n,
    failures,
  };
}

function formatReport(family: QueryFamily, report: RecallReport): string {
  return `${family.toUpperCase()} n=${report.n} R@1=${report.r1.toFixed(3)} R@3=${report.r3.toFixed(3)} R@5=${report.r5.toFixed(3)}`;
}

function run(): void {
  const root = mkdtempSync(join(tmpdir(), "gf-bilingual-parity-"));
  try {
    writeFixture(root);
    const startedAt = Date.now();

    // ── 1. Tokenizer symmetry unit checks (the root causes that were fixed) ──
    const zhCancelPlan = tokenizeBilingualQuery("取消订单");
    for (const token of ["cancel", "order", "quxiao", "dingdan"]) {
      assert.ok(
        zhCancelPlan.englishWords.includes(token),
        `Chinese query plan must forward-map to English/Pinyin token "${token}"`
      );
    }
    const enPaymentPlan = tokenizeBilingualQuery("payment callback");
    for (const token of ["支付", "回调"]) {
      assert.ok(
        enPaymentPlan.chineseWords.includes(token),
        `English query plan must reverse-map to Chinese token "${token}"`
      );
    }
    assert.ok(
      tokenizeBilingualQuery("quxiao dingdan").englishWords.includes("cancel"),
      "pinyin query must resolve through pinyin -> CJK -> English (cancel)"
    );
    assert.ok(
      tokenizeBilingualQuery("取消 order").englishWords.includes("cancel") &&
        tokenizeBilingualQuery("取消 order").englishWords.includes("order"),
      "mixed query must keep both Chinese-derived and English tokens"
    );
    // Morphological derivatives must not be rescued as typos (handle -> handler regression).
    assert.ok(
      !tokenizeEnglish("handleWebhook").words.includes("handler"),
      "`handle` must not be fuzzy-rescued into `handler`"
    );
    assert.notEqual(stemEnglishWord("handle"), "handler");
    // Homophone typo normalization stays symmetric.
    assert.ok(
      tokenizeBilingualQuery("取消订但").chineseWords.includes("订单"),
      "Chinese IME typo (订但) must normalize to 订单"
    );

    // ── 2. Recall parity: EN vs ZH (pinyin/mixed/synonym as supporting families) ──
    const en = measureFamily(root, "en");
    const zh = measureFamily(root, "zh");
    const pinyin = measureFamily(root, "pinyin");
    const mixed = measureFamily(root, "mixed");
    const synonym = measureFamily(root, "synonym");

    console.log(`[bilingual-parity] ${formatReport("en", en)}`);
    console.log(`[bilingual-parity] ${formatReport("zh", zh)}`);
    console.log(`[bilingual-parity] ${formatReport("pinyin", pinyin)}`);
    console.log(`[bilingual-parity] ${formatReport("mixed", mixed)}`);
    console.log(`[bilingual-parity] ${formatReport("synonym", synonym)}`);
    for (const failure of [
      ...en.failures.map((f) => `EN ${f}`),
      ...zh.failures.map((f) => `ZH ${f}`),
    ]) {
      console.log(`[bilingual-parity] FAIL ${failure}`);
    }

    for (const [label, report] of [
      ["EN", en],
      ["ZH", zh],
    ] as const) {
      assert.ok(report.r1 >= 0.9, `${label} recall@1 must be >= 0.9 (got ${report.r1.toFixed(3)})`);
      assert.ok(report.r3 >= 0.9, `${label} recall@3 must be >= 0.9 (got ${report.r3.toFixed(3)})`);
      assert.ok(report.r5 >= 0.9, `${label} recall@5 must be >= 0.9 (got ${report.r5.toFixed(3)})`);
    }
    // Parity target: Chinese may lag English by at most 0.05 at every cut-off.
    assert.ok(
      zh.r1 >= en.r1 - 0.05,
      `ZH recall@1 parity: ${zh.r1.toFixed(3)} must be >= EN ${en.r1.toFixed(3)} - 0.05`
    );
    assert.ok(
      zh.r3 >= en.r3 - 0.05,
      `ZH recall@3 parity: ${zh.r3.toFixed(3)} must be >= EN ${en.r3.toFixed(3)} - 0.05`
    );
    assert.ok(
      zh.r5 >= en.r5 - 0.05,
      `ZH recall@5 parity: ${zh.r5.toFixed(3)} must be >= EN ${en.r5.toFixed(3)} - 0.05`
    );
    for (const [label, report] of [
      ["PINYIN", pinyin],
      ["MIXED", mixed],
      ["SYNONYM", synonym],
    ] as const) {
      assert.ok(report.r1 >= 0.9, `${label} recall@1 must be >= 0.9 (got ${report.r1.toFixed(3)})`);
      assert.ok(report.r3 >= 0.9, `${label} recall@3 must be >= 0.9 (got ${report.r3.toFixed(3)})`);
      assert.ok(report.r5 >= 0.9, `${label} recall@5 must be >= 0.9 (got ${report.r5.toFixed(3)})`);
    }

    // ── 3. Adversarial cases ──
    // CJK-only documentation must be enough for a Chinese query on an opaque identifier.
    assert.equal(
      matchedSymbolNames(root, "订单数据处理", 1)[0],
      "ddfProcess",
      "Chinese query must recall a symbol documented only in Chinese"
    );
    // English-only symbol with no Chinese documentation reaches budget/limit via symbol names.
    assert.ok(
      matchedSymbolNames(root, "预算限制", 3).includes("resolveBudgetLimit"),
      "Chinese query must recall an English-only budget/limit symbol via glossary expansion"
    );
    assert.equal(
      matchedSymbolNames(root, "budget limit", 1)[0],
      "resolveBudgetLimit",
      "English query must rank the English-only symbol first"
    );
    // Pinyin-named identifier: Chinese query resolves it; English generic query is a known
    // ranking gap (generic handlePayment wins @1) but must still surface it in the top 5.
    assert.equal(
      matchedSymbolNames(root, "微信支付回调", 1)[0],
      "handleDingDanZhiFu",
      "Chinese query 微信支付回调 must rank the Pinyin-named identifier first"
    );
    const pinyinNameInEnglish = matchedSymbolNames(root, "wechat payment callback", 5);
    assert.ok(
      pinyinNameInEnglish.includes("handleDingDanZhiFu"),
      "English query must still recall the Pinyin-named identifier within top-5"
    );
    // CJK-only docstring (no English docs) is recalled by an English query when the name matches.
    assert.ok(
      matchedSymbolNames(root, "process order data", 5).includes("ddfProcess"),
      "English query must recall a CJK-documented symbol through name/glossary bridging"
    );
    // Homophone typos / synonyms.
    assert.equal(matchedSymbolNames(root, "取消订但", 1)[0], "cancelOrder");
    assert.equal(matchedSymbolNames(root, "支付回掉", 1)[0], "handlePayment");

    // ── 4. Determinism + runtime budget ──
    const repeated = measureFamily(root, "en");
    assert.deepEqual(
      { r1: repeated.r1, r3: repeated.r3, r5: repeated.r5, n: repeated.n },
      { r1: en.r1, r3: en.r3, r5: en.r5, n: en.n },
      "recall measurement must be deterministic"
    );
    const elapsedMs = Date.now() - startedAt;
    assert.ok(elapsedMs < 20000, `fixture recall suite must finish well under 20s (took ${elapsedMs}ms)`);

    console.log(
      `[bilingual-parity] elapsed=${elapsedMs}ms parityGap@1=${(en.r1 - zh.r1).toFixed(3)}`
    );
    console.log(
      "PASS [bilingual-parity] EN/ZH recall parity, pinyin/mixed/synonym recall, tokenizer symmetry and adversarial bilingual cases"
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

try {
  run();
} catch (error) {
  console.error("FAIL [bilingual-parity]", error);
  process.exit(1);
}
