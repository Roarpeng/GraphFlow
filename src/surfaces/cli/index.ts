#!/usr/bin/env node

import {
  diagnoseRouting,
  diagnoseRoutingResult,
  exportArtifact,
  exportExperienceMemory,
  exportSkillPackageRuntime,
  getFlywheelReport,
  getSkillInsights,
  getTokenSavingsStats,
  importArtifact,
  importSkillPackageRuntime,
  syncSkillPackageRuntime,
  indexFile,
  indexGraph,
  inspectGraph,
  listWorkbenchOutline,
  planAndBrainstorm,
  planAndBrainstormResult,
  planInsightResult,
  previewContext,
  captureAssistantReply,
  rebuildGraph,
  reportOutcome,
  resetTokenSavingsStats,
  runLearningNightly,
  runLearningNightlyResult,
  runLearnForget,
  runSkillDecay,
  runSkillReset,
  runSkillPrune,
  runSkillConsolidate,
  runTask,
  runTaskResult,
  submitAgentInsightResult,
  mergeAgentInsightResult,
  listEpisodes,
  searchEpisodes,
  forgetEpisode,
  listDialogueTurnsRuntime,
  recordDialogueTurnRuntime,
  resolveDialogueRecordInput,
  distillDialogueTurnsRuntime,
  type MemoryEpisodeItem,
  type MemorySearchHit,
  type MemoryOutcome,
  type DialogueListItem,
  type DistillDialogueResult,
} from "./runtime";
import { validateConfigDetailed, type ConfigValidationResult } from "../../config/loader.js";
import { isDeviationKind } from "../../learning/episodic-memory";
import {
  buildCliUsage,
  collectCliFlagValues,
  formatCliResult,
  getCliVersion,
  parseCliOptions,
  parseCliSuccess,
  readCliFlagValue,
  type CliCommandResult,
} from "./output";

async function executeCommand(command: string, args: string[], configPath?: string): Promise<CliCommandResult | undefined> {
  if (command === "install") {
    const { buildInstallReport, formatInstallLegacyText } = require("./init") as typeof import("./init");
    const data = buildInstallReport(process.cwd());
    if (!data.ok) {
      process.exitCode = 1;
    }
    return {
      command: "install",
      data,
      legacyText: formatInstallLegacyText(data),
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

  if (command === "outcome" && args[0] === "report") {
    const episodeId = args[1]?.trim();
    const success = parseCliSuccess(args[2]);
    if (!episodeId || success === undefined) {
      console.log("Usage: graphflow outcome report <episodeId> <success> [--lesson <text>]... [--deviation <none|misread-requirement|scope-creep|tech-drift>] [--requirement-id <id>]... [--concept-id <id>]... [--code-hint <hint>]...");
      process.exitCode = 1;
      return undefined;
    }
    const lessons = collectCliFlagValues(args, "--lesson");
    const deviationRaw = readCliFlagValue(args, "--deviation");
    const deviation = isDeviationKind(deviationRaw) ? deviationRaw : undefined;
    const requirementIds = collectCliFlagValues(args, "--requirement-id");
    const conceptIds = collectCliFlagValues(args, "--concept-id");
    const codeHints = collectCliFlagValues(args, "--code-hint");
    const hasEngHints =
      requirementIds.length > 0 || conceptIds.length > 0 || codeHints.length > 0;
    const data = await reportOutcome(
      episodeId,
      success,
      lessons,
      configPath,
      deviation,
      hasEngHints
        ? {
            ...(requirementIds.length > 0 ? { requirementIds } : {}),
            ...(conceptIds.length > 0 ? { conceptIds } : {}),
            ...(codeHints.length > 0 ? { codeHints } : {}),
          }
        : undefined
    );
    return {
      command: "outcome-report",
      data,
      legacyText: data.ok
        ? `ok=true; episodeId=${data.episodeId}; outcome=${data.outcome}; skillsUpdated=${data.skillsUpdated}${
            data.engineeringLinks
              ? `; engLinks=${data.engineeringLinks.edgeCount}`
              : ""
          }`
        : `ok=false; reason=${data.reason ?? "unknown"}`,
    };
  }

  if (command === "insight" && args[0] === "submit") {
    const task =
      readCliFlagValue(args, "--task") ??
      readCliFlagValue(args, "--task-text");
    const workItemId =
      readCliFlagValue(args, "--work-item-id") ??
      readCliFlagValue(args, "--workItemId");
    const response =
      readCliFlagValue(args, "--response") ??
      readCliFlagValue(args, "--response-json");
    const episodeId =
      readCliFlagValue(args, "--episode-id") ??
      readCliFlagValue(args, "--episodeId");
    if (!task || !workItemId || !response) {
      console.log(
        'Usage: graphflow insight submit --task "<task>" --work-item-id <id> --response "<json>" [--episode-id <id>]'
      );
      process.exitCode = 1;
      return undefined;
    }
    const data = await submitAgentInsightResult(
      task,
      workItemId,
      response,
      configPath,
      episodeId
    );
    return {
      command: "insight-submit",
      data,
      legacyText: data.ok
        ? `ok=true; nodeId=${data.nodeId}; mergeComplete=${data.merge?.complete ?? false}`
        : `ok=false; reason=${data.reason}`,
    };
  }

  if (command === "insight" && args[0] === "merge") {
    const task =
      readCliFlagValue(args, "--task") ??
      readCliFlagValue(args, "--task-text") ??
      args.slice(1).filter((part) => !part.startsWith("--")).join(" ").trim();
    if (!task) {
      console.log('Usage: graphflow insight merge --task "<task>"');
      process.exitCode = 1;
      return undefined;
    }
    const data = await mergeAgentInsightResult(task, configPath);
    return {
      command: "insight-merge",
      data,
      legacyText: `complete=${data.complete}; submitted=${data.submittedCount}; missing=${data.missing.join(",") || "none"}; planNodes=${data.plan.length}`,
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

    const data = await planAndBrainstormResult(task);
    return {
      command,
      data,
      legacyText: await planAndBrainstorm(task),
    };
  }

  if (command === "context" && args[0] === "preview") {
    const query = args
      .slice(1)
      .filter((part, index, all) => {
        if (part.startsWith("--")) return false;
        const prev = all[index - 1];
        if (prev === "--session" || prev === "--resume-from" || prev === "--reply" || prev === "--config" || prev === "--topic-id") {
          return false;
        }
        return true;
      })
      .join(" ")
      .trim();
    if (!query) {
      const replyOnly = readCliFlagValue(args, "--reply");
      if (!replyOnly) {
        console.log("Context query is required (or pass --reply to fill the pending assistant answer).");
        process.exitCode = 1;
        return undefined;
      }
      const sessionId = readCliFlagValue(args, "--session");
      const topicId = readCliFlagValue(args, "--topic-id");
      const data = await captureAssistantReply(replyOnly, configPath, undefined, {
        ...(sessionId ? { sessionId } : {}),
        ...(topicId ? { topicId } : {}),
      });
      return {
        command: "context-capture-reply",
        data,
        legacyText: data.ok
          ? `filled=${data.filled}; kind=${data.capture?.kind ?? "-"}; id=${data.capture?.id ?? "-"}`
          : `ok=false; reason=${data.reason ?? "unknown"}`,
      };
    }

    const sessionId = readCliFlagValue(args, "--session");
    const topicId = readCliFlagValue(args, "--topic-id");
    const resumeFrom = readCliFlagValue(args, "--resume-from");
    const reply = readCliFlagValue(args, "--reply");
    const data = await previewContext(query, configPath, undefined, undefined, {
      ...(sessionId ? { sessionId } : {}),
      ...(topicId ? { topicId } : {}),
      ...(resumeFrom ? { resumeFromTurnId: resumeFrom } : {}),
      ...(reply ? { assistantReply: reply } : {}),
    });
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
        `workbench=${data.workbenchOutline?.length ?? 0}`,
      ].join("; "),
    };
  }

  if (command === "workbench" && (args[0] === "tree" || args[0] === "outline" || !args[0])) {
    const data = await listWorkbenchOutline(configPath);
    return {
      command: "workbench-tree",
      data,
      legacyText: data.lines.join("\n"),
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

  if (command === "skill" && args[0] === "sync") {
    // Git-based team sharing: export to / import from the committable
    // `.graphflow/skills/team-skills.json` (override with --path <file>).
    // Import is a bidirectional MERGE: per-skill-id union, newer updatedAt
    // wins, ties keep local, local-only skills preserved; --force restores
    // overwrite semantics. Team golden queries ride along and merge into
    // `.graphflow/team-golden.json` (dedupe by text, local-first order).
    const directionArg = args[1]?.trim().toLowerCase();
    if (directionArg !== "export" && directionArg !== "import") {
      console.log("Usage: graphflow skill sync <export|import> [--path <file>] [--force]");
      console.log("  import MERGES per-skill-id: newer updatedAt wins; ties keep local; --force overwrites.");
      console.log("  team golden queries ride along -> .graphflow/team-golden.json (dedupe, local-first).");
      process.exitCode = 1;
      return undefined;
    }
    const pathIdx = args.indexOf("--path");
    const customPath = pathIdx >= 0 ? args[pathIdx + 1]?.trim() : undefined;
    const force = args.includes("--force");
    const data = await syncSkillPackageRuntime(configPath, directionArg, customPath, { force });
    return {
      command: "skill-sync",
      data,
      legacyText:
        data.direction === "export"
          ? `direction=export; path=${data.path}; skillCount=${data.skillCount}; bytes=${data.bytes}; goldenQueries=${data.goldenQueries ?? 0}`
          : `direction=import; path=${data.path}; imported=${data.imported}; skipped=${data.skipped}; updated=${data.updated}; total=${data.total}; goldenQueries=${data.goldenQueries ?? 0}`,
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

  if (command === "skill" && args[0] === "consolidate") {
    // Default dry-run; --apply / --execute opt-in mutates via applySkillConsolidation.
    const apply = args.includes("--apply") || args.includes("--execute");
    const data = await runSkillConsolidate(configPath, { apply });
    const appliedCount = data.applied?.applied.length ?? 0;
    const skippedCount = data.applied?.skipped.length ?? 0;
    return {
      command: "skill-consolidate",
      data,
      legacyText: [
        `dryRun=${data.dryRun}`,
        `updates=${data.summary.updates}`,
        `deletes=${data.summary.deletes}`,
        `adds=${data.summary.adds}`,
        `actions=${data.actions.length}`,
        ...(apply ? [`applied=${appliedCount}`, `skipped=${skippedCount}`] : []),
      ].join("; "),
    };
  }

  if (command === "skill" && args[0] === "report") {
    // Flywheel contribution report: skills health, most-used skills,
    // episode outcomes — makes the learning loop observable.
    const data = getFlywheelReport(configPath);
    return {
      command: "skill-report",
      data,
      legacyText: [
        `skills=${data.skills.total}(+${data.skills.positive}/0${data.skills.neutral}/-${data.skills.negative})`,
        `episodes=${data.episodes.total}(pass:${data.episodes.pass},fail:${data.episodes.fail},pending:${data.episodes.pending},lessons:${data.episodes.withLessons})`,
        `topUsed=${data.skills.topUsed.map((s) => `${s.name}:${s.uses}`).join(",") || "-"}`,
        `experience=conv:${data.experience.episodeToSkillConversionRate.toFixed(2)},lessons:${data.experience.lessonsCoverageRate.toFixed(2)},consol:${data.experience.consolidation.actionable}`,
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

  if (command === "artifact" && args[0] === "export-memory") {
    const outputDir = args[1]?.trim() || undefined;
    const data = await exportExperienceMemory(configPath, outputDir);
    return {
      command: "artifact-export-memory",
      data,
      legacyText: `path=${data.path}; skills=${data.skillCount}; episodes=${data.episodeCount}; files=${data.files.join(",")}`,
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

  if (command === "memory" && args[0] === "list") {
    // Audit view of episodic memory: evidence records (id, task, outcome,
    // lessons count, staleGoal flag, updatedAt), sorted by updatedAt desc.
    const limitRaw = readCliFlagValue(args, "--limit");
    const limit = limitRaw ? Number(limitRaw) : undefined;
    if (limit !== undefined && (!Number.isInteger(limit) || limit <= 0)) {
      console.log("Usage: graphflow memory list [--limit N] [--outcome pass|fail|pending] [--json] [--config <path>]");
      process.exitCode = 1;
      return undefined;
    }
    const outcomeRaw = readCliFlagValue(args, "--outcome");
    const outcome: MemoryOutcome | undefined =
      outcomeRaw === "pass" || outcomeRaw === "fail" || outcomeRaw === "pending"
        ? outcomeRaw
        : undefined;
    if (outcomeRaw && !outcome) {
      console.log("Usage: graphflow memory list [--limit N] [--outcome pass|fail|pending] [--json] [--config <path>]");
      process.exitCode = 1;
      return undefined;
    }
    const data = await listEpisodes(configPath, {
      ...(limit !== undefined ? { limit } : {}),
      ...(outcome ? { outcome } : {}),
    });
    return {
      command: "memory-list",
      data,
      legacyText: formatMemoryList(data),
    };
  }

  if (command === "memory" && args[0] === "search") {
    const query = args
      .slice(1)
      .filter((part) => !part.startsWith("--"))
      .join(" ")
      .trim();
    if (!query) {
      console.log('Usage: graphflow memory search "<query>" [--limit N] [--json] [--config <path>]');
      process.exitCode = 1;
      return undefined;
    }
    const limitRaw = readCliFlagValue(args, "--limit");
    const limit = limitRaw ? Number(limitRaw) : 10;
    if (!Number.isInteger(limit) || limit <= 0) {
      console.log('Usage: graphflow memory search "<query>" [--limit N] [--json] [--config <path>]');
      process.exitCode = 1;
      return undefined;
    }
    const data = await searchEpisodes(query, configPath, limit);
    return {
      command: "memory-search",
      data,
      legacyText: formatMemorySearch(data),
    };
  }

  if (command === "memory" && args[0] === "forget") {
    const episodeId = args[1]?.trim();
    if (!episodeId || episodeId.startsWith("--")) {
      console.log("Usage: graphflow memory forget <episodeId> [--json] [--config <path>]");
      process.exitCode = 1;
      return undefined;
    }
    const data = await forgetEpisode(episodeId, configPath);
    if (!data.found) {
      // Unknown id: clean no-op, reported without crashing.
      process.exitCode = 1;
    }
    return {
      command: "memory-forget",
      data,
      legacyText: `found=${data.found}; removed=${data.removed}; skillsHidden=${data.skillsHidden}${data.reason ? `; reason=${data.reason}` : ""}`,
    };
  }

  if (command === "dialogue" && args[0] === "list") {
    const limitRaw = readCliFlagValue(args, "--limit");
    const limit = limitRaw ? Number(limitRaw) : undefined;
    if (limit !== undefined && (!Number.isInteger(limit) || limit <= 0)) {
      console.log("Usage: graphflow dialogue list [--session <name|id>] [--limit N] [--json] [--config <path>]");
      process.exitCode = 1;
      return undefined;
    }
    const sessionId = readCliFlagValue(args, "--session");
    const data = await listDialogueTurnsRuntime(configPath, {
      ...(sessionId ? { sessionId } : {}),
      ...(limit !== undefined ? { limit } : {}),
    });
    return {
      command: "dialogue-list",
      data,
      legacyText: formatDialogueList(data),
    };
  }

  if (command === "dialogue" && args[0] === "record") {
    const input = resolveDialogueRecordInput(args);
    const query = input.query;
    if (!query) {
      if (input.reply) {
        const data = await recordDialogueTurnRuntime("", {
          ...(configPath ? { configPath } : {}),
          assistantReply: input.reply,
          ...(input.sessionId ? { sessionId: input.sessionId } : {}),
        });
        return {
          command: "dialogue-record",
          data,
          legacyText: data
            ? `id=${data.id}; seq=${data.seq}; filled=true; q=${data.userQuery}`
            : "skipped",
        };
      }
      console.log(
        'Usage: graphflow dialogue record --query "<text>" [--reply "<text>"] [--resume-from <turnId>] [--session <name>] [--json] [--config <path>]\n       graphflow dialogue record --reply "<text>"  (fill pending assistant answer)'
      );
      process.exitCode = 1;
      return undefined;
    }
    const data = await recordDialogueTurnRuntime(query, {
      ...(configPath ? { configPath } : {}),
      ...(input.reply ? { assistantReply: input.reply } : {}),
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      ...(input.resumeFrom ? { resumeFromTurnId: input.resumeFrom } : {}),
    });
    return {
      command: "dialogue-record",
      data,
      legacyText: data
        ? `id=${data.id}; seq=${data.seq}; jumped=${data.jumped}; q=${data.userQuery}`
        : "skipped",
    };
  }

  if (command === "dialogue" && args[0] === "distill") {
    const all = args.includes("--all");
    const sessionId = readCliFlagValue(args, "--session");
    const data = await distillDialogueTurnsRuntime(configPath, {
      ...(all ? { all: true } : {}),
      ...(sessionId ? { sessionId } : {}),
    });
    return {
      command: "dialogue-distill",
      data,
      legacyText: formatDialogueDistill(data),
    };
  }

  console.log(buildCliUsage());
  process.exitCode = 1;
  return undefined;
}

function formatMemoryList(items: MemoryEpisodeItem[]): string {
  const lines: string[] = [`count=${items.length}`];
  for (const item of items) {
    const stale = item.staleGoal ? `; staleGoal=${item.staleGoal}` : "";
    lines.push(
      `id=${item.id}; task=${item.task}; outcome=${item.outcome}; lessons=${item.lessons}; updatedAt=${new Date(item.updatedAt).toISOString()}${stale}`
    );
  }
  return lines.join("\n");
}

function formatMemorySearch(hits: MemorySearchHit[]): string {
  const lines: string[] = [`hits=${hits.length}`];
  for (const hit of hits) {
    lines.push(
      `id=${hit.id}; score=${hit.score.toFixed(3)}; outcome=${hit.outcome}; task=${hit.task}`
    );
  }
  return lines.join("\n");
}

function formatDialogueList(items: DialogueListItem[]): string {
  const lines: string[] = [`count=${items.length}`];
  for (const item of items) {
    const jump = item.jumped ? `; jump←${item.parentTurnId ?? "?"}` : "";
    const title = item.title ? `; title=${item.title}` : "";
    lines.push(
      `id=${item.id}; seq=${item.seq}${jump}; q=${item.userQuery}; a=${item.assistantReply || "(pending)"}${title}`
    );
  }
  return lines.join("\n");
}

function formatDialogueDistill(data: DistillDialogueResult): string {
  return `updated=${data.updated}; unchanged=${data.unchanged}; total=${data.total}`;
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
