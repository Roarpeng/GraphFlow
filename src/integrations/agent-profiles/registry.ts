import type { AgentProfile, AgentSkillTarget, ProfileRegistry } from "./types";

class DefaultProfileRegistry implements ProfileRegistry {
  private profiles: AgentProfile[] = [];
  private skillTargets: AgentSkillTarget[] = [];

  registerProfile(profile: AgentProfile): void {
    const existingIndex = this.profiles.findIndex((p) => p.id === profile.id);
    if (existingIndex >= 0) {
      this.profiles[existingIndex] = profile;
    } else {
      this.profiles.push(profile);
    }
  }

  registerSkillTarget(target: AgentSkillTarget): void {
    const existingIndex = this.skillTargets.findIndex((t) => t.agent === target.agent);
    if (existingIndex >= 0) {
      this.skillTargets[existingIndex] = target;
    } else {
      this.skillTargets.push(target);
    }
  }

  getProfiles(): AgentProfile[] {
    return [...this.profiles];
  }

  getSkillTargets(): AgentSkillTarget[] {
    return [...this.skillTargets];
  }
}

export const profileRegistry: ProfileRegistry = new DefaultProfileRegistry();

export function registerProfiles(profiles: AgentProfile[]): void {
  for (const profile of profiles) {
    profileRegistry.registerProfile(profile);
  }
}

export function registerSkillTargets(targets: AgentSkillTarget[]): void {
  for (const target of targets) {
    profileRegistry.registerSkillTarget(target);
  }
}
