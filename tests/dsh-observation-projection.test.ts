import { describe, expect, it } from "vitest";
import {
  buildObservationProjection,
  extractToolResultText,
  isObservationProjectionEnabled,
  projectToolResultEvent,
} from "../dsh/plugin.mjs";

const BIG = "x".repeat(9000);

function makeEvent(text, seq = 42) {
  return {
    type: "tool/result",
    seq,
    data: {
      turn: 1,
      step: 2,
      message: {
        content: [{ type: "tool-result", content: [{ type: "text", text }] }],
        source: { callId: "call-1" },
      },
    },
  };
}

function makeSession() {
  const calls = [];
  return {
    calls,
    append(type, data, intent) {
      calls.push({ type, data, intent });
      return { seq: 100 };
    },
  };
}

const enabled = { env: { GRAPHFLOW_D_DSH_PROJECTION: "1" } };
const packed = { handle: "gfo:test", head: "head-excerpt", tail: "tail-excerpt", lines: 120, sizeBytes: 9000 };

describe("observation projection switch", () => {
  it("is on by default and disabled only by an explicit falsy value", () => {
    expect(isObservationProjectionEnabled({})).toBe(true);
    expect(isObservationProjectionEnabled({ GRAPHFLOW_D_DSH_PROJECTION: "1" })).toBe(true);
    expect(isObservationProjectionEnabled({ GRAPHFLOW_D_DSH_PROJECTION: "0" })).toBe(false);
    expect(isObservationProjectionEnabled({ GRAPHFLOW_D_DSH_PROJECTION: "false" })).toBe(false);
    expect(isObservationProjectionEnabled({ GRAPHFLOW_D_DSH_PROJECTION: "off" })).toBe(false);
  });

  it("extracts the nested tool-result text and builds a handle projection", () => {
    expect(extractToolResultText(makeEvent("hello"))).toBe("hello");
    expect(extractToolResultText({})).toBe("");
    const projection = buildObservationProjection("bash", packed);
    expect(projection).toContain("gfo:test");
    expect(projection).toContain("head-excerpt");
    expect(projection).toContain("tail-excerpt");
  });
});

describe("projectToolResultEvent", () => {
  it("does nothing when disabled", async () => {
    const session = makeSession();
    const result = await projectToolResultEvent({
      session,
      event: makeEvent(BIG),
      config: { env: { GRAPHFLOW_D_DSH_PROJECTION: "0" } },
      packText: async () => packed,
    });
    expect(result).toEqual({ projected: false, reason: "disabled" });
    expect(session.calls.length).toBe(0);
  });

  it("leaves small results inline", async () => {
    const session = makeSession();
    const result = await projectToolResultEvent({ session, event: makeEvent("small"), config: enabled, packText: async () => packed });
    expect(result.reason).toBe("below-threshold");
    expect(session.calls.length).toBe(0);
  });

  it("archives the raw result and replaces the surface node with a handle projection", async () => {
    const session = makeSession();
    const event = makeEvent(BIG, 42);
    let packedText;
    const result = await projectToolResultEvent({
      session,
      event,
      config: enabled,
      packText: async (text) => {
        packedText = text;
        return packed;
      },
    });

    expect(packedText).toBe(BIG);
    expect(result).toMatchObject({ projected: true, handle: "gfo:test", originalSeq: 42, replacementSeq: 100 });
    expect(session.calls.length).toBe(1);
    const [call] = session.calls;
    expect(call.type).toBe("tool/result");
    expect(call.intent.surfaceOp).toEqual({ op: "replace", startSeq: 42, endSeq: 42 });
    expect(call.intent.sourceEventSeqs).toEqual([42]);
    // Event data is preserved; only content[0].content is replaced.
    expect(call.data.turn).toBe(1);
    expect(call.data.message.source).toEqual({ callId: "call-1" });
    const replacement = call.data.message.content[0];
    expect(replacement.type).toBe("tool-result");
    expect(replacement.content[0].text).toContain("gfo:test");
    expect(replacement.content[0].text).not.toContain(BIG);
  });

  it("fails open when packing or the surface API fails", async () => {
    const session = makeSession();
    const noPack = await projectToolResultEvent({ session, event: makeEvent(BIG), config: enabled, packText: async () => undefined });
    expect(noPack.projected).toBe(false);
    expect(noPack.reason).toBe("pack-failed");
    expect(session.calls.length).toBe(0);

    const noSurface = await projectToolResultEvent({ session: {}, event: makeEvent(BIG), config: enabled, packText: async () => packed });
    expect(noSurface.reason).toBe("no-surface-api");

    const throwing = {
      append() {
        throw new Error("surface rejected");
      },
    };
    const result = await projectToolResultEvent({ session: throwing, event: makeEvent(BIG), config: enabled, packText: async () => packed });
    expect(result.projected).toBe(false);
    expect(result.reason).toBe("error");
  });
});
