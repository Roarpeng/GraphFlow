import type { RiskClass } from "../trace.js";

/** Capability vocabulary (spec §7). Mirrors policies/capabilities-v1.json. */
export type Capability =
  | "filesystem.read"
  | "filesystem.write"
  | "process.exec"
  | "network.connect"
  | "git.write"
  | "package.install"
  | "secret.read"
  | "agent.spawn";

export interface CapabilityInfo {
  id: Capability;
  description: string;
  /** Granted without operator involvement under the default policy (still subject to risk gating). */
  defaultGranted: boolean;
  /** Risk class a command needing only this capability typically lands in. */
  typicalRisk: RiskClass;
}

export const CAPABILITIES: readonly CapabilityInfo[] = Object.freeze([
  {
    id: "filesystem.read",
    description: "Read files inside the workspace.",
    defaultGranted: true,
    typicalRisk: "R0",
  },
  {
    id: "filesystem.write",
    description: "Create, modify or delete files inside the workspace; protected paths are always excluded.",
    defaultGranted: true,
    typicalRisk: "R1",
  },
  {
    id: "process.exec",
    description: "Run a local process (tests, builds, scripts).",
    defaultGranted: true,
    typicalRisk: "R1",
  },
  {
    id: "network.connect",
    description: "Open network connections (HTTP, SSH, package registries, git remotes).",
    defaultGranted: false,
    typicalRisk: "R2",
  },
  {
    id: "git.write",
    description: "Mutate git state: commits, branches, config, pushes or remote repository changes.",
    defaultGranted: false,
    typicalRisk: "R2",
  },
  {
    id: "package.install",
    description: "Install, update or download third-party packages.",
    defaultGranted: false,
    typicalRisk: "R2",
  },
  {
    id: "secret.read",
    description: "Read credentials, private keys, tokens or secret environment variables.",
    defaultGranted: false,
    typicalRisk: "R3",
  },
  {
    id: "agent.spawn",
    description: "Launch an additional AI agent process (sub-agent).",
    defaultGranted: false,
    typicalRisk: "R5",
  },
].map((entry) => Object.freeze(entry as CapabilityInfo)));

export const CAPABILITY_IDS: readonly Capability[] = Object.freeze(CAPABILITIES.map((c) => c.id));

export function isCapability(value: unknown): value is Capability {
  return typeof value === "string" && (CAPABILITY_IDS as readonly string[]).includes(value);
}

/** Stable ordering (declaration order) for capability lists. */
export function sortCapabilities(caps: Iterable<Capability>): Capability[] {
  const set = new Set(caps);
  return CAPABILITY_IDS.filter((id) => set.has(id));
}
