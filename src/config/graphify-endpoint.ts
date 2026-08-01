/**
 * Validation for the Graphify team-backend endpoint (graphPolicy.mcpEndpoint).
 *
 * Leaf module (no imports) so both config loading and the Graphify MCP client
 * can use it without introducing dependency cycles.
 */

/** Returns an error message when `endpoint` is not a usable http(s) URL, else null. */
export function validateGraphifyEndpoint(endpoint: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    return `graphPolicy.mcpEndpoint must be an http(s) URL, got "${endpoint}"`;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return `graphPolicy.mcpEndpoint must be an http(s) URL, got protocol "${parsed.protocol}"`;
  }
  return null;
}
