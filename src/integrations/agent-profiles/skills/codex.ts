import { registerSkillTargets } from "../registry";
import { resolveHomePaths, join } from "../utils";

const { home } = resolveHomePaths();

registerSkillTargets([
  {
    agent: "Codex",
    markerDir: join(home, ".codex"),
    skillsRoot: join(home, ".codex", "skills"),
  },
  {
    agent: "Codex (agents)",
    markerDir: join(home, ".codex"),
    skillsRoot: join(home, ".agents", "skills"),
  },
]);
