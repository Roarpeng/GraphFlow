export interface CanaryDecision {
  allowNewPolicy: boolean;
  reason: string;
}

export function evaluateCanary(
  trafficPercent: number,
  firstPassRateDelta: number,
  tokenDelta: number
): CanaryDecision {
  if (trafficPercent <= 0) {
    return { allowNewPolicy: false, reason: "Canary traffic is disabled." };
  }

  if (firstPassRateDelta < 0 || tokenDelta > 0) {
    return { allowNewPolicy: false, reason: "Metrics regressed, rollback required." };
  }

  return { allowNewPolicy: true, reason: "Metrics passed canary gate." };
}
