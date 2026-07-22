#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");

const copyPairs = [
  {
    source: "src/surfaces/trae-rules/graphflow.md",
    targets: [
      ".trae/rules/graphflow.md",
      ".agent/rules/graphflow.md",
      ".claude/rules/graphflow.md",
    ],
  },
  {
    source: "src/surfaces/copilot-instructions/graphflow.md",
    targets: [".github/copilot-instructions.md"],
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
