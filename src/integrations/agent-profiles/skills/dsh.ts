import { registerSkillTargets } from "../registry";
import { resolveDshHome, getDshHarnessPaths } from "../../dsh-harness-installer";

const paths = getDshHarnessPaths(resolveDshHome());

registerSkillTargets([
  {
    agent: "DeepSeek Harness",
    markerDir: paths.dshHome,
    skillsRoot: paths.skillsRoot,
  },
]);
