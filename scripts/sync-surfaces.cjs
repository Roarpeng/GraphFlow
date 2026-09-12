#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");

/**
 * Canonical source → checked-in mirror.
 *
 * Each mirror must point at the source the installer actually copies from
 * (`src/integrations/skill-installer.ts`) or the next `sync:surfaces` run
 * silently overwrites a host's rule file with another host's text:
 * `.agent/rules` belongs to Antigravity, `.claude/rules` + `.windsurfrules` +
 * `AGENTS.md` are mirrors of the root `CLAUDE.md`.
 */
const copyPairs = [
  {
    source: "skills/graphflow/SKILL.md",
    targets: [
      "src/surfaces/trae-skill/graphflow/SKILL.md",
      ".trae/skills/graphflow/SKILL.md",
      ".agent/skills/graphflow/SKILL.md",
    ],
  },
  {
    source: "src/surfaces/trae-rules/graphflow.md",
    targets: [".trae/rules/graphflow.md"],
  },
  {
    source: "src/surfaces/antigravity-rules/graphflow.md",
    targets: [".agent/rules/graphflow.md"],
  },
  {
    source: "src/surfaces/cursor-rules/graphflow.mdc",
    targets: [".cursor/rules/graphflow.mdc"],
  },
  {
    source: "src/surfaces/copilot-instructions/graphflow.md",
    targets: [".github/copilot-instructions.md"],
  },
  {
    source: "CLAUDE.md",
    targets: [".claude/rules/graphflow.md", ".windsurfrules", "AGENTS.md"],
  },
];

const checkOnly = process.argv.includes("--check");

let dirty = false;

for (const { source, targets } of copyPairs) {
  const sourcePath = path.join(ROOT, source);
  const sourceContent = fs.readFileSync(sourcePath, "utf-8");

  for (const target of targets) {
    const targetPath = path.join(ROOT, target);

    if (!checkOnly) {
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      fs.writeFileSync(targetPath, sourceContent, "utf-8");
      console.log(`  synced ${target}`);
      continue;
    }

    let targetContent;
    try {
      targetContent = fs.readFileSync(targetPath, "utf-8");
    } catch {
      console.error(`  MISSING ${target}`);
      dirty = true;
      continue;
    }

    if (sourceContent !== targetContent) {
      console.error(`  DIRTY  ${target}`);
      dirty = true;
    } else {
      console.log(`  OK     ${target}`);
    }
  }
}

if (checkOnly) {
  if (dirty) {
    console.error("\nSurface copies are out of date. Run: npm run sync:surfaces");
    process.exit(1);
  }
  console.log("\nAll surfaces in sync.");
}
