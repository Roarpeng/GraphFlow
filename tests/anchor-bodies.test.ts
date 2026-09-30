import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createGraphClient } from "../src/graph/client-factory";
import { indexWorkspaceFiles, indexSingleFile } from "../src/graph/file-indexer";
import { buildLayeredContextPackage } from "../src/graph/context-slicer";
import { expandAnchor } from "../src/surfaces/cli/runtime/graph";
import { resolveConfig } from "../src/config/resolve";

/**
 * Anchors used to be id-only: the pack could name the right symbol and still
 * cover none of it, so the agent paid another round trip for the body
 * (measured: anchorRecall 92% against bodyCoverage 1%). These tests pin the
 * opposite behaviour, and pin that an unverifiable body stays a pointer.
 */

const root = join(tmpdir(), `graphflow-anchor-bodies-${Date.now()}`);
const configPath = join(root, "graphflow.config.json");

const SOURCE = `import { helper } from "./util";

export function computeHash(input: string): string {
  const padded = input.padEnd(8, " ");
  return helper(padded);
}

export function processData(data: string): string {
  return computeHash(data);
}
`;

function writeSource(text: string): void {
  writeFileSync(join(root, "sample.ts"), text);
}

function config(workspaceRoot: string) {
  return {
    providers: { openai: {} },
    tiers: {
      smart: { provider: "openai", model: "test" },
      economy: { provider: "openai", model: "test" },
    },
    budgetPolicy: { runTokenCap: 2000 },
    graphPolicy: {
      enableAutoBuild: true,
      // File transport, not memory: expandAnchor resolves its own client from
      // the config path, so a per-process memory store would be empty there.
      transport: "file" as const,
      graphStorePath: join(workspaceRoot, "graph.json"),
      workspaceRoot,
      maxContextTokens: 1500,
      autoIndexOnRun: false,
      autoIndexOnPreview: false,
      autoIndexOnSave: false,
    },
    learningPolicy: {
      enableFlywheel: true,
      trainingCadence: "nightly" as const,
      exportPath: join(workspaceRoot, "learning.jsonl"),
    },
    embeddingPolicy: { enabled: false },
  };
}

function packageOptions(workspaceRoot: string, extra?: Record<string, unknown>) {
  return { workspaceRoot, ...extra } as Parameters<typeof buildLayeredContextPackage>[3];
}

beforeAll(() => {
  mkdirSync(root, { recursive: true });
  writeSource(SOURCE);
  writeFileSync(join(root, "util.ts"), `export function helper(v: string): string { return v; }\n`);
  writeFileSync(configPath, JSON.stringify(config(root)));
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

async function indexedClient() {
  const config = resolveConfig(configPath);
  const client = createGraphClient(config);
  await indexWorkspaceFiles(client, root);
  return { client, config };
}

describe("symbol extent", () => {
  it("indexes the end line and the parser signature of a symbol", async () => {
    const { client } = await indexedClient();
    const nodes = (client.readSnapshot?.()?.nodes ?? []).filter(
      (n) => n.type === "Symbol" && n.metadata?.file === "sample.ts"
    );
    expect(nodes.length).toBeGreaterThanOrEqual(2);
    const hash = nodes.find((n) => n.metadata?.name === "computeHash");
    expect(typeof hash?.metadata?.endLine).toBe("number");
    expect((hash?.metadata?.endLine as number) > (hash?.metadata?.line as number)).toBe(true);
    expect(String(hash?.metadata?.signature)).toContain("computeHash");
    client.close?.();
  });
});

describe("declaration bodies inside the pack", () => {
  it("quotes the body of a top symbol anchor", async () => {
    const { client } = await indexedClient();
    const pkg = await buildLayeredContextPackage(client, "computeHash padEnd", 1500, packageOptions(root));
    expect(pkg.bodies?.attached ?? 0).toBeGreaterThanOrEqual(1);
    // Bodies never claim more than their share of the pack, overshoot included.
    expect(pkg.bodies!.tokens).toBeLessThanOrEqual(Math.floor(1500 * 0.2));
    const bodyLine = pkg.summaryChannel.find((line) => line.startsWith("body symbol:"));
    expect(bodyLine, "the pack should carry a body line for the anchor it names").toBeDefined();
    expect(bodyLine).toContain("padEnd");
    client.close?.();
  });

  it("leaves a body as a pointer when it cannot be verified against the file", async () => {
    const { client } = await indexedClient();
    // The graph still says computeHash lives here; the file now has a different
    // symbol at that spot. Quoting the stored span would ship the wrong code.
    writeSource(
      `export function unrelatedThing(): number {
  return 42;
}
`
    );
    const pkg = await buildLayeredContextPackage(client, "computeHash padEnd", 1500, packageOptions(root));
    expect(pkg.bodies?.unverified ?? 0).toBeGreaterThanOrEqual(1);
    expect(pkg.summaryChannel.some((line) => line.startsWith("body symbol:") && line.includes("padEnd"))).toBe(false);
    writeSource(SOURCE);
    client.close?.();
  });

  it("never lets a body displace an anchor, and respects the kill switch", async () => {
    const { client } = await indexedClient();
    const tight = await buildLayeredContextPackage(client, "computeHash processData", 90, packageOptions(root));
    const off = await buildLayeredContextPackage(
      client,
      "computeHash processData",
      90,
      packageOptions(root, { enableSymbolBodies: false })
    );
    expect(off.bodies).toBeUndefined();
    expect(off.summaryChannel.some((line) => line.startsWith("body symbol:"))).toBe(false);
    // The invariant: bodies only spend what the anchor stages left behind, so
    // the anchor set is identical whichever way the switch is set.
    expect(tight.anchorChannel.map((a) => a.id)).toEqual(off.anchorChannel.map((a) => a.id));
    expect(tight.tokenEstimate).toBeLessThanOrEqual(90);
    if ((tight.bodies?.attached ?? 0) > 0) {
      expect(tight.summaryChannel.some((line) => line.startsWith("body symbol:"))).toBe(true);
    } else {
      expect(tight.bodies?.noBudget).toBeGreaterThanOrEqual(1);
    }
    client.close?.();
  });
});

describe("expandAnchor verifies the anchor before the agent trusts it", () => {
  it("reports exact while the file still matches", async () => {
    const { client } = await indexedClient();
    const id = (client.readSnapshot?.()?.nodes ?? []).find(
      (n) => n.type === "Symbol" && n.metadata?.name === "processData"
    )!.id;
    const expanded = await expandAnchor(id, configPath);
    expect(expanded?.verified).toBe("exact");
    expect(expanded?.sourceSnippet).toContain("computeHash(data)");
    client.close?.();
  });

  it("relocates when code was inserted above the symbol", async () => {
    const { client } = await indexedClient();
    const node = (client.readSnapshot?.()?.nodes ?? []).find(
      (n) => n.type === "Symbol" && n.metadata?.name === "computeHash"
    )!;
    const indexedLine = node.metadata?.line as number;
    writeSource(`${"// padding\n".repeat(12)}${SOURCE}`);
    const expanded = await expandAnchor(node.id, configPath);
    expect(expanded?.verified).toBe("relocated");
    expect(expanded?.sourceSnippet).toContain("function computeHash");
    expect(expanded?.sourceLine).toBe(indexedLine);
    await indexSingleFile(client, root, join(root, "sample.ts"));
    client.close?.();
    writeSource(SOURCE);
  });

  it("says drifted when the symbol is gone rather than quoting a neighbour", async () => {
    const { client } = await indexedClient();
    const node = (client.readSnapshot?.()?.nodes ?? []).find(
      (n) => n.type === "Symbol" && n.metadata?.name === "computeHash"
    )!;
    writeSource(`export const somethingElse = 1;\n`);
    const expanded = await expandAnchor(node.id, configPath);
    expect(expanded?.verified).toBe("drifted");
    expect(expanded?.sourceSnippet ?? "").not.toContain("padEnd");
    client.close?.();
    writeSource(SOURCE);
  });
});
