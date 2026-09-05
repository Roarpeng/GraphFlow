/**
 * Public flywheel proof entry — thin orchestrator over existing offline benches.
 *
 * Does not invent numbers. Published self-test claims are copied from tracked
 * RESULTS markdown already in the repo and labeled as author-run self-tests.
 *
 *   npm run proof:flywheel              # essential public suite
 *   npm run proof:flywheel -- --dry-run # validate package, print claims
 *   npm run proof:flywheel -- --help
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { benchMeta, getCommitHash } from "./bench-meta";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const CACHE_DIR = join(__dirname, ".cache");
const DEFAULT_SUMMARY_PATH = join(CACHE_DIR, "flywheel-proof-summary.json");

export const PROOF_USAGE = `GraphFlow flywheel proof — third-party reproduction entry

Usage:
  npm run proof:flywheel -- [options]

Options:
  --help              Print this message and exit 0
  --dry-run, --dry    Validate scripts, tracked reports, and the open dataset.
                      Print published self-test claims + a human checklist.
                      Does not re-run benches.
  --json              Print only the machine-readable summary JSON
  --with-token        Also run the token-savings bench (compression claim;
                      not required for flywheel / memory / retrieval ROI)
  --output <path>     Write the summary JSON (live mode only; default:
                      benchmarks/.cache/flywheel-proof-summary.json)

Default (no flags): run the essential public suite
  retrieval + skill injection + skill A/B (P1-2) + memory A/B (P3)
then print a human checklist and a machine-readable summary.

See docs/flywheel-reproduction.md for commands, artifacts, and what "pass" means.
`;

export interface ProofArgs {
  help: boolean;
  dryRun: boolean;
  jsonOnly: boolean;
  withToken: boolean;
  outputPath: string | undefined;
}

const REQUIRED_CLAIM_IDS = [
  "retrieval-hit5",
  "retrieval-mrr",
  "retrieval-ndcg5",
  "skill-ab-on",
  "skill-ab-off",
  "memory-ab-on",
  "memory-ab-off",
] as const;

export function parseProofArgs(argv: readonly string[]): ProofArgs {
  let outputPath: string | undefined;
  const outputIdx = argv.indexOf("--output");
  if (outputIdx >= 0) {
    const value = argv[outputIdx + 1];
    if (value && !value.startsWith("-")) outputPath = value;
  }
  return {
    help: argv.includes("--help") || argv.includes("-h"),
    dryRun: argv.includes("--dry-run") || argv.includes("--dry"),
    jsonOnly: argv.includes("--json"),
    withToken: argv.includes("--with-token"),
    ...(outputPath ? { outputPath } : {}),
  };
}

export interface ProofSuiteStep {
  id: string;
  title: string;
  npmScript: string;
  script: string;
  jsonArtifact: string;
  humanArtifact: string;
  essential: boolean;
}

export const FLYWHEEL_PROOF_STEPS: readonly ProofSuiteStep[] = [
  {
    id: "retrieval",
    title: "Retrieval golden set",
    npmScript: "bench:retrieval",
    script: "benchmarks/run-retrieval-eval.ts",
    jsonArtifact: "benchmarks/.cache/retrieval-eval-results.json",
    humanArtifact: "benchmarks/RETRIEVAL-EVAL-RESULTS.md",
    essential: true,
  },
  {
    id: "skill-injection",
    title: "Skill flywheel injection / recall",
    npmScript: "benchmark:skills",
    script: "benchmarks/run-skill-ab-benchmark.ts",
    jsonArtifact: "benchmarks/.cache/skill-injection-results.json",
    humanArtifact: "benchmarks/SKILL-AB-RESULTS.md",
    essential: true,
  },
  {
    id: "skill-ab",
    title: "Skill flywheel end-to-end A/B (P1-2)",
    npmScript: "benchmark:ab",
    script: "benchmarks/run-skill-ab.ts",
    jsonArtifact: "benchmarks/.cache/skill-ab-results.json",
    humanArtifact: "benchmarks/RESULTS.md",
    essential: true,
  },
  {
    id: "memory-ab",
    title: "Episodic-memory A/B (P3)",
    npmScript: "benchmark:memory",
    script: "benchmarks/run-memory-ab.ts",
    jsonArtifact: "benchmarks/.cache/memory-ab-results.json",
    humanArtifact: "benchmarks/RESULTS.md",
    essential: true,
  },
  {
    id: "token",
    title: "Token savings (optional compression claim)",
    npmScript: "bench:token",
    script: "benchmarks/run-token-benchmark.ts",
    jsonArtifact: "benchmarks/.cache/token-bench-results.json",
    humanArtifact: "benchmarks/RESULTS.md",
    essential: false,
  },
];

export interface PublishedClaim {
  id: string;
  suite: string;
  sourceFile: string;
  sourceNeedle: string;
  metric: string;
  display: string;
  numeric: number;
  note: string;
}

const CLAIMS_CATALOG_REL = "benchmarks/flywheel-proof-claims.json";

export function loadPublishedClaims(): readonly PublishedClaim[] {
  const catalog = asRecord(JSON.parse(readFileSync(repoPath(CLAIMS_CATALOG_REL), "utf8")));
  const claims = catalog?.claims;
  if (!Array.isArray(claims)) throw new Error(`${CLAIMS_CATALOG_REL} is missing claims[]`);
  return claims as PublishedClaim[];
}

/** Frozen catalog loaded from benchmarks/flywheel-proof-claims.json. */
export const PUBLISHED_SELF_TEST_CLAIMS: readonly PublishedClaim[] = loadPublishedClaims();

export const REQUIRED_TRACKED_PATHS: readonly string[] = [
  "benchmarks/run-flywheel-proof.ts",
  "benchmarks/flywheel-proof-claims.json",
  "docs/flywheel-reproduction.md",
  "benchmarks/README.md",
  "docs/benchmark-standards.md",
  "benchmarks/datasets/retrieval-golden-v1.json",
  "benchmarks/datasets/retrieval-golden-v1.jsonl",
  "benchmarks/RESULTS.md",
  "benchmarks/RETRIEVAL-EVAL-RESULTS.md",
  "benchmarks/SKILL-AB-RESULTS.md",
];

export interface ChecklistItem {
  id: string;
  ok: boolean;
  detail: string;
}

export interface StepRunResult {
  id: string;
  title: string;
  skipped: boolean;
  exitCode: number | null;
  jsonArtifactExists: boolean;
  humanArtifactExists: boolean;
}

export interface LiveMetric {
  suite: string;
  metric: string;
  value: number | null;
  published: number;
  match: boolean | null;
  commit: string | null;
}

export interface FlywheelProofSummary {
  schemaVersion: number;
  benchmark: string;
  generatedAt: string;
  commit: string;
  environment: {
    node: string;
    platform: string;
  };
  mode: "dry-run" | "live";
  pass: boolean;
  structuralPass: boolean;
  claimMatch: boolean | null;
  disclaimer: string;
  steps: StepRunResult[];
  publishedClaims: PublishedClaim[];
  liveMetrics: LiveMetric[] | null;
  checklist: ChecklistItem[];
  reportIssueTitle: string;
  docs: string[];
  withToken: boolean;
}

const DISCLAIMER =
  "Numbers quoted as publishedClaims are project self-tests (author-run, not independently verified). Compare your live JSON to benchmarks/flywheel-proof-claims.json. Cross-commit drift on src/-backed suites is expected, not a runner failure. Live runners rewrite *-RESULTS.md; do not treat those regenerations as the catalog.";

function repoPath(rel: string): string {
  return join(REPO_ROOT, rel);
}

function fileExists(rel: string): boolean {
  return existsSync(repoPath(rel));
}

function readText(rel: string): string {
  return readFileSync(repoPath(rel), "utf8");
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readJsonRecord(rel: string): Record<string, unknown> | undefined {
  if (!fileExists(rel)) return undefined;
  try {
    return asRecord(JSON.parse(readText(rel)));
  } catch {
    return undefined;
  }
}

function numericField(record: Record<string, unknown> | undefined, key: string): number | null {
  const value = record?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stringField(record: Record<string, unknown> | undefined, key: string): string | null {
  const value = record?.[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function nearlyEqual(a: number, b: number): boolean {
  return Math.abs(a - b) <= 0.0005;
}

function packageHasProofScript(): boolean {
  const pkg = readJsonRecord("package.json");
  const scripts = asRecord(pkg?.scripts);
  return typeof scripts?.["proof:flywheel"] === "string";
}

function selectedSteps(withToken: boolean): ProofSuiteStep[] {
  return FLYWHEEL_PROOF_STEPS.filter((step) => step.essential || withToken);
}

function buildChecklist(input: {
  mode: "dry-run" | "live";
  steps: readonly StepRunResult[];
  claimsPresent: boolean;
}): ChecklistItem[] {
  const items: ChecklistItem[] = [
    {
      id: "entrypoint",
      ok: fileExists("benchmarks/run-flywheel-proof.ts") && packageHasProofScript(),
      detail: "package.json script proof:flywheel → benchmarks/run-flywheel-proof.ts",
    },
    {
      id: "docs",
      ok: fileExists("docs/flywheel-reproduction.md"),
      detail: "docs/flywheel-reproduction.md explains commands, artifacts, and pass",
    },
    {
      id: "tracked-reports",
      ok: ["benchmarks/RESULTS.md", "benchmarks/RETRIEVAL-EVAL-RESULTS.md", "benchmarks/SKILL-AB-RESULTS.md"].every(
        fileExists
      ),
      detail: "Tracked self-test reports RESULTS.md / RETRIEVAL-EVAL-RESULTS.md / SKILL-AB-RESULTS.md",
    },
    {
      id: "open-dataset",
      ok:
        fileExists("benchmarks/datasets/retrieval-golden-v1.json") &&
        fileExists("benchmarks/datasets/retrieval-golden-v1.jsonl"),
      detail: "Open retrieval dataset JSON + JSONL is present",
    },
    {
      id: "published-claims",
      ok: input.claimsPresent,
      detail: "Frozen claims catalog benchmarks/flywheel-proof-claims.json is present and complete",
    },
    {
      id: "runner-scripts",
      ok: selectedSteps(true).every((step) => fileExists(step.script)),
      detail: "Existing bench runners are on disk (no new ML features)",
    },
  ];

  if (input.mode === "live") {
    const ran = input.steps.filter((step) => !step.skipped);
    items.push({
      id: "live-suite",
      ok: ran.length > 0 && ran.every((step) => step.exitCode === 0),
      detail: "Essential suite processes exited 0",
    });
    items.push({
      id: "live-json",
      ok: ran.every((step) => step.jsonArtifactExists),
      detail: "Machine-readable JSON written under benchmarks/.cache/",
    });
  } else {
    items.push({
      id: "live-suite",
      ok: true,
      detail: "Skipped (dry-run). Re-run without --dry-run to execute benches.",
    });
  }

  return items;
}

function claimsCatalogOk(): boolean {
  if (!fileExists(CLAIMS_CATALOG_REL)) return false;
  const ids = new Set(PUBLISHED_SELF_TEST_CLAIMS.map((claim) => claim.id));
  return REQUIRED_CLAIM_IDS.every((id) => ids.has(id));
}

function publishedNumeric(suite: string, metric: string): number | undefined {
  return PUBLISHED_SELF_TEST_CLAIMS.find((claim) => claim.suite === suite && claim.metric === metric)
    ?.numeric;
}

function extractLiveMetrics(withToken: boolean): LiveMetric[] {
  const retrieval = readJsonRecord("benchmarks/.cache/retrieval-eval-results.json");
  const retrievalOverall = asRecord(retrieval?.overall);
  const skillAb = readJsonRecord("benchmarks/.cache/skill-ab-results.json");
  const memoryAb = readJsonRecord("benchmarks/.cache/memory-ab-results.json");
  const token = readJsonRecord("benchmarks/.cache/token-bench-results.json");
  const tokenTotals = asRecord(token?.totals);

  const rows: LiveMetric[] = [
    metricRow(
      "retrieval",
      "hitRateAt5",
      numericField(retrievalOverall, "hitRateAt5"),
      publishedNumeric("retrieval", "hitRateAt5") ?? 1,
      stringField(retrieval, "commit")
    ),
    metricRow(
      "retrieval",
      "mrr",
      numericField(retrievalOverall, "mrr"),
      publishedNumeric("retrieval", "mrr") ?? 0.836,
      stringField(retrieval, "commit")
    ),
    metricRow(
      "retrieval",
      "ndcgAt5",
      numericField(retrievalOverall, "ndcgAt5"),
      publishedNumeric("retrieval", "ndcgAt5") ?? 0.671,
      stringField(retrieval, "commit")
    ),
    metricRow(
      "skill-ab",
      "successRateA",
      numericField(skillAb, "successRateA"),
      publishedNumeric("skill-ab", "successRateA") ?? 1,
      stringField(skillAb, "commit")
    ),
    metricRow(
      "skill-ab",
      "successRateB",
      numericField(skillAb, "successRateB"),
      publishedNumeric("skill-ab", "successRateB") ?? 0.615,
      stringField(skillAb, "commit")
    ),
    metricRow(
      "memory-ab",
      "successRateA",
      numericField(memoryAb, "successRateA"),
      publishedNumeric("memory-ab", "successRateA") ?? 1,
      stringField(memoryAb, "commit")
    ),
    metricRow(
      "memory-ab",
      "successRateB",
      numericField(memoryAb, "successRateB"),
      publishedNumeric("memory-ab", "successRateB") ?? 0.565,
      stringField(memoryAb, "commit")
    ),
  ];

  if (withToken) {
    rows.push(
      metricRow(
        "token",
        "savingsPercent",
        numericField(tokenTotals, "savingsPercent"),
        publishedNumeric("token", "savingsPercent") ?? 98.2,
        stringField(token, "commit")
      )
    );
  }
  return rows;
}

function metricRow(
  suite: string,
  metric: string,
  value: number | null,
  published: number,
  commit: string | null
): LiveMetric {
  return {
    suite,
    metric,
    value,
    published,
    match: value === null ? null : nearlyEqual(value, published),
    commit,
  };
}

export function buildDryProofSummary(withToken = false): FlywheelProofSummary {
  return finalizeSummary({
    mode: "dry-run",
    withToken,
    steps: selectedSteps(false).map((step) => ({
      id: step.id,
      title: step.title,
      skipped: true,
      exitCode: null,
      jsonArtifactExists: fileExists(step.jsonArtifact),
      humanArtifactExists: fileExists(step.humanArtifact),
    })),
    liveMetrics: null,
  });
}

function finalizeSummary(input: {
  mode: "dry-run" | "live";
  withToken: boolean;
  steps: StepRunResult[];
  liveMetrics: LiveMetric[] | null;
}): FlywheelProofSummary {
  const claimsPresent = claimsCatalogOk();
  const checklist = buildChecklist({
    mode: input.mode,
    steps: input.steps,
    claimsPresent,
  });
  const structuralPass = checklist
    .filter((item) => item.id !== "live-suite" && item.id !== "live-json")
    .every((item) => item.ok);
  const liveOk =
    input.mode === "dry-run" ||
    checklist.filter((item) => item.id === "live-suite" || item.id === "live-json").every((item) => item.ok);
  const claimMatch =
    input.liveMetrics === null
      ? null
      : input.liveMetrics.every((row) => row.match === true);
  const meta = benchMeta("flywheel-proof");
  return {
    ...meta,
    mode: input.mode,
    pass: structuralPass && liveOk,
    structuralPass,
    claimMatch,
    disclaimer: DISCLAIMER,
    steps: input.steps,
    publishedClaims: PUBLISHED_SELF_TEST_CLAIMS.filter(
      (claim) => input.withToken || claim.suite !== "token"
    ),
    liveMetrics: input.liveMetrics,
    checklist,
    withToken: input.withToken,
    reportIssueTitle: `[benchmark] Independent reproduction — ${getCommitHash()}`,
    docs: [
      "docs/flywheel-reproduction.md",
      "benchmarks/README.md",
      "docs/benchmark-standards.md",
    ],
  };
}

export function formatHumanChecklist(summary: FlywheelProofSummary): string {
  const yn = (ok: boolean): string => (ok ? "YES" : "NO");
  const box = (ok: boolean): string => (ok ? "[x]" : "[ ]");
  const lines = [
    "GraphFlow flywheel proof",
    "========================",
    `Mode: ${summary.mode}`,
    `Commit: ${summary.commit}`,
    `Structural pass: ${yn(summary.structuralPass)}`,
    `Overall pass: ${yn(summary.pass)}`,
    `Claim match vs published self-test: ${
      summary.claimMatch === null ? "n/a (dry-run or missing live JSON)" : yn(summary.claimMatch)
    }`,
    "",
    summary.disclaimer,
    "",
    "Published self-test claims (author-run):",
  ];
  for (const claim of summary.publishedClaims) {
    lines.push(`- ${claim.suite} ${claim.metric} = ${claim.display}  [${claim.sourceFile}]`);
  }
  lines.push("", "Checklist:");
  for (const item of summary.checklist) {
    lines.push(`${box(item.ok)} ${item.detail}`);
  }
  lines.push(
    "",
    "What pass means:",
    "- dry-run: entrypoint, docs, tracked reports, open dataset, and frozen claims catalog are present.",
    "- live: every selected bench exits 0 and writes commit-anchored JSON under benchmarks/.cache/.",
    "- Matching published percentages is informational. Same commit should match; cross-commit src/ drift is not a failure.",
    "- Live runners rewrite *-RESULTS.md in the working tree; compare JSON to benchmarks/flywheel-proof-claims.json, not the regenerated markdown.",
    "",
    `Report: open a GitHub issue titled ${summary.reportIssueTitle}`,
    "Attach benchmarks/.cache/*.json (or paste key totals) plus Node/OS.",
    "Guide: docs/flywheel-reproduction.md"
  );
  return `${lines.join("\n")}\n`;
}

function runStep(step: ProofSuiteStep): StepRunResult {
  const result = spawnSync("npx", ["tsx", step.script], {
    cwd: REPO_ROOT,
    stdio: "inherit",
    env: {
      ...process.env,
      GRAPHFLOW_SKIP_EMBEDDING_WARMUP: process.env.GRAPHFLOW_SKIP_EMBEDDING_WARMUP ?? "1",
    },
  });
  return {
    id: step.id,
    title: step.title,
    skipped: false,
    exitCode: result.status,
    jsonArtifactExists: fileExists(step.jsonArtifact),
    humanArtifactExists: fileExists(step.humanArtifact),
  };
}

export function runFlywheelProof(args: ProofArgs): FlywheelProofSummary {
  if (args.dryRun) return buildDryProofSummary(args.withToken);

  const steps = selectedSteps(args.withToken).map(runStep);
  return finalizeSummary({
    mode: "live",
    withToken: args.withToken,
    steps,
    liveMetrics: extractLiveMetrics(args.withToken),
  });
}

export function emitProofOutput(
  summary: FlywheelProofSummary,
  args: ProofArgs,
  write: (chunk: string) => void = (chunk) => {
    process.stdout.write(chunk);
  }
): void {
  if (!args.jsonOnly) write(formatHumanChecklist(summary));
  write(`${JSON.stringify(summary, null, 2)}\n`);
  if (args.dryRun) return;
  const outputPath = args.outputPath
    ? join(REPO_ROOT, args.outputPath)
    : DEFAULT_SUMMARY_PATH;
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  if (!args.jsonOnly) write(`\nWrote ${outputPath}\n`);
}

export function main(argv: readonly string[] = process.argv.slice(2)): number {
  const args = parseProofArgs(argv);
  if (args.help) {
    process.stdout.write(PROOF_USAGE);
    return 0;
  }
  const summary = runFlywheelProof(args);
  emitProofOutput(summary, args);
  return summary.pass ? 0 : 1;
}

const isMain =
  process.argv[1] &&
  fileURLToPath(import.meta.url).endsWith(process.argv[1].replace(/\\/g, "/").split("/").pop() ?? "");
if (isMain) {
  process.exitCode = main();
}
