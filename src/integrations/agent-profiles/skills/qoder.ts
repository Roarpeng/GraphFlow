import { registerSkillTargets } from "../registry";
import { resolveHomePaths, join } from "../utils";

const { home } = resolveHomePaths();

registerSkillTargets([
  {
    agent: "Qoder",
    markerDir: join(home, ".qoder"),
    skillsRoot: join(home, ".qoder", "skills"),
  },
  {
    // Qoder CN 版（~/.qoder-cn）
    agent: "Qoder CN",
    markerDir: join(home, ".qoder-cn"),
    skillsRoot: join(home, ".qoder-cn", "skills"),
  },
]);
