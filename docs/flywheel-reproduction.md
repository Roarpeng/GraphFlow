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

Copied into the frozen catalog [`benchmarks/flywheel-proof-claims.json`](../benchmarks/flywheel-proof-claims.json)
from the tracked reports (do not invent new scores). Compare your live JSON to
that catalog — not to README headlines, and not to `*-RESULTS.md` after a live
run (existing runners rewrite those files in the working tree).

| Claim | Display | Source file (committed) |
| --- | --- | --- |
| Retrieval Hit@5 (in-sample: author-written queries, no held-out split) | **100.0%** | `benchmarks/RETRIEVAL-EVAL-RESULTS.md` (commit `4cda2976270d870d5c46770f30dda6f7df4eedd7`, 2026-09-19) |
| Retrieval MRR | **0.779** | same |
| Retrieval NDCG@5 | **0.638** | same |
| Skill A/B target-surfaced (synthetic mechanism test, 13 held-out tasks) | **ON 61.5% (8/13) vs OFF 61.5% (8/13)** | `benchmarks/RESULTS.md` P1-2 (2026-09-30) |
| Memory A/B target-surfaced (synthetic mechanism test, 31 held-out tasks) | **ON 51.6% (16/31) vs OFF 61.3% (19/31)** | `benchmarks/RESULTS.md` P3 (2026-09-30) |
| Token ratio (optional; not a fidelity measure) | **95.6%** realistic arm (136,265 → 6,044) / **98.5%** naive-grep arm (410,725 → 6,044) | `benchmarks/RESULTS.md` token block (two baseline arms) |

The catalog's token claim is the realistic arm; `--with-token` compares it with
the live realistic arm (`totals.baselineTopKFilesFullText.savingsPercent`), never
with the naive-grep arm.

**Withdrawn (2026-09-30):** the earlier skill "ON 100% vs OFF 61.5%" and memory
"ON 100% vs OFF 56.5%" figures. They seeded one history entry per scored task,
written from the answer key, and scored Arm A (package **or** injected text)
differently from Arm B (package only). The runners now use a deterministic
train / held-out split, drop training history that names a held-out target, and
apply one criterion to both arms — which shows no transfer (skill) or a small
regression (memory: 3 tasks hurt because history nodes shift package ranking).

The pinned held-out evidence lives in
[`benchmarks/flywheel-proof-claims.json`](../benchmarks/flywheel-proof-claims.json):
the v2.0.3 20-query held-out audit measured Hit@5 65% (BM25 baseline 90%) and
2/5 on Chinese queries. The 100% golden-set figure above does not generalize.

Retrieval was re-baselined on 2026-09-19 (v1.24-era corpus): the
self-referential `src/` corpus grew through v1.12→v1.24, which shifts rank
metrics (Hit@5 stays 100%); repeat runs on the same tree are deterministic.

Honest scope (already documented in the source reports):

- Target-surfaced proxy ≠ live-LLM task completion. It checks whether the
  golden target lands in the package Top-5 or in injected memory text, with
  the same rule for both arms, on hand-built graphs.
- Token savings are token-count ratios; they do not check that the package
  still contains what is needed to answer.
- Token and retrieval corpora are this repository's `src/`. Uncommitted
  edits and later commits move the numbers.
- Skill injection (`SKILL-AB-RESULTS.md`) is a Jaccard / overhead harness.
  After the P0-2 noise gate it reports **0% hint injection** and **100%
  episode recall** on the fixture history. There is currently no ROI claim:
  the P1-2 / P3 blocks show no transfer to held-out tasks.

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
| `--dry-run` | Entrypoint script exists, `package.json` has `proof:flywheel`, reproduction docs exist, tracked RESULTS + open dataset exist, and `benchmarks/flywheel-proof-claims.json` is present and complete. |
| live (default) | Dry-run structural checks **and** every selected bench exits 0 **and** its `.cache/*.json` was written. |

Live runs are allowed to rewrite `benchmarks/*-RESULTS.md`. That is existing
runner behavior. **Do not commit those regenerations** unless you intend to
update the frozen self-test catalog. `pass` does not require `claimMatch`.

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
