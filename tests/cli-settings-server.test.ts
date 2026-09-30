import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  startSettingsServer,
  stopServer,
} from "../src/surfaces/cli/settings-server.js";
import { getGraphFlowSettings, saveGraphFlowSettings } from "../src/surfaces/cli/runtime/settings.js";

describe("CLI Settings Server", () => {
  it("serves modern dark-mode settings HTML page on GET /", async () => {
    const instance = await startSettingsServer({
      port: 5260,
      openBrowser: false,
    });

    try {
      const res = await fetch(`${instance.url}/`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/html");

      const html = await res.text();
      expect(html).toContain("GraphFlow Settings");
      expect(html).toContain("LLM Provider 配置");
      expect(html).toContain("Worker Agent 执行策略");
      expect(html).toContain("typesafe-jev");
      expect(html).toContain("local-command");
      expect(html).toContain("smartProvider");
      expect(html).toContain("economyProvider");
      expect(html).toContain("maxContextTokens");
      expect(html).toContain("SoL-Pi 效率机制");
      expect(html).toContain("保存配置");

      // Also verify /index.html
      const resIndex = await fetch(`${instance.url}/index.html`);
      expect(resIndex.status).toBe(200);
      expect(resIndex.headers.get("content-type")).toContain("text/html");
    } finally {
      await stopServer(instance);
    }
  });

  it("reads and writes settings via GET and POST /api/settings", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "gf-settings-test-"));
    const configPath = join(tempDir, "graphflow.config.json");

    try {
      // Seed initial configuration
      saveGraphFlowSettings(
        {
          provider: "deepseek",
          smartProvider: "deepseek",
          smartModel: "deepseek-chat",
          economyProvider: "deepseek",
          economyModel: "deepseek-chat",
          workerType: "local-command",
          maxContextTokens: 16000,
          layerQuota: { l1: 6, l2: 4, l3: 3 },
          enableNearLosslessMode: false,
          autoIndexOnPreview: true,
          autoIndexOnRun: true,
          autoIndexOnSave: true,
          transport: "file",
          graphStorePath: "graphflow-out/graphflow-graph.json",
        },
        configPath
      );

      const instance = await startSettingsServer({
        port: 5262,
        configPath,
        openBrowser: false,
      });

      try {
        // 1. GET /api/settings reads initial configuration
        const getRes = await fetch(`${instance.url}/api/settings`);
        expect(getRes.status).toBe(200);
        expect(getRes.headers.get("content-type")).toContain("application/json");

        const initialSettings = await getRes.json();
        expect(initialSettings.smartProvider).toBe("deepseek");
        expect(initialSettings.smartModel).toBe("deepseek-chat");
        expect(initialSettings.workerType).toBe("local-command");

        // 2. POST /api/settings writes updated configuration (including TypeSafe-JEV worker)
        const updatePayload = {
          smartProvider: "openai",
          smartModel: "gpt-4o",
          smartApiKey: "sk-test-secret-key",
          economyProvider: "openai",
          economyModel: "gpt-4o-mini",
          workerType: "typesafe-jev",
          workerProvider: "openai",
          workerModel: "typesafe-jev-v2",
          workerBaseUrl: "http://127.0.0.1:8000/v1",
          workerTimeoutMs: 90000,
          maxContextTokens: 12000,
          embeddingProvider: "fnv",
          indexMarkdown: true,
          indexOfficeDocs: false,
          observationsEnabled: true,
          observationReduceEnabled: true,
          contextPressureEnabled: true,
          actionFusionEnabled: true,
        };

        const postRes = await fetch(`${instance.url}/api/settings`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(updatePayload),
        });

        expect(postRes.status).toBe(200);
        const postData = await postRes.json();
        expect(postData.ok).toBe(true);
        expect(postData.workerType).toBe("typesafe-jev");
        expect(postData.workerModel).toBe("typesafe-jev-v2");

        // 3. GET /api/settings reflects persisted changes
        const verifyRes = await fetch(`${instance.url}/api/settings`);
        expect(verifyRes.status).toBe(200);
        const updatedSettings = await verifyRes.json();
        expect(updatedSettings.smartProvider).toBe("openai");
        expect(updatedSettings.smartModel).toBe("gpt-4o");
        expect(updatedSettings.workerType).toBe("typesafe-jev");
        expect(updatedSettings.workerModel).toBe("typesafe-jev-v2");
        expect(updatedSettings.workerBaseUrl).toBe("http://127.0.0.1:8000/v1");
        expect(updatedSettings.workerTimeoutMs).toBe(90000);
        expect(updatedSettings.maxContextTokens).toBe(12000);

        // 4. Verify disk persistence directly with getGraphFlowSettings
        const diskSettings = getGraphFlowSettings(configPath);
        expect(diskSettings.smartProvider).toBe("openai");
        expect(diskSettings.workerType).toBe("typesafe-jev");
        expect(diskSettings.workerModel).toBe("typesafe-jev-v2");
      } finally {
        await stopServer(instance);
      }
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("automatically increments port when port is already occupied", async () => {
    const basePort = 5270;
    const serverA = await startSettingsServer({
      port: basePort,
      openBrowser: false,
    });

    let serverB: Awaited<ReturnType<typeof startSettingsServer>> | null = null;
    try {
      expect(serverA.port).toBe(basePort);

      // Attempting to start on the same port automatically increments to basePort + 1
      serverB = await startSettingsServer({
        port: basePort,
        openBrowser: false,
      });

      expect(serverB.port).toBe(basePort + 1);

      // Both servers respond concurrently
      const [resA, resB] = await Promise.all([
        fetch(`${serverA.url}/`),
        fetch(`${serverB.url}/`),
      ]);
      expect(resA.status).toBe(200);
      expect(resB.status).toBe(200);
    } finally {
      await stopServer(serverA);
      if (serverB) {
        await stopServer(serverB);
      }
    }
  });

  it("stopServer() releases port and closes listening handle", async () => {
    const testPort = 5275;
    const server1 = await startSettingsServer({
      port: testPort,
      openBrowser: false,
    });
    expect(server1.port).toBe(testPort);
    expect(server1.server.listening).toBe(true);

    // Verify it responds
    const res1 = await fetch(`${server1.url}/api/settings`);
    expect(res1.status).toBe(200);

    // Stop server and verify port/handle release
    await stopServer(server1);
    expect(server1.server.listening).toBe(false);
    expect(server1.server.address()).toBeNull();

    // Requests to stopped server should fail immediately
    await expect(fetch(`${server1.url}/api/settings`)).rejects.toThrow();

    // Verify a new server instance can be started without interference
    const server2 = await startSettingsServer({
      port: testPort,
      openBrowser: false,
    });
    try {
      expect(server2.server.listening).toBe(true);
      expect(server2.port).toBeGreaterThanOrEqual(testPort);
      const res2 = await fetch(`${server2.url}/api/settings`);
      expect(res2.status).toBe(200);
    } finally {
      await stopServer(server2);
    }
  });

  it("handles API shutdown via POST /api/shutdown", async () => {
    const instance = await startSettingsServer({
      port: 5280,
      openBrowser: false,
    });

    const res = await fetch(`${instance.url}/api/shutdown`, { method: "POST" });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);

    // Give server a moment to close connections and shut down
    await new Promise((resolve) => setTimeout(resolve, 150));

    // Subsequent requests should fail
    await expect(fetch(`${instance.url}/api/settings`)).rejects.toThrow();
  });

  it("handles CORS OPTIONS preflight, 404, and bad POST JSON gracefully", async () => {
    const instance = await startSettingsServer({
      port: 5285,
      openBrowser: false,
    });

    try {
      // CORS OPTIONS
      const optionsRes = await fetch(`${instance.url}/api/settings`, { method: "OPTIONS" });
      expect(optionsRes.status).toBe(204);
      expect(optionsRes.headers.get("access-control-allow-origin")).toBe("*");

      // 404 Not Found
      const notFoundRes = await fetch(`${instance.url}/non-existent-endpoint`);
      expect(notFoundRes.status).toBe(404);

      // 400 Bad Request on invalid JSON
      const badJsonRes = await fetch(`${instance.url}/api/settings`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "invalid-json-string{",
      });
      expect(badJsonRes.status).toBe(400);
      const badJsonData = await badJsonRes.json();
      expect(badJsonData.ok).toBe(false);
    } finally {
      await stopServer(instance);
    }
  });
});
