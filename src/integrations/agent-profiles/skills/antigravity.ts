import { registerSkillTargets } from "../registry";
import { resolveHomePaths, join } from "../utils";

const { home } = resolveHomePaths();

registerSkillTargets([
  {
    agent: "Antigravity",
    markerDir: join(home, ".gemini", "antigravity"),
    skillsRoot: join(home, ".gemini", "antigravity", "skills"),
  },
]);
