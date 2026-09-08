import { registerSkillTargets } from "../registry";
import { join } from "../utils";
import { resolveKimiCodeHome } from "../../kimi-code-paths";

const kimiHome = resolveKimiCodeHome();

registerSkillTargets([
  {
    agent: "Kimi Code",
    markerDir: kimiHome,
    skillsRoot: join(kimiHome, "skills"),
  },
]);
