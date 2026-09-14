import { registerSkillTargets } from "../registry";
import { resolveHomePaths, join } from "../utils";

const { home } = resolveHomePaths();

registerSkillTargets([
  {
    agent: "ZCode",
    markerDir: join(home, ".zcode"),
    skillsRoot: join(home, ".zcode", "skills"),
  },
]);
