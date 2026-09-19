/**
 * orphan-checker.ts — 未接线文件检查器（name: "orphan-file"）。
 *
 * 只陈述一个可观察事实：changedFiles 中的源码文件在图谱里没有入边
 * （inboundEdges === 0）。图谱不可用（probeFile 缺失、抛错或返回
 * undefined）时一律跳过——不臆测（fail-open）；只有「图可用且明确
 * 无入边」这一种结果才产出 warning finding。
 *
 * 测试文件（*.test.ts / *.spec.* / __tests__/**）、配置与文档
 * （*.json / *.yml / *.md 等非源码扩展名，以及带源码扩展名的工具
 * 配置文件如 eslint.config.js）、scripts/** 以及 package.json 清单
 * 入口（bin/main/module/exports 指向的文件——含 dist→src 布局映射）
 * 天然是图根节点，不在检查范围。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AuditChecker, AuditContext, AuditFinding } from "../types.js";

/** probeFile 一次调用的结果类型（图可用时给出明确入边数）。 */
type ProbeResult = Awaited<ReturnType<NonNullable<AuditContext["probeFile"]>>>;

/** 常见源码扩展名白名单：不在名单内的一律不视为源码文件。 */
const SOURCE_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".py", ".go", ".rs",
  ".c", ".h", ".cpp", ".cc", ".hpp",
  ".java", ".kt", ".swift", ".rb",
]);

/** 带源码扩展名的工具配置文件（eslint.config.js / vitest.config.ts …）——配置不是可接线源码。 */
const CONFIG_BASE_PATTERN = /^[a-zA-Z0-9._-]+\.config\.(js|cjs|mjs|ts|mts|cts)$/;

/** 该相对路径是否为需要接线检查的源码文件（排除测试/配置/脚本）。 */
function isAuditableSourceFile(relPath: string): boolean {
  const p = relPath.replace(/\\/g, "/");
  if (!p || p.endsWith("/")) return false;
  const segments = p.split("/");
  if (segments[0] === "scripts") return false; // 脚本目录天然允许孤儿
  if (segments.includes("__tests__")) return false;
  const base = segments[segments.length - 1] ?? "";
  if (/\.test\.[^./]+$/.test(base)) return false;
  if (/\.spec\.[^./]+$/.test(base)) return false;
  if (CONFIG_BASE_PATTERN.test(base)) return false; // 工具配置文件
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return false; // 无扩展名或 .dotfile
  return SOURCE_EXTENSIONS.has(base.slice(dot));
}

/**
 * package.json 清单入口（bin / main / module / types / exports）指向的文件。
 * 入口是图的根——设计上没有任何 inbound import，不构成"未接线"。
 * 同时加入 dist→src 布局变体（TypeScript 构建约定：清单指向 dist/**.js，
 * 改动的是 src/**.ts）。读不到 / 解析失败一律 fail-open 返回空集。
 */
function collectManifestEntryFiles(root: string): Set<string> {
  const entries = new Set<string>();
  const push = (value: unknown): void => {
    if (typeof value !== "string" || value.length === 0) return;
    const normalized = value.replace(/^\.\//, "");
    entries.add(normalized);
    const srcLayout = normalized.replace(/^dist\//, "src/");
    if (srcLayout !== normalized) {
      const dot = srcLayout.lastIndexOf(".");
      if (dot > 0) {
        for (const ext of [".ts", ".tsx"]) {
          entries.add(`${srcLayout.slice(0, dot)}${ext}`);
        }
      }
    }
  };
  try {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as Record<string, unknown>;
    push(pkg.main);
    push(pkg.module);
    push(pkg.types);
    if (typeof pkg.bin === "object" && pkg.bin !== null) {
      for (const target of Object.values(pkg.bin as Record<string, unknown>)) push(target);
    } else {
      push(pkg.bin);
    }
    if (typeof pkg.exports === "object" && pkg.exports !== null) {
      for (const value of Object.values(pkg.exports as Record<string, unknown>)) {
        if (typeof value === "string") {
          push(value);
        } else if (typeof value === "object" && value !== null) {
          for (const sub of Object.values(value as Record<string, unknown>)) push(sub);
        }
      }
    }
  } catch {
    // fail-open：无 package.json / 解析失败 → 不做清单排除
  }
  return entries;
}

export function createOrphanChecker(): AuditChecker {
  return {
    name: "orphan-file",
    async run(changedFiles, root, context) {
      const probe = context.probeFile;
      if (!probe) return []; // fail-open：图探针不可用，全部跳过
      const manifestEntries = collectManifestEntryFiles(root);
      const findings: AuditFinding[] = [];
      for (const changed of changedFiles) {
        const rel = changed.replace(/\\/g, "/");
        if (!isAuditableSourceFile(rel)) continue;
        if (manifestEntries.has(rel)) continue; // 清单入口是图根，设计上无入边
        let probed: ProbeResult;
        try {
          probed = await probe(rel);
        } catch {
          probed = undefined; // 契约：probeFile fail-open to undefined
        }
        if (probed === undefined) continue; // 图不可用/未建 → 不臆测
        if (probed.inboundEdges > 0) continue; // 已接线
        findings.push({
          id: `orphan-file:${rel}`,
          kind: "orphan-file",
          severity: "warning",
          message: `新文件 ${rel} 未被图中任何 imports/references 连接——是否忘记在项目里接线（import/注册/入口引用）？`,
          evidence: {
            files: [rel],
            detail: probed.nodeId
              ? `graph probe: node ${probed.nodeId}, inboundEdges=0`
              : "graph probe: inboundEdges=0",
          },
          remediation: "把文件接入项目（在需要处 import/注册，或加入入口/清单），确认图中入边非零后重新运行审计",
        });
      }
      return findings;
    },
  };
}
