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

/**
 * agentskills.io progressive-disclosure guidance: SKILL.md body should stay
 * under ~5000 tokens; longer material belongs in references/ files that
 * agents load on demand. GraphFlow approximates tokens as chars/4 so the
 * limit check stays dependency-free and deterministic.
 */
export const SKILL_BODY_TOKEN_LIMIT = 5000;
export const SKILL_BODY_CHARS_PER_TOKEN = 4;
export const SKILL_BODY_CHAR_LIMIT = SKILL_BODY_TOKEN_LIMIT * SKILL_BODY_CHARS_PER_TOKEN;

export interface SkillMarkdownReference {
  /** Path relative to the skill directory, e.g. "references/playbook.md". */
  path: string;
  content: string;
}

export interface SkillMarkdownBundle {
  markdown: string;
  references: SkillMarkdownReference[];
}

function stateBullets(state: SkillState): string[] {
  const source =
    state.playbook && state.playbook.length > 0
      ? serializePlaybookGuidance(state.playbook)
      : (state.guidance ?? "");
  return source
    .split(/\r?\n/)
    .map(normalizeBullet)
    .filter((line): line is string => line !== undefined);
}

function markdownBody(state: SkillState): string {
  const bullets = stateBullets(state);
  return bullets.length > 0 ? `${bullets.join("\n")}\n` : "";
}

/**
 * Serialize a skill as an Agent Skills (agentskills.io) compatible SKILL.md.
 * Learning evidence is intentionally not exported: another tool should not
 * inherit GraphFlow's trust decision.
 *
 * Spec alignment (agentskills.io/specification):
 * - name: lowercase alphanumeric + hyphens, 1-64 chars, no leading/trailing
 *   or consecutive hyphens, must match the parent directory name. GraphFlow
 *   internal names may contain spaces/uppercase, so they are slugified.
 * - description: required, 1-1024 chars, states what the skill does AND when
 *   to use it. Derived from guidance when no explicit description exists.
 * - license / compatibility / metadata: optional passthrough.
 * - body: markdown instructions (<5000 tokens recommended); playbook bullets
 *   become `- text` lines; longer material should move to references/.
 */
export function skillToSkillMarkdown(state: SkillState): string {
  const extended = state as SkillState & {
    description?: unknown;
    license?: unknown;
    compatibility?: unknown;
  };
  const optionalDescription = typeof extended.description === "string" && extended.description.trim()
    ? extended.description.trim()
    : deriveDescription(state);
  const specName = toSpecName(state.name);
  const lines = [
    "---",
    `name: ${yamlScalar(specName)}`,
    `description: ${yamlScalar(optionalDescription)}`,
    ...(typeof extended.license === "string" && extended.license.trim()
      ? [`license: ${yamlScalar(extended.license.trim())}`]
      : []),
    ...(typeof extended.compatibility === "string" && extended.compatibility.trim()
      ? [`compatibility: ${yamlScalar(extended.compatibility.trim().slice(0, 500))}`]
      : []),
    "metadata:",
    `  id: ${yamlScalar(state.id)}`,
    `  graphflow-name: ${yamlScalar(state.name)}`,
    ...(isFiniteNumber(state.score) ? [`  score: ${state.score}`] : []),
    ...(isFiniteNumber(state.uses) ? [`  uses: ${state.uses}`] : []),
    ...(isFiniteNumber(state.updatedAt) ? [`  updatedAt: ${state.updatedAt}`] : []),
  ];

  lines.push("---");
  return `${lines.join("\n")}\n\n${markdownBody(state)}`;
}

/**
 * Progressive disclosure (agentskills.io): SKILL.md stays a compact pointer
 * (metadata + top guidance bullets); oversized playbook/guidance material
 * moves to references/ files that agents load on demand. Returns both the
 * SKILL.md text and the files to write beside it (one directory per skill).
 */
export function skillToSkillMarkdownBundle(state: SkillState): SkillMarkdownBundle {
  const markdown = skillToSkillMarkdown(state);
  const bullets = stateBullets(state);
  // Split decision uses the FULL guidance size; the SKILL.md body itself only
  // keeps a compact pointer when the material is oversized.
  const full = bullets.join("\n");
  if (full.length <= SKILL_BODY_CHAR_LIMIT) {
    return { markdown, references: [] };
  }
  const chunks: SkillMarkdownReference[] = [];
  const chunkSize = 200;
  for (let i = 0; i < bullets.length; i += chunkSize) {
    const slice = bullets.slice(i, i + chunkSize);
    if (slice.length === 0) break;
    chunks.push({
      path: `references/guidance-${Math.floor(i / chunkSize) + 1}.md`,
      content: `# Guidance (part ${Math.floor(i / chunkSize) + 1})\n\n${slice.join("\n")}\n`,
    });
  }
  const pointer = bullets.slice(0, 40).join("\n");
  const indexLines = [
    ...pointer ? [pointer, ""] : [],
    ...chunks.map((c) => `- details: ${c.path} (load on demand)`),
  ];
  const body = indexLines.length > 0 ? `${indexLines.join("\n")}\n` : "";
  // Rebuild the frontmatter from the plain export, replacing the body.
  const split = markdown.indexOf("\n---\n", 3);
  const frontmatter = markdown.slice(0, split + 5);
  return { markdown: `${frontmatter}\n${body}`, references: chunks };
}

/**
 * agentskills.io name rule: 1-64 chars, lowercase alnum + hyphens only,
 * no leading/trailing/consecutive hyphens. Slugify internal display names.
 */
export function toSpecName(name: string): string {
  const slug = name
    .toLowerCase()
    .normalize("NFKD")
    // biome-ignore lint/suspicious/noMisleadingCharacterClass: intentional combining-mark strip
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/^-+|-+$/g, "");
  return slug || "skill";
}

export function isSpecName(name: string): boolean {
  if (name.length < 1 || name.length > 64) return false;
  if (name !== name.toLowerCase()) return false;
  if (!/^[a-z0-9-]+$/.test(name)) return false;
  if (name.startsWith("-") || name.endsWith("-") || name.includes("--")) return false;
  return true;
}

/** Build a spec-compliant description (what + when) from playbook/guidance. */
function deriveDescription(state: SkillState): string {
  const source =
    state.playbook && state.playbook.length > 0
      ? state.playbook.map((b) => b.text.replace(/^[-*•]\s+/, "").trim()).filter(Boolean).join("; ")
      : (state.guidance ?? "").split(/\r?\n/).map((l) => l.replace(/^[-*+]\s+/, "").trim()).filter(Boolean).join("; ");
  const what = source ? source.slice(0, 800) : `Project guidance captured as "${state.name}"`;
  const text = `${what}. Use when working on tasks related to ${state.name}.`;
  return text.slice(0, 1024);
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
 *
 * Accepts both GraphFlow-native exports (spec name + metadata.graphflow-name)
 * and third-party agentskills.io files (spec name only): the display name
 * prefers metadata.graphflow-name, falling back to the spec slug.
 */
export function parseSkillMarkdown(markdown: string): SkillState | undefined {
  const parsed = parseFrontmatter(markdown);
  if (!parsed) return undefined;

  // Import is lenient: accept any non-empty name (hand-written or third-party
  // files may predate the spec) and normalize. Export is strict: it always
  // emits a spec-compliant name. The display name prefers
  // metadata.graphflow-name so a GraphFlow round-trip preserves it exactly.
  const nameValue = parsed.frontmatter.name;
  const rawName = typeof nameValue === "string" ? nameValue.trim() : "";
  if (!rawName) return undefined;
  const specName = toSpecName(rawName);

  // description is required by agentskills.io; GraphFlow-native exports always
  // carry it (derived when absent). Third-party files without one are still
  // importable — description is advisory for ranking, not identity.
  const descriptionValue = parsed.frontmatter.description;
  const description = typeof descriptionValue === "string" ? descriptionValue.trim().slice(0, 1024) : "";

  const rawGraphflowName = metadataValue(parsed.frontmatter, "graphflow-name");
  const displayName =
    typeof rawGraphflowName === "string" && rawGraphflowName.trim()
      ? rawGraphflowName.trim()
      : rawName;

  const rawId = metadataValue(parsed.frontmatter, "id");
  const providedId = typeof rawId === "string" ? rawId.trim() : "";
  const score = metadataNumber(parsed.frontmatter, "score");
  const uses = metadataNumber(parsed.frontmatter, "uses");
  const updatedAt = metadataNumber(parsed.frontmatter, "updatedAt");
  const provenanceRaw = metadataValue(parsed.frontmatter, "provenance");

  return {
    id: providedId || kebabName(specName),
    name: displayName,
    score: score ?? 0,
    uses: uses ?? 0,
    lastOutcome: "pass",
    updatedAt: updatedAt ?? 0,
    outcomeKind: "correctable",
    provenance: importProvenance(provenanceRaw),
    ...(description ? { description } : {}),
    ...(bodyGuidance(parsed.body) ? { guidance: bodyGuidance(parsed.body)! } : {}),
  } as SkillState;
}

/**
 * Validate a SKILL.md against the agentskills.io subset GraphFlow guarantees
 * on export. Returns human-readable violations (empty = valid).
 */
export function validateSkillMarkdown(markdown: string): string[] {
  const violations: string[] = [];
  const parsed = parseFrontmatter(markdown);
  if (!parsed) {
    return ["missing frontmatter (expected --- name/description ---)"];
  }
  const name = parsed.frontmatter.name;
  if (typeof name !== "string" || !name.trim()) {
    violations.push("name is required");
  } else if (!isSpecName(name.trim())) {
    violations.push(
      "name must be 1-64 chars, lowercase alnum + hyphens, no leading/trailing/consecutive hyphens"
    );
  }
  const description = parsed.frontmatter.description;
  if (typeof description !== "string" || !description.trim()) {
    violations.push("description is required (what the skill does + when to use it)");
  } else if (description.trim().length > 1024) {
    violations.push("description must be <= 1024 chars");
  }
  const compatibility = parsed.frontmatter.compatibility;
  if (
    compatibility !== undefined &&
    compatibility !== null &&
    (typeof compatibility !== "string" || compatibility.length > 500)
  ) {
    violations.push("compatibility must be a string <= 500 chars");
  }
  if (markdown.length > 0 && !bodyGuidance(parsed.body)) {
    violations.push("body has no bullet instructions (agents load SKILL.md body on activation)");
  }
  // Progressive disclosure: body should stay under the ~5000-token guidance.
  // Oversized content must be split into references/ files by the exporter.
  if (parsed.body.length > SKILL_BODY_CHAR_LIMIT) {
    violations.push(
      `body exceeds ${SKILL_BODY_TOKEN_LIMIT} tokens (approx); move material to references/ (progressive disclosure)`
    );
  }
  return violations;
}

/**
 * agentskills.io requires the parent directory name to equal the skill name.
 * Validates (and derives) the layout directory for one exported skill.
 */
export function skillDirectoryFor(state: SkillState): string {
  return toSpecName(state.name);
}
