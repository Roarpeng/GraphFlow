# Flywheel proof — third-party reproduction

> 第三方复现入口：一条命令跑公开飞轮 / 记忆 A/B / 检索自测，对照仓库里**已提交**的 RESULTS，而不是 README 摘要。
>
> **Self-test disclaimer:** every percentage quoted below is an **author-run**
> result already checked into this repository. This package does not invent
> new scores. Independent runs should produce their own JSON and compare.

This is the public entry for **path A: prove the flywheel** — a thin,
offline, API-key-free dogfood/evidence package. Methodology lives in
[`benchmark-standards.md`](benchmark-standards.md). Suite layout lives in
[`benchmarks/README.md`](../benchmarks/README.md).

## One command outsiders run

```bash
git clone https://github.com/Roarpeng/GraphFlow.git && cd GraphFlow
git checkout v1.15.1   # or any later tag / commit you want to pin
npm ci                 # Node >= 20, npm >= 10
npm run proof:flywheel
```

Dry path (no benches; validates the package and prints the published claims):

```bash
npm run proof:flywheel -- --dry-run
```

Help:

```bash
npm run proof:flywheel -- --help
```

Optional compression claim (not required for flywheel / memory / retrieval ROI):

```bash
npm run proof:flywheel -- --with-token
```

The full historical sequence (`retrieval` + `token` + `skill-ab` + `memory`)
remains `npm run bench:all`.

## What the essential suite is

| Step | npm script | Runner | Live JSON (gitignored) | Tracked human report |
| --- | --- | --- | --- | --- |
| Retrieval golden set | `bench:retrieval` | `benchmarks/run-retrieval-eval.ts` | `benchmarks/.cache/retrieval-eval-results.json` | [`RETRIEVAL-EVAL-RESULTS.md`](../benchmarks/RETRIEVAL-EVAL-RESULTS.md) |
| Skill injection / recall | `benchmark:skills` | `benchmarks/run-skill-ab-benchmark.ts` | `benchmarks/.cache/skill-injection-results.json` | [`SKILL-AB-RESULTS.md`](../benchmarks/SKILL-AB-RESULTS.md) |
| Skill flywheel A/B (P1-2) | `benchmark:ab` | `benchmarks/run-skill-ab.ts` | `benchmarks/.cache/skill-ab-results.json` | [`RESULTS.md`](../benchmarks/RESULTS.md) P1-2 block |
| Memory A/B (P3) | `benchmark:memory` | `benchmarks/run-memory-ab.ts` | `benchmarks/.cache/memory-ab-results.json` | [`RESULTS.md`](../benchmarks/RESULTS.md) P3 block |

Open dataset (downloadable without running TypeScript first):
[`benchmarks/datasets/retrieval-golden-v1.json`](../benchmarks/datasets/retrieval-golden-v1.json).

`scripts/ci-release-evidence.ts` is **internal CI dogfood** for release gates
(proven skill + fidelity samples on a fresh checkout). It is not this public
suite.

## Published self-test claims (already in git)

Copied from the tracked reports. Compare your live JSON to these files — not
to README headlines if they have drifted.

| Claim | Display | Source file (committed) |
| --- | --- | --- |
| Retrieval Hit@5 | **100.0%** | `benchmarks/RETRIEVAL-EVAL-RESULTS.md` (commit `3f457399c38026a48b529e88fce07de5af199a50`, 2026-08-04) |
| Retrieval MRR | **0.836** | same |
| Retrieval NDCG@5 | **0.671** | same |
| Skill A/B success proxy | **ON 100.0% (26/26) vs OFF 61.5% (16/26)** | `benchmarks/RESULTS.md` P1-2 (2026-08-04) |
| Memory A/B success proxy | **ON 100.0% (62/62) vs OFF 56.5% (35/62)** | `benchmarks/RESULTS.md` P3 (2026-08-04) |
| Token savings (optional) | **98.2%** (274,434 → 4,928) | `benchmarks/RESULTS.md` token block (2026-08-04) |

Honest scope (already documented in the source reports):

- Success proxy ≠ live-LLM task completion. It checks whether the golden
  target lands in Top-5 or injected memory text.
- Token and retrieval corpora are this repository's `src/`. Uncommitted
  edits and later commits move the numbers.
- Skill injection (`SKILL-AB-RESULTS.md`) is a Jaccard / overhead harness.
  After the P0-2 noise gate it reports **0% hint injection** and **100%
  episode recall** on the fixture history. The ROI claim is the P1-2 / P3
  success-proxy blocks, not the older "injection 100% / 25.6 tok" README
  line.

## Expected artifacts

After a live `npm run proof:flywheel`:

1. Process exit **0**.
2. Human checklist + JSON summary on stdout.
3. `benchmarks/.cache/flywheel-proof-summary.json` (machine-readable envelope:
   `schemaVersion`, `benchmark=flywheel-proof`, `generatedAt`, `commit`,
   `environment`, `pass`, `checklist`, `publishedClaims`, `liveMetrics`).
4. Per-suite JSON listed in the table above. Each runner JSON must include a
   commit field (`commit` or the shared `bench-meta` envelope).

Dry-run writes nothing under `.cache/`. It only checks that the package
(scripts, tracked reports, open dataset, claim needles) is intact.

## What "pass" means

| Mode | `pass` is true when |
| --- | --- |
| `--dry-run` | Entrypoint script exists, `package.json` has `proof:flywheel`, reproduction docs exist, tracked RESULTS + open dataset exist, and every published claim needle still appears in its source markdown. |
| live (default) | Dry-run structural checks **and** every selected bench exits 0 **and** its `.cache/*.json` was written. |

`claimMatch` is a **separate** field:

- Same git commit as the pinned report → expect identical key metrics.
- Different commit, especially on `src/`-backed retrieval / token → drift is
  expected. That is not a structural failure.
- Same commit + different numbers is a real finding — please report it.

## How to report an independent run

Open a GitHub issue titled:

```text
[benchmark] Independent reproduction — <commit>
```

Include Node version, OS, the summary JSON (or key totals), and any deviation
at the same commit. Deviations are the point of this package.

## Environment

- Node >= 20, npm >= 10, `git` on PATH for commit anchoring.
- Fully offline. No API keys. Embedding warmup is skipped
  (`GRAPHFLOW_SKIP_EMBEDDING_WARMUP=1`).
- Linux / macOS / Windows.
