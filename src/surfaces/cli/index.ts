#!/usr/bin/env node

import {
  diagnoseRouting,
  diagnoseRoutingResult,
  downloadOpenBmbModel,
  enrichSemanticsSilent,
  exportArtifact,
  getMetrics,
  getSkillInsights,
  getTokenSavingsStats,
  importArtifact,
  indexFile,
  indexGraph,
  inspectGraph,
  planAndBrainstorm,
  planAndBrainstormResult,
  planInsightResult,
  previewContext,
  rebuildGraph,
  resetTokenSavingsStats,
  runLearningNightly,
  runLearningNightlyResult,
  runTask,
  runTaskResult,
} from "./runtime";
import { buildCliUsage, formatCliResult, getCliVersion, parseCliOptions, type CliCommandResult } from "./output";

async function executeCommand(command: string, args: string[], configPath?: string): Promise<CliCommandResult | undefined> {
  if (command === "install") {
    const { runInstall } = require("./init");
    runInstall();
    return {
      command: "install",
      data: {},
      legacyText: `Installation complete`,
    };
  }

  if (command === "init" || (command === "config" && args[0] === "init")) {
    const { runInit } = require("./init");
    runInit();
    return {
      command: "init",
      data: {},
      legacyText: `Initialization complete`,
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

  if (command === "plan" && args[0] === "insight") {
    const task = args.slice(1).join(" ").trim();
    if (!task) {
      console.log("Task is required for 'plan insight'.");
      process.exitCode = 1;
      return undefined;
    }

    const data = await planInsightResult(task, configPath);
    return {
      command: "plan-insight",
      data,
      legacyText: buildInsightLegacyText(data),
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
      legacyText: `indexedFiles=${data.indexedFiles}; indexedSymbols=${data.indexedSymbols}; indexedReferences=${data.indexedReferences}`,
    };
  }

  if (command === "graph" && args[0] === "file") {
    const filePath = args[1]?.trim();
    if (!filePath) {
      console.log("File path is required for 'graph file <path>'.");
      process.exitCode = 1;
      return undefined;
    }
    const data = await indexFile(filePath, configPath);
    return {
      command: "graph-file",
      data,
      legacyText: data.skipped
        ? `path=${data.path}; skipped=${data.skipped}; reason=${data.reason ?? "unknown"}`
        : `path=${data.path}; indexedFiles=${data.indexedFiles}; indexedSymbols=${data.indexedSymbols}; indexedReferences=${data.indexedReferences}`,
    };
  }

  if (command === "graph" && args[0] === "rebuild") {
    const pathArg = args[1]?.trim();
    const data = await rebuildGraph(pathArg || undefined, configPath);
    return {
      command: "graph-rebuild",
      data,
      legacyText: `cleared=${data.cleared}; storePath=${data.storePath}; indexedFiles=${data.indexedFiles}; indexedSymbols=${data.indexedSymbols}`,
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
    const model = args[1]?.trim() || "minicpm5-1b";
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

  if (command === "artifact" && args[0] === "export") {
    const outputPath = args[1]?.trim() || undefined;
    const noCompress = args.includes("--no-compress");
    const data = await exportArtifact(configPath, outputPath, undefined, noCompress ? { compression: "none" } : undefined);
    return {
      command: "artifact-export",
      data,
      legacyText: `path=${data.path}; nodes=${data.nodeCount}; edges=${data.edgeCount}; bytes=${data.bytes}; uncompressedBytes=${data.uncompressedBytes}; compression=${data.compression}; sha256=${data.sha256.slice(0, 12)}...`,
    };
  }

  if (command === "artifact" && args[0] === "import") {
    const inputPath = args[1]?.trim() || undefined;
    const data = await importArtifact(configPath, inputPath);
    return {
      command: "artifact-import",
      data,
      legacyText: data.skipped
        ? `path=${data.path}; skipped=${data.skipped}; reason=${data.reason ?? "unknown"}`
        : `path=${data.path}; nodes=${data.nodeCount}; edges=${data.edgeCount}; imported=${data.imported}`,
    };
  }

  if (command === "stats") {
    if (args[0] === "reset") {
      const data = resetTokenSavingsStats(configPath);
      return {
        command: "stats-reset",
        data,
        legacyText: `path=${data.path}; reset=${data.reset}`,
      };
    }
    const data = getTokenSavingsStats(configPath);
    return {
      command: "stats",
      data,
      legacyText: [
        `runs=${data.totalRuns}`,
        `rawTokens=${data.totalRawTokens}`,
        `compressedTokens=${data.totalCompressedTokens}`,
        `savedTokens=${data.totalSavedTokens}`,
        `avgSavings=${data.averageSavingsPercent}%`,
        `firstRun=${data.firstRunAt ?? "n/a"}`,
        `lastRun=${data.lastRunAt ?? "n/a"}`,
      ].join("; "),
    };
  }

  if (command === "metrics") {
    const data = getMetrics(configPath);
    return {
      command: "metrics",
      data,
      legacyText: data.text,
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

function buildInsightLegacyText(
  data: Awaited<ReturnType<typeof planInsightResult>>
): string {
  const lines: string[] = [];
  lines.push("=== Six Thinking Hats Insight ===");
  for (const hat of data.insight.hats) {
    const whyStatus = hat.whyChain !== null ? "[5Why triggered]" : "";
    lines.push(`[${hat.hat.name}] ${hat.hat.color.toUpperCase()} ${hat.hat.role} — 置信度 ${(hat.certainty * 100).toFixed(0)}% ${whyStatus}`);
    lines.push(`  观察: ${hat.observation}`);
    if (hat.whyChain) {
      for (const step of hat.whyChain.steps) {
        lines.push(`  Why ${step.level}: ${step.answer}`);
      }
      lines.push(`  → 根本原因: ${hat.whyChain.rootCause}`);
    }
    lines.push(`  关键洞察: ${hat.criticalInsight}`);
    lines.push("");
  }
  lines.push("=== Blue Hat 综合 ===");
  lines.push(data.insight.blueHatSynthesis);
  lines.push("");
  if (data.insight.rootCauses.length > 0) {
    lines.push("=== 根本原因汇总 ===");
    for (const rc of data.insight.rootCauses) {
      lines.push(`• ${rc}`);
    }
    lines.push("");
  }
  lines.push("=== refined task ===");
  lines.push(data.insight.refinedTaskStatement);
  lines.push("");
  lines.push("=== plan (informed by insight) ===");
  for (const node of data.plan) {
    const deps = node.dependencies.length > 0 ? `[${node.dependencies.join(",")}]` : "[-]";
    lines.push(`${node.id}${deps}: ${node.description}`);
  }
  return lines.join("\n");
}
