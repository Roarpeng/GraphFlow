#!/usr/bin/env node

import {
  diagnoseRouting,
  diagnoseRoutingResult,
  downloadOpenBmbModel,
  enrichSemanticsSilent,
  getSkillInsights,
  indexGraph,
  inspectGraph,
  planAndBrainstorm,
  planAndBrainstormResult,
  previewContext,
  runLearningNightly,
  runLearningNightlyResult,
  runTask,
  runTaskResult,
} from "./runtime";
import { buildCliUsage, formatCliResult, getCliVersion, parseCliOptions, type CliCommandResult } from "./output";

async function executeCommand(command: string, args: string[], configPath?: string): Promise<CliCommandResult | undefined> {
  if (command === "config" && args[0] === "init") {
    const isGlobal = args.includes("--global");
    const targetPath = isGlobal 
      ? require("node:path").join(require("node:os").homedir(), ".graphflow.config.json") 
      : "graphflow.config.json";

    if (require("node:fs").existsSync(targetPath)) {
      console.log(`Config already exists at ${targetPath}`);
      process.exitCode = 1;
      return undefined;
    }

    const { getDefaultConfig } = require("./runtime");
    require("node:fs").writeFileSync(targetPath, JSON.stringify(getDefaultConfig(), null, 2) + "\n");
    return {
      command: "config-init",
      data: { targetPath },
      legacyText: `Config generated at ${targetPath}`,
    };
  }

  if (command === "run") {
    const task = args.join(" ").trim();
    if (!task) {
      console.log("Task is required.");
      process.exitCode = 1;
      return undefined;
    }

    const data = await runTaskResult(task, configPath);
    return {
      command,
      data,
      legacyText: await runTask(task, configPath),
    };
  }

  if (command === "plan") {
    const task = args.join(" ").trim();
    if (!task) {
      console.log("Task is required.");
      process.exitCode = 1;
      return undefined;
    }

    const data = planAndBrainstormResult(task);
    return {
      command,
      data,
      legacyText: planAndBrainstorm(task),
    };
  }

  if (command === "context" && args[0] === "preview") {
    const query = args.slice(1).join(" ").trim();
    if (!query) {
      console.log("Context query is required.");
      process.exitCode = 1;
      return undefined;
    }

    const data = await previewContext(query, configPath);
    return {
      command: "context-preview",
      data,
      legacyText: [
        `summary=${data.summaryCount}`,
        `anchors=${data.anchorCount}`,
        `tokens=${data.tokenEstimate}`,
        `truncated=${data.truncated}`,
        `L1=${data.anchorsByLayer.l1}`,
        `L2=${data.anchorsByLayer.l2}`,
        `L3=${data.anchorsByLayer.l3}`,
      ].join("; "),
    };
  }

  if (command === "graph" && args[0] === "index") {
    const pathArg = args[1]?.trim();
    const data = await indexGraph(pathArg || undefined, configPath);
    return {
      command: "graph-index",
      data,
      legacyText: `indexedFiles=${data.indexedFiles}; indexedSymbols=${data.indexedSymbols}`,
    };
  }

  if (command === "graph" && args[0] === "inspect") {
    const data = await inspectGraph(configPath);
    return {
      command: "graph-inspect",
      data,
      legacyText: [
        `nodes=${data.nodeCount}`,
        `edges=${data.edgeCount}`,
        `types=${Object.entries(data.nodeTypeCount)
          .map(([type, count]) => `${type}:${count}`)
          .join(",")}`,
        `relations=${data.topRelations.map((item) => `${item.relation}:${item.count}`).join(",")}`,
      ].join("; "),
    };
  }

  if (command === "graph" && args[0] === "enrich") {
    const data = await enrichSemanticsSilent(configPath);
    return {
      command: "graph-enrich",
      data,
      legacyText: `enrichedCount=${data.enrichedCount}`,
    };
  }

  if (command === "skill" && args[0] === "insights") {
    const data = await getSkillInsights(configPath);
    return {
      command: "skill-insights",
      data,
      legacyText: [
        `source=${data.source}`,
        `transport=${data.transport}`,
        `count=${data.skills.length}`,
        `top=${data.skills.map((skill) => `${skill.name}:${skill.score}/${skill.uses}`).join(",")}`,
      ].join("; "),
    };
  }

  if (command === "route" && args[0] === "diagnose") {
    const data = diagnoseRoutingResult(configPath);
    return {
      command: "route-diagnose",
      data,
      legacyText: diagnoseRouting(configPath),
    };
  }

  if (command === "learn" && args[0] === "nightly") {
    const data = runLearningNightlyResult(configPath);
    return {
      command: "learn-nightly",
      data,
      legacyText: runLearningNightly(configPath),
    };
  }

  if (command === "model" && args[0] === "download") {
    const model = args[1]?.trim() || "minicpm-1b";
    let lastLine = "";
    const data = await downloadOpenBmbModel(configPath, {
      model,
      onProgress: (progress) => {
        const total = progress.totalBytes ? formatBytes(progress.totalBytes) : "unknown";
        const percent = progress.percent !== undefined ? `${progress.percent.toFixed(1)}%` : "...";
        const line = `${progress.stage} ${percent} ${formatBytes(progress.downloadedBytes)}/${total}`;
        if (line !== lastLine) {
          lastLine = line;
          console.error(`[graphflow:model-download] ${line}`);
        }
      },
    });
    return {
      command: "model-download",
      data,
      legacyText: `model=${data.model}; target=${data.targetPath}; bytes=${data.bytes}; skipped=${data.skipped}; verified=${data.verified}`,
    };
  }

  console.log(buildCliUsage());
  process.exitCode = 1;
  return undefined;
}

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value < 0) {
    return "0 B";
  }
  const units = ["B", "KB", "MB", "GB", "TB"];
  let size = value;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }
  return `${size.toFixed(size >= 10 || unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

async function main(): Promise<void> {
  const options = parseCliOptions(process.argv.slice(2));
  const command = options.command;

  if (!command) {
    console.log(buildCliUsage());
    process.exitCode = 1;
    return;
  }

  if (command === "help" || command === "--help" || command === "-h") {
    console.log(buildCliUsage());
    return;
  }

  if (command === "version" || command === "--version" || command === "-v") {
    console.log(getCliVersion());
    return;
  }

  const result = await executeCommand(command, options.args, options.configPath);
  if (!result) {
    return;
  }

  console.log(formatCliResult(result, options.json));
}

main().catch((error) => {
  console.error("GraphFlow execution failed:", error);
  process.exitCode = 1;
});
