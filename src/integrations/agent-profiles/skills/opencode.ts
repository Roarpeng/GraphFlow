import { registerSkillTargets } from "../registry";
import { resolveHomePaths, join } from "../utils";

const { home } = resolveHomePaths();

registerSkillTargets([
  {
    agent: "Opencode",
    markerDir: join(home, ".config", "opencode"),
    skillsRoot: join(home, ".config", "opencode", "skills"),
  },
]);
