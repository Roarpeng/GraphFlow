import { registerSkillTargets } from "../registry";
import { resolveHomePaths, join } from "../utils";

const { home } = resolveHomePaths();

registerSkillTargets([
  {
    agent: "Roo Code",
    markerDir: join(home, ".roo"),
    skillsRoot: join(home, ".roo", "skills"),
  },
]);
