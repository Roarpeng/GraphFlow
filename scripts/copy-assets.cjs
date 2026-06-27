#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDir(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

const projectRoot = path.join(__dirname, "..");
const skillSrc = path.join(projectRoot, "src", "surfaces", "trae-skill");
const skillDest = path.join(projectRoot, "dist", "surfaces", "trae-skill");

if (fs.existsSync(skillSrc)) {
  copyDir(skillSrc, skillDest);
  console.log("[build] Copied trae-skill assets to dist/");
} else {
  console.warn("[build] trae-skill source not found, skipping");
}

const rulesSrc = path.join(projectRoot, "src", "surfaces", "cursor-rules");
const rulesDest = path.join(projectRoot, "dist", "surfaces", "cursor-rules");

if (fs.existsSync(rulesSrc)) {
  copyDir(rulesSrc, rulesDest);
  console.log("[build] Copied cursor-rules assets to dist/");
} else {
  console.warn("[build] cursor-rules source not found, skipping");
}

if (!fs.existsSync(path.join(projectRoot, "wasm"))) {
  console.warn("[build] wasm/ not found — run npm run wasm:bundle");
}
