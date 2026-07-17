import { registerSkillTargets } from "../registry";
import { resolveHomePaths, join } from "../utils";

const { home } = resolveHomePaths();

registerSkillTargets([
  {
    agent: "Claude Code",
    markerDir: join(home, ".claude"),
    skillsRoot: join(home, ".claude", "skills"),
  },
]);
