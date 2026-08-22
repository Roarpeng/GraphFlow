import { serializePlaybookGuidance } from "./skill-types";
import type { SkillProvenance, SkillState } from "./skill-types";

type YamlValue = string | number | boolean | null | YamlObject;
type YamlObject = { [key: string]: YamlValue };

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function yamlScalar(value: string | number): string {
  if (typeof value === "number") {
    return String(value);
  }
  // JSON double-quoted escapes are also valid YAML double-quoted escapes.
  return JSON.stringify(value);
}

function normalizeBullet(line: string): string | undefined {
  const text = line.trim().replace(/^[-*+]\s+/, "").trim();
  return text ? `- ${text}` : undefined;
}

function markdownBody(state: SkillState): string {
  const source =
    state.playbook && state.playbook.length > 0
      ? serializePlaybookGuidance(state.playbook)
      : (state.guidance ?? "");
  const bullets = source
    .split(/\r?\n/)
    .map(normalizeBullet)
    .filter((line): line is string => line !== undefined);
  return bullets.length > 0 ? `${bullets.join("\n")}\n` : "";
}

/**
 * Serialize a skill as an Agent SKILL.md. Learning evidence is intentionally
 * not exported: another tool should not inherit GraphFlow's trust decision.
 */
export function skillToSkillMarkdown(state: SkillState): string {
  const optionalDescription = (state as SkillState & { description?: unknown }).description;
  const lines = [
    "---",
    `name: ${yamlScalar(state.name)}`,
    ...(typeof optionalDescription === "string" && optionalDescription.trim()
      ? [`description: ${yamlScalar(optionalDescription)}`]
      : []),
    "metadata:",
    `  id: ${yamlScalar(state.id)}`,
    ...(isFiniteNumber(state.score) ? [`  score: ${state.score}`] : []),
    ...(isFiniteNumber(state.uses) ? [`  uses: ${state.uses}`] : []),
    ...(isFiniteNumber(state.updatedAt) ? [`  updatedAt: ${state.updatedAt}`] : []),
  ];

  lines.push("---");
  return `${lines.join("\n")}\n\n${markdownBody(state)}`;
}

function parseYamlScalar(raw: string): YamlValue {
  const value = raw.trim();
  if (!value || value === "null" || value === "~") return null;
  if (value.startsWith('"')) {
    try {
      return JSON.parse(value) as string;
    } catch {
      return value.replace(/^"|"$/g, "");
    }
  }
  if (value.startsWith("'")) {
    return value.slice(1, -1).replace(/''/g, "'");
  }
  if (value === "true") return true;
  if (value === "false") return false;
  if (/^[+-]?\d+(?:\.\d+)?$/.test(value)) return Number(value);
  return value.replace(/\s+#.*$/, "").trim();
}

function parseYamlMapping(lines: string[], start: number, indent: number): [YamlObject, number] {
  const result: YamlObject = {};
  let index = start;

  while (index < lines.length) {
    const line = lines[index]!;
    const currentIndent = line.length - line.trimStart().length;
    if (!line.trim() || line.trimStart().startsWith("#")) {
      index += 1;
      continue;
    }
    if (currentIndent < indent) break;
    if (currentIndent > indent) {
      index += 1;
      continue;
    }

    const separator = line.indexOf(":");
    if (separator <= 0) {
      index += 1;
      continue;
    }
    const key = line.slice(0, separator).trim().replace(/^["']|["']$/g, "");
    const rawValue = line.slice(separator + 1).trim();
    index += 1;

    if (rawValue === "|" || rawValue === "|-" || rawValue === ">" || rawValue === ">-") {
      const block: string[] = [];
      let blockIndent: number | undefined;
      while (index < lines.length) {
        const blockLine = lines[index]!;
        if (!blockLine.trim()) {
          block.push("");
          index += 1;
          continue;
        }
        const nextIndent = blockLine.length - blockLine.trimStart().length;
        if (nextIndent <= indent) break;
        blockIndent ??= nextIndent;
        block.push(blockLine.slice(blockIndent).trimEnd());
        index += 1;
      }
      while (block.length > 0 && block[block.length - 1] === "") block.pop();
      result[key] = rawValue.startsWith(">") ? block.join(" ") : block.join("\n");
      continue;
    }

    if (rawValue) {
      result[key] = parseYamlScalar(rawValue);
      continue;
    }

    let next = index;
    while (next < lines.length && (!lines[next]!.trim() || lines[next]!.trimStart().startsWith("#"))) {
      next += 1;
    }
    const nextIndent = next < lines.length ? lines[next]!.length - lines[next]!.trimStart().length : 0;
    if (next < lines.length && nextIndent > indent) {
      const [nested, endIndex] = parseYamlMapping(lines, next, nextIndent);
      result[key] = nested;
      index = endIndex;
    } else {
      result[key] = null;
    }
  }

  return [result, index];
}

function parseFrontmatter(markdown: string): { frontmatter: YamlObject; body: string } | undefined {
  const normalized = markdown.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  const match = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(normalized);
  if (!match) return undefined;
  const [frontmatter] = parseYamlMapping(match[1]!.split("\n"), 0, 0);
  return { frontmatter, body: normalized.slice(match[0].length) };
}

function bodyGuidance(body: string): string | undefined {
  const bullets: string[] = [];
  let inFence = false;
  for (const line of body.split("\n")) {
    if (/^\s{0,3}(?:```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const text = line.trim().match(/^[-*+]\s+(.+)$/)?.[1]?.trim();
    const bullet = text ? `- ${text}` : undefined;
    if (bullet) bullets.push(bullet);
  }
  return bullets.length > 0 ? bullets.join("\n") : undefined;
}

function kebabName(name: string): string {
  const kebab = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `skill:${kebab || "skill"}`;
}

function importProvenance(value: unknown): SkillProvenance {
  const raw = value && typeof value === "object" ? (value as Partial<SkillProvenance>) : {};
  return {
    source: "import",
    ...(typeof raw.originRepo === "string" && raw.originRepo ? { originRepo: raw.originRepo } : {}),
    ...(typeof raw.capturedAt === "string" && raw.capturedAt ? { capturedAt: raw.capturedAt } : {}),
    ...(typeof raw.episodeId === "string" && raw.episodeId ? { episodeId: raw.episodeId } : {}),
  };
}

function metadataNumber(frontmatter: YamlObject, key: string): number | undefined {
  const metadata = frontmatter.metadata;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return undefined;
  const value = (metadata as YamlObject)[key];
  return isFiniteNumber(value) ? value : undefined;
}

function metadataValue(frontmatter: YamlObject, key: string): unknown {
  const metadata = frontmatter.metadata;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return undefined;
  return (metadata as YamlObject)[key];
}

/**
 * Parse an exported or external SKILL.md. Imported skills always start as
 * correctable and never inherit local success evidence or canary validation.
 */
export function parseSkillMarkdown(markdown: string): SkillState | undefined {
  const parsed = parseFrontmatter(markdown);
  if (!parsed) return undefined;

  const nameValue = parsed.frontmatter.name;
  const name = typeof nameValue === "string" ? nameValue.trim() : "";
  if (!name) return undefined;

  const rawId = metadataValue(parsed.frontmatter, "id");
  const providedId = typeof rawId === "string" ? rawId.trim() : "";
  const score = metadataNumber(parsed.frontmatter, "score");
  const uses = metadataNumber(parsed.frontmatter, "uses");
  const updatedAt = metadataNumber(parsed.frontmatter, "updatedAt");
  const provenanceRaw = metadataValue(parsed.frontmatter, "provenance");

  return {
    id: providedId || kebabName(name),
    name,
    score: score ?? 0,
    uses: uses ?? 0,
    lastOutcome: "pass",
    updatedAt: updatedAt ?? 0,
    outcomeKind: "correctable",
    provenance: importProvenance(provenanceRaw),
    ...(bodyGuidance(parsed.body) ? { guidance: bodyGuidance(parsed.body)! } : {}),
  };
}
