/**
 * Dialogue records live in the same store as code nodes. Callers that only
 * need the thread must recognize them without assuming a particular backend.
 *
 * Id prefixes are authoritative (`dialogue:<hash>:<seq>`, `dialogue-session:<hash>`).
 * Metadata kinds cover records written before the id scheme, but code nodes
 * (File / Module / Symbol) are never dialogue even if a kind field collides.
 */
export function isDialogueRecordNode(node: {
  id?: unknown;
  type?: unknown;
  metadata?: { kind?: unknown } | null;
}): boolean {
  if (typeof node.id !== "string" || node.id.length === 0) return false;
  if (node.id.startsWith("dialogue-session:") || node.id.startsWith("dialogue:")) return true;
  const type = typeof node.type === "string" ? node.type : "";
  if (type === "File" || type === "Module" || type === "Symbol") return false;
  const kind = node.metadata && typeof node.metadata === "object" ? node.metadata.kind : undefined;
  return kind === "dialogue-turn" || kind === "dialogue-session";
}
