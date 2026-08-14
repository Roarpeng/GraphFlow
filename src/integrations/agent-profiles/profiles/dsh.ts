import { profileRegistry } from "../registry";
import { resolveDshHome, getDshHarnessPaths } from "../../dsh-harness-installer";

export function registerDshProfile(): void {
  const paths = getDshHarnessPaths(resolveDshHome());

  profileRegistry.registerProfile({
    id: "deepseek-harness",
    name: "DeepSeek Harness",
    markerPaths: [paths.dshHome],
    userTargets: [],
  });
}

registerDshProfile();
