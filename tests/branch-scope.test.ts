/**
 * Tests for branch-scoped graph caches and worktree isolation (`src/branch-scope.ts`).
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  branchScopeKey,
  currentGitBranch,
  describeBranchScope,
  graphCacheDir,
  graphCachePath,
  isSameRepositoryWorktree,
  resetBranchScopeState,
  resolveGitLocation,
} from "../src/branch-scope.js";
import { clearSemanticIndexCache, getSemanticIndex } from "../src/semantic-index.js";
import { clearWorkspaceNameIndex, getWorkspaceNameIndex } from "../src/name-index.js";
import { flushWorkspaceAstCaches, getWorkspaceAstIndex } from "../src/slicer.js";

let passed = 0;
let failed = 0;

function check(name: string, fn: () => void): void {
  try {
    resetBranchScopeState();
    clearSemanticIndexCache();
    clearWorkspaceNameIndex();
    fn();
    passed += 1;
    console.log(`PASS ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`FAIL ${name}`);
    console.error(err);
  }
}

function makeGitRepo(prefix = "gf-test-repo-"): { root: string; cleanup: () => void } {
  const root = join(tmpdir(), `${prefix}${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
  mkdirSync(root, { recursive: true });
  execFileSync("git", ["init", "-b", "main"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "TestUser"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root, stdio: "ignore" });

  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "index.ts"), "export const valueOnMain = 100;\n", "utf8");
  execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "Initial commit on main"], { cwd: root, stdio: "ignore" });

  return {
    root,
    cleanup: () => {
      try {
        rmSync(root, { recursive: true, force: true });
      } catch {
        // ignore
      }
    },
  };
}

check("1. Outside git repository, falls back to flat .graphflow layout", () => {
  const nonGitDir = join(tmpdir(), `gf-non-git-${Date.now()}`);
  mkdirSync(nonGitDir, { recursive: true });
  try {
    const branch = currentGitBranch(nonGitDir);
    assert.equal(branch, undefined);
    const key = branchScopeKey(nonGitDir);
    assert.equal(key, "");
    const dir = graphCacheDir(nonGitDir);
    assert.equal(dir, join(nonGitDir, ".graphflow"));
    assert.ok(describeBranchScope(nonGitDir).includes("n/a"));
  } finally {
    rmSync(nonGitDir, { recursive: true, force: true });
  }
});

check("2. Inside git repo, resolves branch name and branch-scoped cache directory", () => {
  const { root, cleanup } = makeGitRepo();
  try {
    const branch = currentGitBranch(root);
    assert.ok(branch, "branch must be detected");
    assert.equal(branch.name, "main");
    assert.equal(branch.detached, false);
    assert.ok(branch.key.startsWith("main-"), `key must start with main-: ${branch.key}`);

    const cacheDir = graphCacheDir(root);
    assert.equal(cacheDir, join(root, ".graphflow", "branches", branch.key));
    assert.ok(describeBranchScope(root).includes("branch: main"));
  } finally {
    cleanup();
  }
});

check("3. Switching git branch routes stores to distinct directories without pollution", () => {
  const { root, cleanup } = makeGitRepo();
  try {
    // 1. Build semantic index on main branch
    const semIndexMain = getSemanticIndex(root);
    const declsMain = semIndexMain.findDeclarations("valueOnMain");
    assert.equal(declsMain.length, 1);
    assert.equal(declsMain[0].name, "valueOnMain");

    // Check main cache path
    const mainBranch = currentGitBranch(root)!;
    const mainCachePath = graphCachePath(root, "semantic-index.json");
    assert.ok(mainCachePath.includes(mainBranch.key));

    // 2. Create and checkout a feature branch
    execFileSync("git", ["checkout", "-b", "feature/awesome"], { cwd: root, stdio: "ignore" });
    resetBranchScopeState(); // reset test state

    const featureBranch = currentGitBranch(root)!;
    assert.equal(featureBranch.name, "feature/awesome");
    assert.notEqual(featureBranch.key, mainBranch.key);

    const featureCachePath = graphCachePath(root, "semantic-index.json");
    assert.ok(featureCachePath.includes(featureBranch.key));
    assert.notEqual(mainCachePath, featureCachePath);

    // Write a new file on feature branch
    writeFileSync(join(root, "src", "feature.ts"), "export const valueOnFeature = 200;\n", "utf8");
    execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "Commit on feature"], { cwd: root, stdio: "ignore" });

    // Build semantic index on feature branch
    const semIndexFeature = getSemanticIndex(root);
    const declsFeature = semIndexFeature.findDeclarations("valueOnFeature");
    assert.equal(declsFeature.length, 1);
    assert.equal(declsFeature[0].name, "valueOnFeature");

    // 3. Switch back to main
    execFileSync("git", ["checkout", "main"], { cwd: root, stdio: "ignore" });
    resetBranchScopeState();

    const currentAfterSwitch = currentGitBranch(root)!;
    assert.equal(currentAfterSwitch.name, "main");
    assert.equal(currentAfterSwitch.key, mainBranch.key);

    // Semantic index on main must NOT have valueOnFeature
    const semIndexMainAgain = getSemanticIndex(root);
    const declsFeatureOnMain = semIndexMainAgain.findDeclarations("valueOnFeature");
    assert.equal(declsFeatureOnMain.length, 0, "Feature declarations must not leak into main");

    const declsMainAgain = semIndexMainAgain.findDeclarations("valueOnMain");
    assert.equal(declsMainAgain.length, 1, "Main declarations must remain intact");
  } finally {
    cleanup();
  }
});

check("4. WorkspaceAstIndex immediately invalidates 5s throttle upon branch switch", () => {
  const { root, cleanup } = makeGitRepo();
  try {
    const idx = getWorkspaceAstIndex(root);
    const filesBefore = idx.getFiles();
    assert.ok(filesBefore.includes("src/index.ts"));
    assert.ok(!filesBefore.includes("src/new-on-branch.ts"));

    // Create branch & file
    execFileSync("git", ["checkout", "-b", "branch-fast"], { cwd: root, stdio: "ignore" });
    writeFileSync(join(root, "src", "new-on-branch.ts"), "export const fast = 1;\n", "utf8");
    execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "add fast"], { cwd: root, stdio: "ignore" });

    resetBranchScopeState();

    // Calling getWorkspaceAstIndex should detect the branch switch and reset throttle
    const idxAfter = getWorkspaceAstIndex(root);
    const filesAfter = idxAfter.getFiles();
    assert.ok(filesAfter.includes("src/new-on-branch.ts"), "Must immediately see new branch file");
  } finally {
    cleanup();
  }
});

check("5. isSameRepositoryWorktree detects separate worktrees of same git repository", () => {
  const { root, cleanup } = makeGitRepo();
  const wtDir = join(tmpdir(), `gf-wt-${Date.now()}`);
  try {
    execFileSync("git", ["worktree", "add", wtDir, "-b", "wt-branch"], { cwd: root, stdio: "ignore" });

    assert.equal(isSameRepositoryWorktree(root, wtDir), true);
    assert.equal(isSameRepositoryWorktree(root, root), false);

    // Verify git locations
    const locMain = resolveGitLocation(root);
    const locWt = resolveGitLocation(wtDir);
    assert.ok(locMain);
    assert.ok(locWt);
    const norm = (p: string) => process.platform === "win32" ? p.toLowerCase() : p;
    assert.equal(norm(locMain.commonDir), norm(locWt.commonDir));
  } finally {
    try {
      execFileSync("git", ["worktree", "remove", "--force", wtDir], { cwd: root, stdio: "ignore" });
    } catch {
      // ignore
    }
    try {
      rmSync(wtDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
    cleanup();
  }
});

check("6. Nested worktree directory inside workspace is not indexed as child files", () => {
  const { root, cleanup } = makeGitRepo();
  const nestedWt = join(root, "nested-worktrees", "wt-sub");
  try {
    mkdirSync(join(root, "nested-worktrees"), { recursive: true });
    execFileSync("git", ["worktree", "add", nestedWt, "-b", "nested-branch"], { cwd: root, stdio: "ignore" });
    writeFileSync(join(nestedWt, "leak.ts"), "export const leak = 42;\n", "utf8");

    const idx = getWorkspaceAstIndex(root);
    const files = idx.getFiles(true);

    const hasLeak = files.some((f) => f.includes("leak.ts") || f.includes("nested-worktrees"));
    assert.equal(hasLeak, false, "Nested worktree files must not leak into parent repository file list");
  } finally {
    try {
      execFileSync("git", ["worktree", "remove", "--force", nestedWt], { cwd: root, stdio: "ignore" });
    } catch {
      // ignore
    }
    cleanup();
  }
});

check("7. Detached HEAD is recognized and isolated in its own bucket", () => {
  const { root, cleanup } = makeGitRepo();
  try {
    // Checkout HEAD~0 in detached mode
    execFileSync("git", ["checkout", "--detach", "HEAD"], { cwd: root, stdio: "ignore" });
    resetBranchScopeState();

    const branch = currentGitBranch(root);
    assert.ok(branch);
    assert.equal(branch.name, "detached");
    assert.equal(branch.detached, true);
    assert.ok(branch.key.startsWith("detached_"));
    assert.ok(describeBranchScope(root).includes("detached HEAD"));
  } finally {
    cleanup();
  }
});

check("8. GRAPHFLOW_BRANCH_SCOPE=0 disables branch scoping and uses root .graphflow", () => {
  const { root, cleanup } = makeGitRepo();
  const prevEnv = process.env.GRAPHFLOW_BRANCH_SCOPE;
  try {
    process.env.GRAPHFLOW_BRANCH_SCOPE = "0";
    resetBranchScopeState();

    const dir = graphCacheDir(root);
    assert.equal(dir, join(root, ".graphflow"));
    assert.equal(branchScopeKey(root), "");
    assert.ok(describeBranchScope(root).includes("off"));
  } finally {
    if (prevEnv !== undefined) process.env.GRAPHFLOW_BRANCH_SCOPE = prevEnv;
    else delete process.env.GRAPHFLOW_BRANCH_SCOPE;
    resetBranchScopeState();
    cleanup();
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
