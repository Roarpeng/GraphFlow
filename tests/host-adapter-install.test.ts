import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getHostAdapter, HOST_ADAPTERS, hostsWithCapability } from "../src/integrations/host-adapter";
import {
  DSH_HOST_ADAPTER_ID,
  getHostAdapterInstallStatus,
  HOST_ADAPTER_INSTALL_UNMIGRATED,
  installViaHostAdapter,
  uninstallViaHostAdapter,
} from "../src/integrations/host-adapter-install";
import { DSH_MCP_ROW_ID, DSH_PATCH_BEGIN } from "../src/integrations/dsh-harness-installer";

const tempRoots: string[] = [];

function makeTempRoot(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempRoots.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
});

describe("package.json narrative", () => {
  it("describes GraphFlow as a local-first memory & context harness, not an orchestrator", () => {
    const pkg = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf8")) as {
      description?: string;
      keywords?: string[];
    };
    expect(pkg.description).toMatch(/memory & context harness/i);
    expect(pkg.description).not.toMatch(/orchestration engine/i);
    expect(pkg.keywords).toEqual(expect.arrayContaining(["local-first", "memory-harness", "dsh-plugin"]));
    expect(pkg.keywords).not.toContain("orchestration");
    expect(pkg.keywords).not.toContain("multi-agent");
  });
});

describe("HostAdapter registry", () => {
  it("lists DSH, Cursor, and Claude with their capability slices", () => {
    expect(HOST_ADAPTERS.map((adapter) => adapter.id)).toEqual([
      "deepseek-harness",
      "cursor",
      "claude-code",
    ]);
    expect(getHostAdapter(DSH_HOST_ADAPTER_ID)?.capabilities).toEqual(
      expect.arrayContaining(["mcp-stdio", "skills", "hooks", "client-panel"])
    );
    expect(getHostAdapter("cursor")?.homeMarker).toBe(".cursor");
    expect(hostsWithCapability("hooks").map((adapter) => adapter.id)).toEqual([
      "deepseek-harness",
      "claude-code",
    ]);
  });
});

describe("HostAdapter DSH install slice", () => {
  it("installViaHostAdapter writes the DSH overlay and uninstall reverses it", () => {
    const dshHome = join(makeTempRoot("gf-host-adapter-dsh-"), ".dsh");
    mkdirSync(dshHome, { recursive: true });

    const created = installViaHostAdapter(DSH_HOST_ADAPTER_ID, { home: dshHome });
    expect(created.hostId).toBe(DSH_HOST_ADAPTER_ID);
    expect(created.displayName).toBe("DeepSeek Harness");
    expect(created.status).toBe("created");
    expect(created.filePath).toBe(join(dshHome, "cordis.patch.yml"));

    const patch = readFileSync(created.filePath as string, "utf8");
    expect(patch).toContain(DSH_PATCH_BEGIN);
    expect(patch).toContain(`id: ${DSH_MCP_ROW_ID}`);

    const status = getHostAdapterInstallStatus(DSH_HOST_ADAPTER_ID, { home: dshHome });
    expect(status?.detected).toBe(true);
    expect(status?.installed).toBe(true);
    expect(status?.glueInstalled).toBe(true);
    expect(status?.agent).toBe("DeepSeek Harness");

    const skipped = installViaHostAdapter(DSH_HOST_ADAPTER_ID, { home: dshHome });
    expect(skipped.status).toBe("skipped");

    const removed = uninstallViaHostAdapter(DSH_HOST_ADAPTER_ID, { home: dshHome });
    expect(removed.status).toBe("updated");
    expect(getHostAdapterInstallStatus(DSH_HOST_ADAPTER_ID, { home: dshHome })?.installed).toBe(false);
  });

  it("leaves Cursor and Claude Code unsupported and rejects unknown hosts", () => {
    const cursor = installViaHostAdapter("cursor");
    expect(cursor.status).toBe("unsupported");
    expect(cursor.message).toContain(HOST_ADAPTER_INSTALL_UNMIGRATED);

    const claude = uninstallViaHostAdapter("claude-code");
    expect(claude.status).toBe("unsupported");
    expect(getHostAdapterInstallStatus("cursor")).toBeUndefined();

    const unknown = installViaHostAdapter("not-a-host");
    expect(unknown.status).toBe("error");
    expect(unknown.message).toMatch(/unknown host adapter/);
  });
});
