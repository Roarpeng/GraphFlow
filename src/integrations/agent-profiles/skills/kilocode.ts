import { registerSkillTargets } from "../registry";
import { resolveHomePaths, join } from "../utils";

const { home } = resolveHomePaths();

registerSkillTargets([
  {
    agent: "Kilo Code",
    markerDir: join(home, ".kilocode"),
    skillsRoot: join(home, ".kilocode", "skills"),
  },
]);
