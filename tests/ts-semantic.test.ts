/**
 * L1 optional TypeScript compiler semantics — tests for `src/ts-semantic.ts`.
 *
 * Uses a real temporary TS project (path alias + barrel re-export + inherited method +
 * overload), plus a project with no tsconfig at all. Checks are grouped per provider (a
 * TypeScript LanguageService is intentionally not cheap to create, so we do not build one
 * per assertion). Skips cleanly when the optional `typescript` package cannot be loaded
 * (production installs omit devDependencies).
 *
 * Run: npx tsx tests/ts-semantic.test.ts
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  createTsSemanticProvider,
  disposeAllTsSemanticProviders,
  getTsSemanticProvider,
  getTypeScriptVersion,
  isTypeScriptAvailable,
  type TsSemanticProvider,
} from "../src/ts-semantic.js";

let passed = 0;
let failed = 0;

function check(name: string, fn: () => void): void {
  try {
    fn();
    passed += 1;
    console.log(`  PASS ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`  FAIL ${name}`);
    console.error(err);
  }
}

function write(root: string, relPath: string, content: string): void {
  const full = join(root, relPath);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content, "utf8");
}

function makeRoot(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function lineOf(lines: readonly string[], needle: string): number {
  const index = lines.findIndex((line) => line.includes(needle));
  assert.ok(index >= 0, `needle not found in fixture: ${needle}`);
  return index + 1;
}

function columnOf(lines: readonly string[], line: number, needle: string): number {
  const column = lines[line - 1]?.indexOf(needle) ?? -1;
  assert.ok(column >= 0, `needle not found on line ${line}: ${needle}`);
  return column;
}

interface TsFixture {
  root: string;
  app: string;
  appLines: string[];
}

function createTsFixture(): TsFixture {
  const root = makeRoot("gf-ts-semantic-");
  const appLines = [
    'import { A, B } from "@/barrel";',
    'import { Child } from "./child";',
    'import { pick } from "./over";',
    "",
    "export function useA(a: A): string {",
    "  return a.cancel();",
    "}",
    "",
    "export function useB(b: B): string {",
    "  return b.cancel();",
    "}",
    "",
    "export function useChild(c: Child): number {",
    "  return c.run();",
    "}",
    "",
    "export function choose(): number | string {",
    "  return pick(1);",
    "}",
    "",
  ];
  write(
    root,
    "tsconfig.json",
    JSON.stringify(
      {
        compilerOptions: {
          target: "ES2022",
          module: "CommonJS",
          moduleResolution: "node",
          baseUrl: ".",
          paths: { "@/*": ["src/*"] },
          strict: true,
          noEmit: true,
        },
        include: ["src"],
      },
      null,
      2
    ) + "\n"
  );
  write(root, "src/a.ts", 'export class A {\n  cancel(): string {\n    return "A";\n  }\n}\n');
  write(root, "src/b.ts", 'export class B {\n  cancel(): string {\n    return "B";\n  }\n}\n');
  write(root, "src/base.ts", "export class Base {\n  run(): number {\n    return 1;\n  }\n}\n");
  write(
    root,
    "src/child.ts",
    'import { Base } from "./base";\n\nexport class Child extends Base {\n  extra(): number {\n    return this.run();\n  }\n}\n'
  );
  write(root, "src/barrel.ts", 'export * from "./a";\nexport * from "./b";\n');
  write(
    root,
    "src/over.ts",
    "export function pick(value: number): number;\nexport function pick(value: string): string;\nexport function pick(value: number | string): number | string {\n  return value;\n}\n"
  );
  write(root, "src/app.ts", appLines.join("\n"));
  return { root, app: "src/app.ts", appLines };
}

if (!isTypeScriptAvailable()) {
  console.log("SKIP: optional typescript package not requireable; L1 TS semantics are disabled.");
  process.exit(0);
}
console.log(`Optional typescript@${getTypeScriptVersion() ?? "unknown"} loaded for L1 semantics.`);

// ── Group 1: one real checker project, many assertions (alias/barrel/inheritance/overload) ──
const fixture = createTsFixture();
const provider = createTsSemanticProvider({ rootDir: fixture.root });
try {
  assert.ok(provider, "provider must be created when typescript is available");

  check("barrel re-export + path alias: a.cancel() resolves to A.cancel in src/a.ts", () => {
    const line = lineOf(fixture.appLines, "a.cancel()");
    const target = provider?.resolveCallTarget(fixture.app, line, "cancel");
    assert.ok(target, `expected a target for a.cancel() on line ${line}`);
    assert.equal(target?.file, "src/a.ts");
    assert.equal(target?.symbol, "A.cancel");
    assert.equal(target?.kind, "method");
    assert.equal(target?.confidence, 1);
    assert.match(target?.reason ?? "", /type-checker signature/);
  });

  check("same-name method on another class: b.cancel() resolves to B.cancel, not A.cancel", () => {
    const line = lineOf(fixture.appLines, "b.cancel()");
    const target = provider?.resolveCallTarget(fixture.app, line, "cancel");
    assert.equal(target?.file, "src/b.ts");
    assert.equal(target?.symbol, "B.cancel");
  });

  check("inherited method: c.run() resolves to Base.run", () => {
    const line = lineOf(fixture.appLines, "c.run()");
    const target = provider?.resolveCallTarget(fixture.app, line, "run");
    assert.equal(target?.file, "src/base.ts");
    assert.equal(target?.symbol, "Base.run");
  });

  check("this.run() inside the subclass resolves to Base.run", () => {
    const childLines = [
      'import { Base } from "./base";',
      "",
      "export class Child extends Base {",
      "  extra(): number {",
      "    return this.run();",
      "  }",
      "}",
      "",
    ];
    const line = lineOf(childLines, "this.run()");
    const target = provider?.resolveCallTarget("src/child.ts", line, "this.run");
    assert.equal(target?.file, "src/base.ts");
    assert.equal(target?.symbol, "Base.run");
  });

  check("overload: pick(1) resolves through the checker to pick in src/over.ts", () => {
    const line = lineOf(fixture.appLines, "pick(1)");
    const target = provider?.resolveCallTarget(fixture.app, line, "pick");
    assert.equal(target?.file, "src/over.ts");
    assert.equal(target?.symbol, "pick");
    assert.equal(target?.kind, "function");
  });

  check("getReferences returns the call site + declaration and excludes the other class", () => {
    const callLine = lineOf(fixture.appLines, "a.cancel()");
    const callColumn = columnOf(fixture.appLines, callLine, "cancel");
    const refs = provider?.getReferences(fixture.app, callLine, callColumn) ?? [];
    assert.ok(refs.length >= 2, `expected >= 2 references, got ${refs.length}`);
    assert.ok(
      refs.some((ref) => ref.file === "src/app.ts" && ref.line === callLine && !ref.isDefinition),
      "a.cancel() call site must be referenced"
    );
    assert.ok(
      refs.some((ref) => ref.file === "src/a.ts" && ref.isDefinition),
      "A.cancel declaration must be referenced"
    );
    assert.ok(
      !refs.some((ref) => ref.file === "src/b.ts"),
      "references must not include the unrelated B.cancel"
    );
    const bLine = lineOf(fixture.appLines, "b.cancel()");
    assert.ok(
      !refs.some((ref) => ref.file === "src/app.ts" && ref.line === bLine),
      "references must not include the b.cancel() call"
    );
  });

  check("getReferences also works without an explicit character (line heuristic)", () => {
    const callLine = lineOf(fixture.appLines, "a.cancel()");
    const refs = provider?.getReferences(fixture.app, callLine) ?? [];
    assert.ok(
      refs.some((ref) => ref.file === "src/app.ts" && ref.line === callLine),
      "line-based lookup must include the call site"
    );
  });

  check("getTypeAt prints checked types (parameter annotation and subclass parameter)", () => {
    const aLine = lineOf(fixture.appLines, "a.cancel()");
    const aColumn = columnOf(fixture.appLines, aLine, "a.cancel");
    assert.equal(provider?.getTypeAt(fixture.app, aLine, aColumn), "A");

    const childLine = lineOf(fixture.appLines, "c.run()");
    const childColumn = columnOf(fixture.appLines, childLine, "c.run");
    assert.equal(provider?.getTypeAt(fixture.app, childLine, childColumn), "Child");
  });

  check("unknown files, lines and callees return undefined / [] instead of throwing", () => {
    const line = lineOf(fixture.appLines, "a.cancel()");
    assert.equal(provider?.resolveCallTarget("src/does-not-exist.ts", 1, "cancel"), undefined);
    assert.equal(provider?.resolveCallTarget(fixture.app, 9999, "cancel"), undefined);
    assert.equal(provider?.resolveCallTarget(fixture.app, line, "notARealMethod"), undefined);
    assert.deepEqual(provider?.getReferences("src/does-not-exist.ts", 1), []);
    assert.equal(provider?.getTypeAt("src/does-not-exist.ts", 1), undefined);
  });
} finally {
  provider?.dispose();
  disposeAllTsSemanticProviders();
  rmSync(fixture.root, { recursive: true, force: true });
}

// ── Group 2: project with no tsconfig (default compiler options + source discovery) ──
{
  const root = makeRoot("gf-ts-semantic-default-");
  try {
    const appLines = [
      'import { A } from "./a";',
      "",
      "export function use(a: A): string {",
      "  return a.cancel();",
      "}",
      "",
    ];
    write(root, "a.ts", 'export class A {\n  cancel(): string {\n    return "A";\n  }\n}\n');
    write(root, "app.ts", appLines.join("\n"));
    const defaultProvider = createTsSemanticProvider({ rootDir: root });
    try {
      check("missing tsconfig: default compiler options still resolve cross-file calls", () => {
        assert.ok(defaultProvider, "provider must be created without a tsconfig");
        const line = lineOf(appLines, "a.cancel()");
        const target = defaultProvider?.resolveCallTarget("app.ts", line, "cancel");
        assert.equal(target?.file, "a.ts");
        assert.equal(target?.symbol, "A.cancel");
        const column = columnOf(appLines, line, "a.cancel");
        assert.equal(defaultProvider?.getTypeAt("app.ts", line, column), "A");
      });
    } finally {
      defaultProvider?.dispose();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ── Group 3: per-root cache lifecycle + failure handling ──
{
  const cacheFixture = createTsFixture();
  try {
    check("per-root cache returns the same provider and dispose() invalidates it", () => {
      const first = getTsSemanticProvider(cacheFixture.root);
      const second = getTsSemanticProvider(cacheFixture.root);
      assert.ok(first && second, "cached provider must be available");
      assert.equal(first, second, "same root must return the cached provider");
      assert.equal(first?.disposed, false);
      first?.dispose();
      assert.equal(first?.disposed, true, "dispose() marks the provider disposed");
      const third = getTsSemanticProvider(cacheFixture.root);
      assert.ok(third, "a new provider must be created after disposal");
      assert.notEqual(third, first, "disposed provider must not be reused");
    });
  } finally {
    disposeAllTsSemanticProviders();
    rmSync(cacheFixture.root, { recursive: true, force: true });
  }
}

check("nonexistent rootDir is rejected gracefully", () => {
  const missing = join(
    tmpdir(),
    `gf-ts-semantic-missing-${Date.now()}-${Math.floor(Math.random() * 1e6)}`
  );
  assert.equal(createTsSemanticProvider({ rootDir: missing }), undefined);
  assert.equal(getTsSemanticProvider(missing), undefined);
  disposeAllTsSemanticProviders();
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
