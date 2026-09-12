/**
 * Observation policy resolution: every ObservationPolicy field is optional at
 * the call site and merged field-wise over these defaults.
 */

import type { ObservationPolicy } from "./types.js";

export interface ResolvedObservationReducePolicy {
  enabled: boolean;
  strategy: "fingerprint" | "llm";
  maxReceiptTokens: number;
  maxSourceBytes: number;
}

export interface ResolvedObservationPolicy {
  enabled: boolean;
  inlineThresholdBytes: number;
  headBytes: number;
  tailBytes: number;
  maxStoreBytes: number;
  ttlDays: number;
  redactOnStore: boolean;
  reduce: ResolvedObservationReducePolicy;
}

export const DEFAULT_OBSERVATION_POLICY: ResolvedObservationPolicy = {
  enabled: true,
  inlineThresholdBytes: 8192,
  headBytes: 2048,
  tailBytes: 1536,
  maxStoreBytes: 268435456, // 256 MiB
  ttlDays: 14,
  redactOnStore: true,
  reduce: {
    enabled: true,
    strategy: "fingerprint",
    maxReceiptTokens: 400,
    maxSourceBytes: 2097152, // 2 MiB
  },
};

export function resolveObservationPolicy(policy?: ObservationPolicy): ResolvedObservationPolicy {
  const base = DEFAULT_OBSERVATION_POLICY;
  if (!policy) {
    return { ...base, reduce: { ...base.reduce } };
  }
  return {
    enabled: policy.enabled ?? base.enabled,
    inlineThresholdBytes: policy.inlineThresholdBytes ?? base.inlineThresholdBytes,
    headBytes: policy.headBytes ?? base.headBytes,
    tailBytes: policy.tailBytes ?? base.tailBytes,
    maxStoreBytes: policy.maxStoreBytes ?? base.maxStoreBytes,
    ttlDays: policy.ttlDays ?? base.ttlDays,
    redactOnStore: policy.redactOnStore ?? base.redactOnStore,
    reduce: {
      enabled: policy.reduce?.enabled ?? base.reduce.enabled,
      strategy: policy.reduce?.strategy ?? base.reduce.strategy,
      maxReceiptTokens: policy.reduce?.maxReceiptTokens ?? base.reduce.maxReceiptTokens,
      maxSourceBytes: policy.reduce?.maxSourceBytes ?? base.reduce.maxSourceBytes,
    },
  };
}
