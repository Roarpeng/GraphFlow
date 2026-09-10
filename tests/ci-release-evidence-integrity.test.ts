/**
 * Integrity locks for scripts/ci-release-evidence.ts.
 *
 * The release-evidence script feeds the publish gate, so its evidence must be
 * structurally incapable of passing tautologically:
 *
 *  - Expected anchors are a PURE function of the committed golden dataset
 *    (benchmarks/datasets/retrieval-golden-v1.json) / committed ground-truth
 *    constants plus the on-disk src/ layout — never of what the retriever
 *    returned. A deliberately degraded returned set must yield recall < 1.0
 *    (the old code filtered the returned ids, so recall was 1.0 by
 *    construction and the gate could not observe retrieval quality).
 *  - Body coverage must be fed real expected/packaged bodies so the
 *    normalized-LCS metric in src/graph/token-savings.ts is exercised.
 *  - The pipeline test result is an OBSERVED signal (env var, result file, or
 *    GitHub Actions publish-workflow step order) that defaults to "unknown" —
 *    never a self-asserted pass, never a fabricated user confirmation.
 *  - The regression-matrix size quoted in lessons is derived at runtime
 *    instead of a stale hardcoded constant.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  DEFAULT_TEST_RESULT_FILENAME,
  FIDELITY_PROBES,
  PUBLISH_WORKFLOW_NAME,
  TEST_RESULT_ENV_VAR,
  buildDogfoodLessons,
  countTestFiles,
  deriveExpectedAnchorIds,
  evaluateAnchorRecall,
  extractPackagedBody,
  listRepoSourceRelPaths,
  loadGoldenDataset,
  parseGoldenDataset,
  parseTestResultFileContent,
  resolveCanonicalFileAnchor,
  resolveTestResultSignal,
  type FidelityProbe,
  type GoldenQuery,
} from "../scripts/ci-release-evidence";

const repoRoot = process.cwd();
const scriptSource = readFileSync(
  join(repoRoot, "scripts", "ci-release-evidence.ts"),
  "utf8"
);

/** Fixtures mirror the real shapes: dataset entries and src/-relative paths. */
const SYNTHETIC_DATASET: GoldenQuery[] = [
  { id: "q024", query: "context slicer layered package", expectAny: ["context-slicer"] },
  { id: "q100", query: "mcp server tool definitions", expectAny: ["tool-definitions", "mcp"] },
];

const SYNTHETIC_SRC_LAYOUT = [
  "src/graph/context-slicer-types.ts",
  "src/graph/context-slicer-utils.ts",
  "src/graph/context-slicer.ts",
  "src/learning/dialogue-thread.ts",
  "src/surfaces/mcp/server.ts",
  "src/surfaces/mcp/tool-definitions.ts",
];

const COMMITTED_PROBE = FIDELITY_PROBES.find(
  (probe): probe is Extract<FidelityProbe, { kind: "committed" }> => probe.kind === "committed"
);

describe("anti-tautology: expectations never see the returned anchors", () => {
  it("deriveExpectedAnchorIds is a pure function of probe + dataset + repo layout", () => {
    // The signature is the contract: three inputs, none of them a retrieval
    // result. The expectation cannot adapt to what came back.
    expect(deriveExpectedAnchorIds.length).toBe(3);
    const probe: FidelityProbe = { kind: "golden", goldenId: "q024" };
    const expected = deriveExpectedAnchorIds(probe, SYNTHETIC_DATASET, SYNTHETIC_SRC_LAYOUT);
    expect(expected).toEqual(["file:src/graph/context-slicer.ts"]);
    expect(
      deriveExpectedAnchorIds(probe, SYNTHETIC_DATASET, SYNTHETIC_SRC_LAYOUT)
    ).toEqual(expected);
  });

  it("a degraded returned set yields recall < 1.0 (old code made this impossible)", () => {
    const expected = deriveExpectedAnchorIds(
      { kind: "golden", goldenId: "q024" },
      SYNTHETIC_DATASET,
      SYNTHETIC_SRC_LAYOUT
    );
    // Degraded retriever: only symbol/module anchors and an unrelated file —
    // the ground-truth File anchor is missing, so recall must drop below 1.
    const degradedReturned = [
      "symbol:src/graph/context-slicer.ts:buildLayeredContextPackage",
      "module:src/graph",
      "file:src/graph/repo-map.ts",
    ];
    const degraded = evaluateAnchorRecall(expected, degradedReturned);
    expect(degraded.recall).toBeLessThan(1);
    expect(degraded.missing).toEqual(expected);

    const healthy = evaluateAnchorRecall(expected, [...degradedReturned, ...expected]);
    expect(healthy.recall).toBe(1);
    expect(healthy.missing).toEqual([]);
  });

  it("canonical resolution picks the file the stem names, not split siblings", () => {
    expect(resolveCanonicalFileAnchor("context-slicer", SYNTHETIC_SRC_LAYOUT)).toBe(
      "file:src/graph/context-slicer.ts"
    );
    expect(resolveCanonicalFileAnchor("learning/dialogue-thread", SYNTHETIC_SRC_LAYOUT)).toBe(
      "file:src/learning/dialogue-thread.ts"
    );
    expect(resolveCanonicalFileAnchor("no-such-module", SYNTHETIC_SRC_LAYOUT)).toBeUndefined();
  });

  it("OR-style expectAny does not turn secondary stems into required anchors", () => {
    // q100's expectAny is ["tool-definitions", "mcp"]: a hit means ANY stem
    // appears, so the required expectation is the primary stem's canonical
    // file only — the broad "mcp" stem must not add a second required anchor.
    const expected = deriveExpectedAnchorIds(
      { kind: "golden", goldenId: "q100" },
      SYNTHETIC_DATASET,
      SYNTHETIC_SRC_LAYOUT
    );
    expect(expected).toEqual(["file:src/surfaces/mcp/tool-definitions.ts"]);
  });

  it("probes not covered by the golden dataset carry committed ground truth", () => {
    expect(COMMITTED_PROBE).toBeDefined();
    const expected = deriveExpectedAnchorIds(
      COMMITTED_PROBE!,
      SYNTHETIC_DATASET,
      SYNTHETIC_SRC_LAYOUT
    );
    expect(expected).toEqual(["file:src/learning/dialogue-thread.ts"]);
    // The committed constant must explain its ground truth.
    expect(COMMITTED_PROBE!.note.length).toBeGreaterThan(20);
  });

  it("golden-binding and layout drift fail loudly instead of weakening expectations", () => {
    expect(() =>
      deriveExpectedAnchorIds(
        { kind: "golden", goldenId: "q999" },
        SYNTHETIC_DATASET,
        SYNTHETIC_SRC_LAYOUT
      )
    ).toThrow(/q999/);
    expect(() =>
      deriveExpectedAnchorIds(
        { kind: "golden", goldenId: "q024" },
        SYNTHETIC_DATASET,
        ["src/graph/repo-map.ts"]
      )
    ).toThrow(/drifted/);
  });

  it("the script source no longer derives expectations from returned anchors", () => {
    // The original tautology was `returnedAnchorIds.filter(...)` feeding
    // expectedAnchorIds; lock that pattern out for good.
    expect(scriptSource).not.toMatch(/returnedAnchorIds\s*\.\s*filter/);
  });
});

describe("committed golden dataset binding", () => {
  it("parses the real retrieval-golden-v1.json and validates its shape", () => {
    const dataset = loadGoldenDataset(repoRoot);
    expect(dataset.length).toBeGreaterThan(100);
    for (const entry of dataset) {
      expect(entry.id).toMatch(/^q\d{3}$/);
      expect(entry.query.trim().length).toBeGreaterThan(0);
      expect(entry.expectAny.length).toBeGreaterThan(0);
    }
    expect(() => parseGoldenDataset("{}")).toThrow(/queries/);
    expect(() => parseGoldenDataset('{"queries":[{"id":"q1"}]}')).toThrow(/expectAny/);
  });

  it("every probe resolves against the real repo layout to an existing file", () => {
    const dataset = loadGoldenDataset(repoRoot);
    const repoPaths = listRepoSourceRelPaths(repoRoot);
    expect(repoPaths.length).toBeGreaterThan(100);
    for (const probe of FIDELITY_PROBES) {
      const expected = deriveExpectedAnchorIds(probe, dataset, repoPaths);
      expect(expected).toHaveLength(1);
      const anchorId = expected[0]!;
      expect(anchorId.startsWith("file:src/")).toBe(true);
      expect(existsSync(join(repoRoot, anchorId.slice("file:".length)))).toBe(true);
    }
  });
});

describe("body coverage is measured, not skipped", () => {
  it("extracts the packaged File summary body of the ground-truth file", () => {
    const summary = [
      "File: src/graph/context-slicer.ts # exports: buildContextSlice, buildLayeredContextPackage",
      "Symbol: buildLayeredContextPackage(client, query, maxTokens)",
    ];
    expect(extractPackagedBody(summary, "src/graph/context-slicer.ts")).toBe(
      "src/graph/context-slicer.ts # exports: buildContextSlice, buildLayeredContextPackage"
    );
  });

  it("returns an empty body when the package carries none (coverage must then be 0)", () => {
    expect(extractPackagedBody(["Symbol: unrelated"], "src/graph/context-slicer.ts")).toBe("");
    // A sibling file's summary must not masquerade as this file's body.
    expect(
      extractPackagedBody(
        ["File: src/graph/context-slicer-types.ts # exports: ContextLayer"],
        "src/graph/context-slicer.ts"
      )
    ).toBe("");
  });

  it("the script feeds expected and packaged bodies into recordContextFidelity", () => {
    expect(scriptSource).toMatch(/expectedBodies:/);
    expect(scriptSource).toMatch(/packagedBodies:/);
  });
});

describe("observed outcome, not asserted outcome", () => {
  it("defaults to unknown when no signal is present", () => {
    const observation = resolveTestResultSignal({}, undefined);
    expect(observation.result).toBe("unknown");
    expect(observation.origin).toBe("absent");
  });

  it("honors GRAPHFLOW_CI_TEST_RESULT and refuses junk values", () => {
    expect(
      resolveTestResultSignal({ [TEST_RESULT_ENV_VAR]: "pass" }, undefined)
    ).toMatchObject({ result: "pass", origin: "env" });
    expect(resolveTestResultSignal({ [TEST_RESULT_ENV_VAR]: "fail" }, undefined).result).toBe(
      "fail"
    );
    expect(
      resolveTestResultSignal({ [TEST_RESULT_ENV_VAR]: "passed-trust-me" }, undefined).result
    ).toBe("unknown");
  });

  it("reads the pipeline-written result file (JSON or bare token)", () => {
    expect(resolveTestResultSignal({}, '{"testResult":"pass"}')).toMatchObject({
      result: "pass",
      origin: "file",
    });
    expect(resolveTestResultSignal({}, "fail\n").result).toBe("fail");
    expect(parseTestResultFileContent("{broken json")).toBe("invalid");
    expect(parseTestResultFileContent('{"testResult":42}')).toBe("invalid");
    expect(DEFAULT_TEST_RESULT_FILENAME).toBe("ci-test-result.json");
  });

  it("infers pass only inside the publish workflow whose test step ran first", () => {
    const publish = resolveTestResultSignal(
      { GITHUB_ACTIONS: "true", GITHUB_WORKFLOW: PUBLISH_WORKFLOW_NAME },
      undefined
    );
    expect(publish).toMatchObject({
      result: "pass",
      origin: "github-actions-publish-workflow",
    });
    const otherWorkflow = resolveTestResultSignal(
      { GITHUB_ACTIONS: "true", GITHUB_WORKFLOW: "CI" },
      undefined
    );
    expect(otherWorkflow.result).toBe("unknown");
    const notActions = resolveTestResultSignal(
      { GITHUB_WORKFLOW: PUBLISH_WORKFLOW_NAME },
      undefined
    );
    expect(notActions.result).toBe("unknown");
  });

  it("an explicit env signal wins over the result file", () => {
    expect(
      resolveTestResultSignal({ [TEST_RESULT_ENV_VAR]: "fail" }, '{"testResult":"pass"}').result
    ).toBe("fail");
  });

  it("the script source never self-asserts a pass or a user confirmation", () => {
    expect(scriptSource).not.toMatch(/userConfirmed:\s*true/);
    expect(scriptSource).not.toMatch(/testResult:\s*"pass"/);
    expect(scriptSource).toMatch(/userConfirmed:\s*false/);
  });
});

describe("regression-matrix size is derived at runtime", () => {
  it("counts tests/ instead of hardcoding a stale constant", () => {
    const count = countTestFiles(join(repoRoot, "tests"));
    // The suite was 155 files at v1.16.0 and only grows; anything far below
    // means the walk broke (or the stale constant came back in disguise).
    expect(count).toBeGreaterThanOrEqual(150);
    const lessons = buildDogfoodLessons(count);
    expect(lessons.some((lesson) => lesson.includes(`(${count} files)`))).toBe(true);
    for (const lesson of lessons) {
      // reportOutcome's quality-lesson threshold is >= 8 chars.
      expect(lesson.length).toBeGreaterThanOrEqual(8);
    }
    expect(scriptSource).not.toMatch(/\(149 files\)/);
  });
});
