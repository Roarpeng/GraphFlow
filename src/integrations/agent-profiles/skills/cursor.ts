import { registerSkillTargets } from "../registry";
import { resolveHomePaths, join } from "../utils";

const { home } = resolveHomePaths();

registerSkillTargets([
  {
    agent: "Cursor",
    markerDir: join(home, ".cursor"),
    skillsRoot: join(home, ".cursor", "skills"),
  },
]);
