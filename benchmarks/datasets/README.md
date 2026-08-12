# Retrieval golden dataset (v1)

Open / downloadable code-domain retrieval evaluation set for GraphFlow.

| Artifact | Description |
| --- | --- |
| [`retrieval-golden-v1.json`](retrieval-golden-v1.json) | Full document (metadata + queries + negatives) |
| [`retrieval-golden-v1.jsonl`](retrieval-golden-v1.jsonl) | One JSON object per line (`type: query` \| `negative`) |

- **License:** Apache-2.0 (see repo root `LICENSE`)
- **Source of truth:** `../retrieval-golden-data.ts` — regenerate with `npm run dataset:retrieval`
- **Evaluate:** `npm run bench:retrieval` (see [`../README.md`](../README.md))

Do not hand-edit these files; edit the TypeScript source and regenerate.
