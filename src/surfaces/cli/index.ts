#!/usr/bin/env node

import {
  diagnoseRouting,
  diagnoseRoutingResult,
  exportArtifact,
  exportSkillPackageRuntime,
  getSkillInsights,
  getTokenSavingsStats,
  importArtifact,
  importSkillPackageRuntime,
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
  runLearnForget,
  runSkillDecay,
  runSkillReset,
  runSkillPrune,
  runTask,
  runTaskResult,
} from "./runtime";
import { validateConfigDetailed, type ConfigValidationResult } from "../../config/loader.js";
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

  if (command === "doctor") {
    const { buildDoctorReport, formatDoctorLegacyText } = require("./init") as typeof import("./init");
    const data = buildDoctorReport(process.cwd());
    if (!data.ok) {
      process.exitCode = 1;
    }
    return {
      command: "doctor",
      data,
      legacyText: formatDoctorLegacyText(data),
    };
  }

  if (command === "uninstall") {
    const { runUninstall } = require("./init");
    runUninstall();
    return {
      command: "uninstall",
      data: {},
      legacyText: `Uninstall complete`,
    };
  }

  if (command === "mcp" && args[0] === "remove") {
    const agentId = args.includes("--agent") ? args[args.indexOf("--agent") + 1] : undefined;
    const { runMcpRemove } = require("./init");
    runMcpRemove(agentId);
    return {
      command: "mcp-remove",
      data: {},
      legacyText: `MCP removal complete`,
    };
  }

  if (command === "config" && args[0] === "validate") {
    const data = validateConfigDetailed(configPath);
    return {
      command: "config-validate",
      data,
      legacyText: formatValidationResult(data),
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
    const pathArg = args[1]?.trim();
    const data = await inspectGraph(configPath, pathArg ? { rootDir: pathArg } : undefined);
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

  if (command === "skill" && args[0] === "export") {
    const outputPath = args[1]?.trim() || undefined;
    const data = await exportSkillPackageRuntime(configPath, outputPath);
    return {
      command: "skill-export",
      data,
      legacyText: `path=${data.path}; skillCount=${data.skillCount}; bytes=${data.bytes}`,
    };
  }

  if (command === "skill" && args[0] === "import") {
    const inputPath = args[1]?.trim() || undefined;
    const data = await importSkillPackageRuntime(configPath, inputPath);
    return {
      command: "skill-import",
      data,
      legacyText: `path=${data.path}; imported=${data.imported}; skipped=${data.skipped}; total=${data.total}`,
    };
  }

  if (command === "skill" && args[0] === "decay") {
    const data = await runSkillDecay(configPath);
    return {
      command: "skill-decay",
      data,
      legacyText: `total=${data.total}; decayed=${data.decayed}; skipped=${data.skipped}`,
    };
  }

  if (command === "skill" && args[0] === "reset") {
    const nameIdx = args.indexOf("--name");
    const skillName = nameIdx >= 0 ? args[nameIdx + 1]?.trim() : undefined;
    if (!skillName) {
      console.log("Skill name is required. Use --name <name>.");
      process.exitCode = 1;
      return undefined;
    }
    const data = await runSkillReset(skillName, configPath);
    return {
      command: "skill-reset",
      data,
      legacyText: `name=${data.name}; reset=${data.reset}`,
    };
  }

  if (command === "skill" && args[0] === "prune") {
    const data = await runSkillPrune(configPath);
    return {
      command: "skill-prune",
      data,
      legacyText: `pruned=${data.pruned}`,
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

  if (command === "artifact" && args[0] === "export") {
    const outputPath = args[1]?.trim() || undefined;
    const noCompress = args.includes("--no-compress");
    const includeEpisodes = args.includes("--include-episodes");
    const data = await exportArtifact(configPath, outputPath, undefined, {
      ...(noCompress ? { compression: "none" as const } : {}),
      ...(includeEpisodes ? { includeEpisodes: true } : {}),
    });
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

  if (command === "learn" && args[0] === "nightly") {
    const data = await runLearningNightlyResult(configPath);
    return {
      command: "learn-nightly",
      data,
      legacyText: await runLearningNightly(configPath),
    };
  }

  if (command === "learn" && args[0] === "forget") {
    const data = await runLearnForget(configPath);
    return {
      command: "learn-forget",
      data,
      legacyText: `removed=${data.removed}`,
    };
  }

  console.log(buildCliUsage());
  process.exitCode = 1;
  return undefined;
}

function formatValidationResult(data: ConfigValidationResult): string {
  const lines: string[] = [
    `configPath=${data.configPath}`,
    `valid=${data.valid}`,
  ];
  for (const issue of data.issues) {
    const icon = issue.severity === "error" ? "ERROR" : "WARN";
    lines.push(`[${icon}] ${issue.field}: ${issue.message}`);
  }
  return lines.join("\n");
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
