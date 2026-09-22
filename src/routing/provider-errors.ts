/**
 * Side-channel record of the last REAL adapter failure per provider.
 *
 * Non-strict provider adapters deliberately mask failures by echoing the
 * prompt back (`[openai:model] <prompt>`) so resilient callers degrade
 * gracefully. That resilience hides the underlying reason (401, quota,
 * network) from anyone who only sees the echoed string — the connectivity
 * probe and diagnose used to report "masked failure" without the cause.
 *
 * This module is dependency-free on purpose (no imports) so adapters,
 * health, and probing layers can share it without import cycles.
 */

export interface ProviderErrorRecord {
  provider: string;
  message: string;
  /** epoch ms of the last failure */
  at: number;
}

const lastErrors = new Map<string, ProviderErrorRecord>();

/** Record the underlying error behind a masked (echoed) adapter failure. */
export function recordProviderError(provider: string, message: string): void {
  if (!provider || !message) return;
  lastErrors.set(provider, { provider, message: message.slice(0, 400), at: Date.now() });
}

/** Most recent adapter failure for a provider (any age; callers decide staleness). */
export function getLastProviderError(provider: string): ProviderErrorRecord | undefined {
  return lastErrors.get(provider);
}

/** Test hook. */
export function resetProviderErrors(): void {
  lastErrors.clear();
}
