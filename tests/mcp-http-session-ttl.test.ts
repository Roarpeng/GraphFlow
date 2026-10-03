import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  DEFAULT_HTTP_SESSION_TTL_MS,
  resolveHttpSessionTtlMs,
  startStreamableHttpServer,
  type StartedMcpHttpServer,
} from "../src/surfaces/mcp/server";

const RPC_ACCEPT = "application/json, text/event-stream";

function postJson(
  url: string,
  body: unknown,
  headers: Record<string, string> = {}
): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: {
      Accept: RPC_ACCEPT,
      "Content-Type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Opens one stateful session and abandons it WITHOUT the terminating DELETE
 * (client.close() only aborts local streams in the SDK) — the exact leak the
 * idle TTL addresses.
 */
async function openAbandonedSession(started: StartedMcpHttpServer): Promise<string> {
  const transport = new StreamableHTTPClientTransport(new URL(started.url));
  const client = new Client({ name: "graphflow-ttl", version: "1.0.0" });
  await client.connect(transport);
  const sessionId = transport.sessionId;
  expect(sessionId).toBeTruthy();
  expect(await client.ping()).toEqual({});
  await client.close();
  return sessionId!;
}

/**
 * A stale-session ping can only answer 404 "session not found" when the
 * sessions map no longer holds the id, so these 404s are the externally
 * observable proof that the sweep emptied the map (same semantics as DELETE).
 */
describe("HTTP stateful session idle TTL", () => {
  it("resolveHttpSessionTtlMs: option > env > default, 0 disables, junk falls back", () => {
    expect(resolveHttpSessionTtlMs(undefined, undefined)).toBe(DEFAULT_HTTP_SESSION_TTL_MS);
    expect(DEFAULT_HTTP_SESSION_TTL_MS).toBe(30 * 60_000);
    expect(resolveHttpSessionTtlMs(undefined, "")).toBe(DEFAULT_HTTP_SESSION_TTL_MS);
    expect(resolveHttpSessionTtlMs(undefined, "45000")).toBe(45_000);
    expect(resolveHttpSessionTtlMs(undefined, "0")).toBe(0);
    expect(resolveHttpSessionTtlMs(undefined, "not-a-number")).toBe(DEFAULT_HTTP_SESSION_TTL_MS);
    expect(resolveHttpSessionTtlMs(undefined, "-5")).toBe(DEFAULT_HTTP_SESSION_TTL_MS);
    expect(resolveHttpSessionTtlMs(1_200, "0")).toBe(1_200);
    expect(resolveHttpSessionTtlMs(0, "9000")).toBe(0);
  });

  it("sweeps an abandoned stateful session after the TTL and then reports session not found", async () => {
    const started = await startStreamableHttpServer(undefined, {
      host: "127.0.0.1",
      port: 0,
      stateful: true,
      enableJsonResponse: true,
      sessionTtlMs: 80,
      sessionSweepIntervalMs: 25,
    });
    try {
      const sessionId = await openAbandonedSession(started);
      // Silent wait (polling would REFRESH lastActivityAt and defeat the
      // sweep by design); one probe at 1s and a final one at 3s give the
      // TTL-80ms + sweep-25ms machinery a 30x+ margin under full-suite load.
      const probe = () =>
        postJson(
          started.url,
          { jsonrpc: "2.0", id: "after-ttl", method: "ping" },
          { "Mcp-Session-Id": sessionId }
        );
      await sleep(1_000);
      let stale = await probe();
      if (stale.status !== 404) {
        await sleep(2_000);
        stale = await probe();
      }
      expect(stale.status).toBe(404);
      const body = (await stale.json()) as { error?: { message?: string } };
      expect(body.error?.message).toMatch(/session not found/i);
    } finally {
      await started.close();
    }
  }, 15_000);

  it("keeps sweeping sessions alive while requests keep arriving (activity refresh)", async () => {
    const started = await startStreamableHttpServer(undefined, {
      host: "127.0.0.1",
      port: 0,
      stateful: true,
      enableJsonResponse: true,
      sessionTtlMs: 500,
      sessionSweepIntervalMs: 50,
    });
    try {
      const transport = new StreamableHTTPClientTransport(new URL(started.url));
      const client = new Client({ name: "graphflow-ttl-refresh", version: "1.0.0" });
      await client.connect(transport);
      const sessionId = transport.sessionId!;
      expect(sessionId).toBeTruthy();

      // 4 gaps of ~200ms each exceed the 500ms TTL cumulatively (~800ms);
      // every request must refresh lastActivityAt so no sweep fires.
      for (let index = 0; index < 4; index += 1) {
        await sleep(200);
        expect(await client.ping()).toEqual({});
      }

      // Stop requesting and let the idle clock run past TTL + one sweep.
      await client.close();
      await sleep(900);

      const stale = await postJson(
        started.url,
        { jsonrpc: "2.0", id: "after-idle", method: "ping" },
        { "Mcp-Session-Id": sessionId }
      );
      expect(stale.status).toBe(404);
    } finally {
      await started.close();
    }
  }, 20_000);

  it("sessionTtlMs 0 disables the sweep (session stays routable)", async () => {
    const started = await startStreamableHttpServer(undefined, {
      host: "127.0.0.1",
      port: 0,
      stateful: true,
      enableJsonResponse: true,
      sessionTtlMs: 0,
      sessionSweepIntervalMs: 20,
    });
    try {
      const sessionId = await openAbandonedSession(started);
      await sleep(250); // far past what a 20ms sweeper would need.

      const alive = await postJson(
        started.url,
        { jsonrpc: "2.0", id: "ttl-zero", method: "ping" },
        { "Mcp-Session-Id": sessionId }
      );
      expect(alive.status).toBe(200);
      const body = (await alive.json()) as { result?: unknown; error?: { message?: string } };
      expect(body.error).toBeUndefined();
      expect(body.result).toBeDefined();
    } finally {
      await started.close();
    }
  }, 15_000);

  it("GRAPHFLOW_HTTP_SESSION_TTL_MS env overrides the default TTL", async () => {
    const previous = process.env.GRAPHFLOW_HTTP_SESSION_TTL_MS;
    process.env.GRAPHFLOW_HTTP_SESSION_TTL_MS = "80";
    let started: StartedMcpHttpServer | undefined;
    try {
      started = await startStreamableHttpServer(undefined, {
        host: "127.0.0.1",
        port: 0,
        stateful: true,
        enableJsonResponse: true,
        sessionSweepIntervalMs: 25,
      });
      const sessionId = await openAbandonedSession(started);
      // Silent wait then two probes (polling refreshes activity by design).
      await sleep(1_000);
      const probe = () =>
        postJson(
          started.url,
          { jsonrpc: "2.0", id: "after-env-ttl", method: "ping" },
          { "Mcp-Session-Id": sessionId }
        );
      let stale = await probe();
      if (stale.status !== 404) {
        await sleep(2_000);
        stale = await probe();
      }
      expect(stale.status).toBe(404);
    } finally {
      if (previous === undefined) {
        delete process.env.GRAPHFLOW_HTTP_SESSION_TTL_MS;
      } else {
        process.env.GRAPHFLOW_HTTP_SESSION_TTL_MS = previous;
      }
      await started?.close();
    }
  }, 15_000);
});
