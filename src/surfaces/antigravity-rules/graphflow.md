# GraphFlow Token-First Rule (Antigravity)

GraphFlow is a graph-based context and planning MCP service. **You MUST use it before broad file search or reading many files.**

## Mandatory workflow

Before code exploration, implementation, debugging, review, planning, or architecture questions:

1. Call MCP tool **`graphflow_context`** with the user's task/query and **`rootDir`** set to the current project absolute path.
2. Use returned `summary`, `anchors`, `refillPreview`, and `tokenBudget` as the primary context.
3. Read full files only when anchors point there, compressed context is insufficient, or exact edits require the file body.
4. For multi-step or ambiguous work, call **`graphflow_plan`** before implementation.
5. After major file changes, call **`graphflow_index`** (or pass `filePath` for single-file index).

**Do NOT** recursively grep the whole repository or read large files before GraphFlow preview.

## Chinese / CJK queries

Code symbols are mostly English. For Chinese user questions:

1. **Proactive:** Translate intent to English **file/class/component names** and pass **`englishQuery`** (e.g. `PoseDetectionPage`, `BattlePage`, `shieldEffect`). Avoid generic `exercise` when the user means UI/camera.
2. **Module families (store/slices):** Prefer file stems (`useGameStore companionSlice dailySlice`), not bare domain words like `monster` (often hits `data/monsters` instead of `monsterSlice`).
3. **Reactive:** If preview returns `agentWorkItems` with `query-translate-en`, answer the JSON prompt, then retry with `englishQuery`.
4. Keep `query` as the original Chinese text.

```typescript
graphflow_context({
  query: "摄像头锻炼人物角色选择",
  englishQuery: "PoseDetectionPage avatarMode poseService",
  rootDir: "/absolute/path/to/project"
})
```

## High-frequency MCP tools

| Tool | When |
|------|------|
| `graphflow_context` | **Always first** for code questions (use `query`); need full content of one anchor (use `anchorId`) |
| `graphflow_plan` | Multi-step tasks |
| `graphflow_index` | After significant edits |

For the full 10-tool reference and workflows, use Skill **`graphflow`** in `~/.gemini/antigravity/skills/graphflow/SKILL.md` or `.agent/skills/graphflow/SKILL.md`.

## Bridge mode

After `graphflow_run`, **must** call `graphflow_report_outcome` with `episodeId`, `success`, and optional `lessons`.
