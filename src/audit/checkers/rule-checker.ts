/**
 * rule-checker.ts — 规则引擎执行器（name: "rule"）。
 *
 * 容器引用、驱动加载等一切接入义务都由项目规则（graphflow.audit.json，
 * 经 AuditContext.loadRules 注入）表达——内置规则集为空数组，规则完全
 * 交给项目配置（诚实边界：不发明项目未声明的义务）。
 *
 * 语义：changedFiles 里匹配 rule.filePattern 的文件（“新增”）必须在
 * 某个匹配 rule.mustBeReferencedBy glob 的磁盘配置文件内容中被引用
 * （文件名或相对路径字符串包含）。所有 glob 目标都没有任何文件引用
 * → 每个未被引用的文件产出一条 finding（kind/severity 取规则值，
 * 默认 "rule" / "error"）。changedFiles 为空（baseline none）→ 全部
 * 跳过：规则义务由“新增”触发。
 *
 * 磁盘扫描是浅层 walker（≤3 层深度，跳过 node_modules/.git/dist），
 * 二进制（前 8KiB 含 NUL）或读失败的目标文件跳过。全程 fail-open，
 * 任何读写失败都不抛错。
 */
import { readFileSync, readdirSync, type Dirent } from "node:fs";
import { basename, join } from "node:path";
import { globMatches } from "../rules.js";
import type { AuditChecker, AuditFinding, AuditRule, AuditRuleSet } from "../types.js";

const WALK_SKIP_DIRS = new Set(["node_modules", ".git", "dist"]);
const MAX_WALK_DEPTH = 3;

function toPosix(p: string): string {
  return p.replace(/\\/g, "/");
}

/** 浅层 walker：收集 root 下 ≤3 层深度文件的 posix 相对路径。 */
function walkShallow(root: string): string[] {
  const out: string[] = [];
  collect(root, "", 0, out);
  return out;
}

function collect(dir: string, prefix: string, depth: number, out: string[]): void {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return; // 读目录失败 → 跳过该层
  }
  for (const entry of entries) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (WALK_SKIP_DIRS.has(entry.name)) continue;
      if (depth >= MAX_WALK_DEPTH) continue; // 文件最深出现在第 3 层目录
      collect(join(dir, entry.name), rel, depth + 1, out);
    } else if (entry.isFile()) {
      out.push(rel);
    }
  }
}

/** 目标配置文件匹配：按相对 posix 路径匹配 glob；不含 "/" 的裸文件名模式也按 basename 匹配。 */
function matchesTargetGlob(glob: string, relPosix: string): boolean {
  if (globMatches(glob, relPosix)) return true;
  if (!glob.includes("/")) return globMatches(glob, basename(relPosix));
  return false;
}

/** 读文本内容；二进制（前 8KiB 含 NUL 字节）或读失败返回 undefined。 */
function readTextual(absPath: string): string | undefined {
  let buf: Buffer;
  try {
    buf = readFileSync(absPath);
  } catch {
    return undefined;
  }
  if (buf.subarray(0, 8192).includes(0)) return undefined;
  return buf.toString("utf8");
}

/** 内容引用判定用的 needle：文件 basename + 去 "./" 前缀的 posix 相对路径。 */
function referenceNeedles(relPosix: string): string[] {
  const base = basename(relPosix);
  const rel = relPosix.replace(/^\.\//, "");
  return rel === base ? [base] : [base, rel];
}

/** 规则形状防御：stub/手写规则集可能不经过 loadAuditRuleSet 的校验。 */
function isRunnableRule(rule: AuditRule): boolean {
  return (
    typeof rule.name === "string" &&
    rule.name.length > 0 &&
    typeof rule.filePattern === "string" &&
    rule.filePattern.length > 0 &&
    Array.isArray(rule.mustBeReferencedBy) &&
    rule.mustBeReferencedBy.length > 0
  );
}

export function createRuleChecker(): AuditChecker {
  return {
    name: "rule",
    async run(changedFiles, root, context) {
      if (changedFiles.length === 0) return []; // baseline none：规则义务由“新增”触发
      let ruleSet: AuditRuleSet;
      try {
        ruleSet = context.loadRules();
      } catch {
        return []; // 契约：loadRules 永不抛错；防御性兜底
      }
      const rules = Array.isArray(ruleSet?.rules) ? ruleSet.rules : [];
      const changed = [...new Set(changedFiles.map(toPosix))];
      const findings: AuditFinding[] = [];
      let diskCache: string[] | undefined;
      const diskFiles = (): string[] => {
        if (!diskCache) diskCache = walkShallow(root);
        return diskCache;
      };
      for (const rule of rules) {
        if (!isRunnableRule(rule)) continue;
        const matched = changed.filter((f) => globMatches(rule.filePattern, f));
        if (matched.length === 0) continue; // 无新义务
        const targets = diskFiles().filter((rel) =>
          rule.mustBeReferencedBy.some((glob) => matchesTargetGlob(glob, rel))
        );
        const referenced = new Set<string>();
        for (const target of targets) {
          const content = readTextual(join(root, target));
          if (content === undefined) continue; // 二进制/读失败跳过
          for (const file of matched) {
            if (referenced.has(file)) continue;
            if (referenceNeedles(file).some((needle) => content.includes(needle))) {
              referenced.add(file);
            }
          }
        }
        for (const file of matched) {
          if (referenced.has(file)) continue;
          findings.push({
            id: `rule:${rule.name}:${file}`,
            kind: rule.kind ?? "rule",
            severity: rule.severity ?? "error",
            message: `规则 ${rule.name}：新增 ${file} 但未在任何 ${rule.mustBeReferencedBy.join("、")} 配置中被引用——${rule.description ?? "该文件的接入义务未兑现"}（忘了吗？）`,
            evidence: {
              rule: rule.name,
              files: [file],
              detail: `matched ${rule.filePattern}; ${targets.length} target file(s) on disk, none references it`,
            },
            remediation: rule.remediation ?? "把文件引用加入对应配置",
          });
        }
      }
      return findings;
    },
  };
}
