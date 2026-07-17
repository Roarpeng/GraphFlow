import { registerSkillTargets } from "../registry";
import { resolveHomePaths, join } from "../utils";

const { home } = resolveHomePaths();

registerSkillTargets([
  {
    agent: "Qoder",
    markerDir: join(home, ".qoder"),
    skillsRoot: join(home, ".qoder", "skills"),
  },
]);
