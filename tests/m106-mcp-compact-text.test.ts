import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getDefaultConfig } from "../src/config/defaults";
import {
  executeToolCall,
  setDefaultTextCopyPolicy,
  structuredResponse,
  TEXT_STUB_THRESHOLD_BYTES,
  type ToolCallResponse,
} from "../src/surfaces/mcp/tool-handlers";

const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length > 0) {
    cleanups.pop()?.();
  }
});

function createIsolatedConfig(textCopy: "auto" | "full" = "auto"): string {
  const root = mkdtempSync(join(tmpdir(), "graphflow-compact-"));
  const configPath = join(root, "graphflow.config.json");
  const config = getDefaultConfig();
  writeFileSync(
    configPath,
    JSON.stringify({
      ...config,
      graphPolicy: {
        ...config.graphPolicy,
        // 文件后端避免 Windows 上 SQLite 文件句柄竞争；自动索引全部关闭，
        // 本测试只关心响应序列化形状，不需要真实图数据。
        // File backend avoids Windows SQLite handle races; auto-indexing is
        // off because these assertions only cover response serialization.
        transport: "file",
        autoIndexOnPreview: false,
        autoIndexOnRun: false,
        autoIndexOnSave: false,
        graphStorePath: join(root, "graphflow-graph.json"),
        workspaceRoot: root,
      },
      // mcp.textCopy 策略随用例注入；默认 "auto" 与既有用例行为一致。
      // mcp.textCopy policy per case; the default "auto" keeps the behavior
      // of the pre-existing cases unchanged.
      mcp: { textCopy },
    }),
    "utf8"
  );
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  return configPath;
}

function textOf(response: ToolCallResponse): string {
  expect(response.content[0]?.type).toBe("text");
  return response.content[0]!.text;
}

describe("MCP tool response text is compact JSON (m106)", () => {
  it("structuredResponse emits indent-free text that parses to structuredContent", async () => {
    const configPath = createIsolatedConfig();
    const response = await executeToolCall({
      name: "graphflow_skill_insights",
      arguments: { configPath },
    });
    const text = textOf(response);

    // 紧凑序列化不携带缩进空白：美化输出会在每个字段前出现 "\n  "。
    // Compact serialization carries no indentation whitespace; a pretty
    // print would emit "\n  " before every field.
    expect(text).not.toContain("\n  ");
    // 往返恒等：text 必须与其 parse 后的紧凑再序列化逐字节一致——
    // 这是区分美化与紧凑输出的最强判据。
    // Round-trip invariant: text must be byte-identical to the compact
    // re-serialization of its own parsed value.
    expect(text).toBe(JSON.stringify(JSON.parse(text)));
    // 遗留 text 副本与 structuredContent 是同一份数据（deep equal）。
    // The legacy text copy and structuredContent carry the same data.
    expect(JSON.parse(text)).toEqual(response.structuredContent);
  });

  it("skill_guide emits compact text for the legacy guide string copy", async () => {
    const response = await executeToolCall({
      name: "graphflow_skill_guide",
      arguments: { section: "best-practices" },
    });
    const text = textOf(response);
    const structured = response.structuredContent as { section: string; guide: string };

    // 外层序列化必须紧凑；guide 字符串自身的换行被转义为 \n 两字符序列，
    // 不会在 text 里产生字面换行或缩进。
    // The outer serialization must be compact; the guide string's own
    // newlines are escaped as two-character \n sequences, never literal
    // newlines or indentation in the text.
    expect(text).not.toContain("\n  ");
    expect(text).toBe(JSON.stringify(JSON.parse(text)));
    expect(structured).toEqual({ section: "best-practices", guide: JSON.parse(text) });
    // structuredContent 的形状与语义未随紧凑化改变。
    // structuredContent keeps its shape and semantics unchanged.
    expect(typeof structured.guide).toBe("string");
    expect(structured.guide).toContain("Best Practices");
  });
});

describe("MCP oversized text copy stubs beyond the threshold (m106 follow-up)", () => {
  // packObservation 路径的头尾摘要在 JSON 转义后必然超过阈值：内容全部由
  // 双引号组成，每个字节转义成 \" 两个字符，2048+1536 字节的摘要在 text 里
  // 膨胀到 ~7KB，确定性触发桩化且不依赖图数据。
  // The packObservation path deterministically exceeds the threshold after
  // JSON escaping: content made entirely of double quotes escapes every byte
  // into a two-character \" sequence, so the 2048+1536-byte excerpts inflate
  // to ~7KB in text — triggering the stub without any graph data.
  const oversizedContent = '"'.repeat(8192);

  function packResponse(configPath: string): Promise<ToolCallResponse> {
    return executeToolCall({
      name: "graphflow_context",
      arguments: { content: oversizedContent, configPath, rootDir: dirname(configPath) },
    });
  }

  it("auto policy stubs the text copy of an oversized response, structuredContent stays full", async () => {
    const configPath = createIsolatedConfig();
    const response = await packResponse(configPath);
    const text = textOf(response);
    const parsed = JSON.parse(text) as {
      stub?: boolean;
      summary?: string;
      bytes?: number;
      hint?: string;
    };

    // text 副本是一行桩：单行、带 hint、记录全量字节数。
    // The text copy is a one-line stub: single line, carries the hint and the
    // full payload's byte count.
    expect(parsed.stub).toBe(true);
    expect(parsed.hint).toBe("full data in structuredContent");
    expect(typeof parsed.bytes).toBe("number");
    expect(parsed.bytes!).toBeGreaterThan(TEXT_STUB_THRESHOLD_BYTES);
    expect(text).toBe(JSON.stringify(parsed));
    // packObservation 结果没有 query/task/title 字段 → 通用 summary。
    // The packObservation result has no query/task/title field, so the stub
    // falls back to the generic summary.
    expect(parsed.summary).toBe("graphflow response");

    // structuredContent 仍是全量数据：无桩字段、observation 形状完整。
    // structuredContent still carries the full data: no stub field and the
    // observation shape is intact.
    const structured = response.structuredContent as Record<string, unknown>;
    expect(structured.stub).toBeUndefined();
    expect(structured.fallback).toBe(false);
    expect(String(structured.handle)).toMatch(/^gfo:/);
    expect(Buffer.byteLength(text, "utf8")).toBeLessThan(parsed.bytes!);
  });

  it('config mcp.textCopy "full" keeps the full compact text for oversized responses', async () => {
    const configPath = createIsolatedConfig("full");
    const response = await packResponse(configPath);
    const text = textOf(response);
    const parsed = JSON.parse(text) as Record<string, unknown>;

    // 逃生门：策略为 "full" 时大响应的 text 仍是全量紧凑 JSON。
    // Escape hatch: under "full" the oversized response's text stays the full
    // compact JSON.
    expect(parsed.stub).toBeUndefined();
    expect(text).toBe(JSON.stringify(parsed));
    expect(parsed).toEqual(response.structuredContent);
    expect(Buffer.byteLength(text, "utf8")).toBeGreaterThan(TEXT_STUB_THRESHOLD_BYTES);
  });

  it("small responses keep the full compact text under both policies", async () => {
    // 小响应（≤阈值）行为与现状一致：text 是全量紧凑 JSON，无桩。
    // Small responses (within the threshold) behave exactly as before: the
    // text copy is the full compact JSON with no stub.
    for (const textCopy of ["auto", "full"] as const) {
      const configPath = createIsolatedConfig(textCopy);
      const response = await executeToolCall({
        name: "graphflow_skill_insights",
        arguments: { configPath },
      });
      const text = textOf(response);
      expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(TEXT_STUB_THRESHOLD_BYTES);
      const parsed = JSON.parse(text) as Record<string, unknown>;
      expect(parsed.stub).toBeUndefined();
      expect(parsed).toEqual(response.structuredContent);
    }
  });

  it("direct structuredResponse call: stub summary from query field, clipped to 120 chars", () => {
    setDefaultTextCopyPolicy("auto");
    try {
      const data = { query: "q".repeat(200), payload: "x".repeat(6000) };
      const response = structuredResponse(data);
      const parsed = JSON.parse(textOf(response)) as {
        stub?: boolean;
        summary?: string;
        bytes?: number;
      };

      expect(parsed.stub).toBe(true);
      // query 字段成为 summary，且被裁到 120 字符。
      // The query field becomes the summary, clipped to 120 characters.
      expect(parsed.summary).toBe("q".repeat(120));
      expect(parsed.bytes).toBe(Buffer.byteLength(JSON.stringify(data), "utf8"));
      expect(response.structuredContent).toEqual(data);
    } finally {
      // 模块级策略复位，避免泄漏到后续用例。
      // Reset the module-level policy so it cannot leak into later cases.
      setDefaultTextCopyPolicy(undefined);
    }
  });

  it("direct structuredResponse call: per-call option overrides the module default", () => {
    setDefaultTextCopyPolicy("full");
    try {
      const data = { payload: "x".repeat(6000) };
      // 模块默认 "full"：text 保持全量。
      // Module default "full": the text copy stays full.
      expect(JSON.parse(textOf(structuredResponse(data)))).toEqual(data);
      // 逐次参数覆盖为 "auto"：超阈值即桩化。
      // Per-call override to "auto": oversized payloads stub.
      const stubbed = JSON.parse(textOf(structuredResponse(data, { textCopy: "auto" }))) as {
        stub?: boolean;
      };
      expect(stubbed.stub).toBe(true);
    } finally {
      setDefaultTextCopyPolicy(undefined);
    }
  });
});
