import { describe, expect, it } from "vitest";
import { createGraphClient } from "../src/graph/client-factory";
import { validateConfig } from "../src/config/loader";
import {
  admitMechanism,
  freezeMechanism,
  getMechanismReport,
  listMechanisms,
  parseMechanism,
  proposeMechanism,
  readMechanism,
  recordMechanismTrial,
  rejectMechanism,
} from "../src/learning/mechanism-research";

function memoryClient() {
  const config = validateConfig({
    providers: {},
    tiers: { smart: { provider: "openai" }, economy: { provider: "openai" } },
    budgetPolicy: { runTokenCap: 1000 },
    graphPolicy: { enableAutoBuild: true, transport: "memory", maxContextTokens: 1000 },
    learningPolicy: { enableFlywheel: true, trainingCadence: "nightly", exportPath: "graphflow-out/l.jsonl" },
  });
  return createGraphClient(config);
}

const proposal = {
  name: "Boundary compaction",
  family: "context" as const,
  claim: "Compact only at completed subtask boundaries to avoid paying the rewrite cost early",
  efficiencyMetric: "tokens",
};

describe("mechanism proposal", () => {
  it("stores a proposed mechanism as a Decision node and rejects structural noise", async () => {
    const client = memoryClient();
    const state = await proposeMechanism(client, proposal);
    expect(state.id).toBe("mechanism:boundary-compaction");
    expect(state.status).toBe("proposed");
    expect(state.trials).toEqual([]);
    expect(await readMechanism(client, state.id)).toBeDefined();
    expect(parseMechanism("{")).toBeUndefined();

    await expect(proposeMechanism(client, { ...proposal, name: "the and of" })).rejects.toThrow(/noise/);
    await expect(proposeMechanism(client, { ...proposal, claim: "too short" })).rejects.toThrow(/claim/);
    await expect(proposeMechanism(client, proposal)).rejects.toThrow(/already proposed/);
  });
});

describe("mechanism trials, held-out isolation and admission", () => {
  it("runs the full loop and admits only with a qualifying held-out trial", async () => {
    const client = memoryClient();
    const state = await proposeMechanism(client, proposal);

    const screened = await recordMechanismTrial(client, {
      id: state.id,
      phase: "in-trajectory",
      baseline: { tokens: 1000, responseCount: 5 },
      packaged: { tokens: 700, responseCount: 5 },
    });
    expect(screened.status).toBe("in-trajectory");
    expect(screened.trials[0].qualifies).toBe(true);

    const frozen = await freezeMechanism(client, state.id);
    expect(frozen.status).toBe("frozen");
    expect(frozen.frozenAt).toBeDefined();

    // Held-out isolation: no more training-split tuning after freeze.
    await expect(
      recordMechanismTrial(client, {
        id: state.id,
        phase: "in-trajectory",
        baseline: { tokens: 1000 },
        packaged: { tokens: 500 },
      })
    ).rejects.toThrow(/held-out isolation/);

    const heldOut = await recordMechanismTrial(client, {
      id: state.id,
      phase: "held-out",
      baseline: { tokens: 1000, score: 1, responseCount: 4 },
      packaged: { tokens: 600, score: 0.98, responseCount: 4 },
    });
    expect(heldOut.status).toBe("held-out");

    const result = await admitMechanism(client, state.id);
    expect(result.admitted).toBe(true);
    expect(result.state.status).toBe("admitted");
    expect(result.state.decision?.status).toBe("admitted");

    // Terminal decisions accept no new trials.
    await expect(
      recordMechanismTrial(client, { id: state.id, phase: "held-out", baseline: { tokens: 10 }, packaged: { tokens: 1 } })
    ).rejects.toThrow(/terminal|no new trials/);
  });

  it("refuses admission without a held-out trial and refuses freezing an unmeasured idea", async () => {
    const client = memoryClient();
    const state = await proposeMechanism(client, { ...proposal, name: "Early stop" });
    await expect(freezeMechanism(client, state.id)).rejects.toThrow(/no in-trajectory trial/);
    await expect(admitMechanism(client, state.id)).resolves.toMatchObject({ admitted: false });
  });

  it("refuses admission when the held-out trial regressed capability", async () => {
    const client = memoryClient();
    const state = await proposeMechanism(client, { ...proposal, name: "Aggressive pruning" });
    await recordMechanismTrial(client, { id: state.id, phase: "in-trajectory", baseline: { tokens: 1000 }, packaged: { tokens: 500 } });
    await freezeMechanism(client, state.id);
    await recordMechanismTrial(client, {
      id: state.id,
      phase: "held-out",
      baseline: { tokens: 1000, score: 1 },
      packaged: { tokens: 500, score: 0.2 },
    });
    const result = await admitMechanism(client, state.id);
    expect(result.admitted).toBe(false);
    expect(result.failures.join(";")).toMatch(/capability-regression:score/);
  });

  it("surfaces the exact evaluated record to the efficiency sink", async () => {
    const client = memoryClient();
    // tolerance 0.2: a 0.1 score dip must still qualify. If the sink re-scored
    // with the default 0.05 it would persist the opposite verdict.
    const state = await proposeMechanism(client, { ...proposal, name: "Sink trial", tolerance: 0.2 });
    const seen: Array<{ qualifies: boolean; scoreDeltaRatio?: number; query: string }> = [];
    await recordMechanismTrial(client, {
      id: state.id,
      phase: "in-trajectory",
      baseline: { tokens: 1000, score: 1, responseCount: 4 },
      packaged: { tokens: 600, score: 0.9, responseCount: 4 },
      onComparison: (record) => {
        seen.push({ qualifies: record.qualifies, scoreDeltaRatio: record.scoreDeltaRatio, query: record.query });
      },
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.qualifies).toBe(true);
    expect(seen[0]?.scoreDeltaRatio).toBeCloseTo(-0.1);
    expect(seen[0]?.query).toBe(state.claim);
  });

  it("rejects terminally and reports aggregate status", async () => {
    const client = memoryClient();
    await proposeMechanism(client, { ...proposal, name: "Keep one" });
    const doomed = await proposeMechanism(client, { ...proposal, name: "Doomed" });
    await rejectMechanism(client, doomed.id, "failed held-out");
    expect((await readMechanism(client, doomed.id))?.status).toBe("rejected");
    await expect(rejectMechanism(client, doomed.id, "again")).rejects.toThrow(/terminal/);

    const mechanisms = await listMechanisms(client);
    expect(mechanisms.length).toBe(2);
    const report = await getMechanismReport(client);
    expect(report.total).toBe(2);
    expect(report.rejected).toBe(1);
    expect(report.byStatus.proposed).toBe(1);
    expect(report.heldOutViolations).toBe(0);
  });
});
