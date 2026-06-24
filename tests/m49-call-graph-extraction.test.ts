import { describe, expect, it } from "vitest";
import { typescriptIndexer } from "../src/graph/language-indexers/typescript";
import { GraphifyClient } from "../src/graph/graphify-client";
import { indexWorkspaceFiles } from "../src/graph/file-indexer";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("M49 call graph and inheritance extraction", () => {
  // ── Task 1: TS indexer extracts function calls ─────────────────────
  it("should extract call relations from TypeScript function calls", () => {
    const code = `
export function greet(name: string): string {
  return formatName(name);
}

function formatName(name: string): string {
  return name.trim();
}

export function main(): void {
  greet("world");
  console.log("done");
}
`;
    const result = typescriptIndexer.extract("test.ts", code);

    expect(result.calls).toBeDefined();
    expect(result.calls!.length).toBeGreaterThan(0);

    // greet() calls formatName()
    const greetCallsFormat = result.calls!.find(
      (c) => c.callee === "formatName" && c.caller === "greet"
    );
    expect(greetCallsFormat).toBeDefined();

    // main() calls greet()
    const mainCallsGreet = result.calls!.find(
      (c) => c.callee === "greet" && c.caller === "main"
    );
    expect(mainCallsGreet).toBeDefined();

    // main() calls log (property access)
    const mainCallsLog = result.calls!.find(
      (c) => c.callee === "log" && c.caller === "main"
    );
    expect(mainCallsLog).toBeDefined();
  });

  // ── Task 2: TS indexer extracts inheritance ────────────────────────
  it("should extract inheritance relations from TypeScript class/interface", () => {
    const code = `
export interface Animal {
  name: string;
}

export interface Dog extends Animal {
  bark(): void;
}

export class BaseRepository {
  save(): void {}
}

export class UserRepository extends BaseRepository {
  findById(): string { return ""; }
}

export class AuthService implements Animal {
  name: string = "auth";
}
`;
    const result = typescriptIndexer.extract("test.ts", code);

    expect(result.inherits).toBeDefined();
    expect(result.inherits!.length).toBe(3);

    // Dog extends Animal
    const dogExtendsAnimal = result.inherits!.find(
      (r) => r.child === "Dog" && r.parent === "Animal" && r.kind === "extends"
    );
    expect(dogExtendsAnimal).toBeDefined();

    // UserRepository extends BaseRepository
    const userRepoExtends = result.inherits!.find(
      (r) => r.child === "UserRepository" && r.parent === "BaseRepository" && r.kind === "extends"
    );
    expect(userRepoExtends).toBeDefined();

    // AuthService implements Animal
    const authImplements = result.inherits!.find(
      (r) => r.child === "AuthService" && r.parent === "Animal" && r.kind === "implements"
    );
    expect(authImplements).toBeDefined();
  });

  // ── Task 3: file-indexer creates calls/inherits edges ──────────────
  it("should create calls and inherits edges in the graph", async () => {
    const tmpDir = join(tmpdir(), `graphflow-m49-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });

    const code = `
export function helper(): string { return "ok"; }

export function caller(): string {
  return helper();
}

export class Base { 
  baseMethod(): void {}
}

export class Derived extends Base {
  childMethod(): void {
    caller();
  }
}
`;
    writeFileSync(join(tmpDir, "sample.ts"), code);

    try {
      const client = new GraphifyClient();
      await indexWorkspaceFiles(client, tmpDir);

      const snapshot = client.snapshot();
      const edges = snapshot.edges;

      // Should have at least one "calls" edge (caller → helper)
      const callsEdges = edges.filter((e) => e.relation === "calls");
      expect(callsEdges.length).toBeGreaterThan(0);

      // Should have at least one "inherits" edge (Derived → Base)
      const inheritsEdges = edges.filter((e) => e.relation === "inherits");
      expect(inheritsEdges.length).toBeGreaterThan(0);

      // Verify the inherits edge connects Derived to Base
      const derivedNode = snapshot.nodes.find(
        (n) => n.type === "Symbol" && n.metadata?.name === "Derived"
      );
      const baseNode = snapshot.nodes.find(
        (n) => n.type === "Symbol" && n.metadata?.name === "Base"
      );
      expect(derivedNode).toBeDefined();
      expect(baseNode).toBeDefined();

      const inheritEdge = inheritsEdges.find(
        (e) => e.from === derivedNode!.id && e.to === baseNode!.id
      );
      expect(inheritEdge).toBeDefined();

      // Verify the calls edge connects caller to helper
      const callerNode = snapshot.nodes.find(
        (n) => n.type === "Symbol" && n.metadata?.name === "caller"
      );
      const helperNode = snapshot.nodes.find(
        (n) => n.type === "Symbol" && n.metadata?.name === "helper"
      );
      expect(callerNode).toBeDefined();
      expect(helperNode).toBeDefined();

      const callEdge = callsEdges.find(
        (e) => e.from === callerNode!.id && e.to === helperNode!.id
      );
      expect(callEdge).toBeDefined();
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // ── Task 4: call graph edges have proper weight in compression ─────
  it("should include calls and inherits in DEFAULT_EDGE_WEIGHTS", async () => {
    const { DEFAULT_EDGE_WEIGHTS } = await import("../src/graph/graph-compression");
    expect(DEFAULT_EDGE_WEIGHTS.calls).toBeDefined();
    expect(DEFAULT_EDGE_WEIGHTS.inherits).toBeDefined();
    expect(DEFAULT_EDGE_WEIGHTS.calls).toBeGreaterThan(0);
    expect(DEFAULT_EDGE_WEIGHTS.inherits).toBeGreaterThan(0);
  });
});
