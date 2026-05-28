#!/usr/bin/env node

import { indexGraph, previewContext, runTask } from "./runtime";

async function main(): Promise<void> {
  const [, , command, ...args] = process.argv;

  if (!command) {
    console.log(
      "Usage: graphflow run \"<task>\" | graphflow context preview \"<query>\" | graphflow graph index [path]"
    );
    process.exitCode = 1;
    return;
  }

  if (command === "run") {
    const task = args.join(" ").trim();
    if (!task) {
      console.log("Task is required.");
      process.exitCode = 1;
      return;
    }

    const output = await runTask(task);
    console.log(output);
    return;
  }

  if (command === "context" && args[0] === "preview") {
    const query = args.slice(1).join(" ").trim();
    if (!query) {
      console.log("Context query is required.");
      process.exitCode = 1;
      return;
    }

    const preview = await previewContext(query);
    console.log(
      [
        `summary=${preview.summaryCount}`,
        `anchors=${preview.anchorCount}`,
        `tokens=${preview.tokenEstimate}`,
        `truncated=${preview.truncated}`,
        `L1=${preview.anchorsByLayer.l1}`,
        `L2=${preview.anchorsByLayer.l2}`,
        `L3=${preview.anchorsByLayer.l3}`,
      ].join("; ")
    );
    return;
  }

  if (command === "graph" && args[0] === "index") {
    const pathArg = args[1]?.trim();
    const result = await indexGraph(pathArg || undefined);
    console.log(`indexedFiles=${result.indexedFiles}; indexedSymbols=${result.indexedSymbols}`);
    return;
  }

  console.log(
    "Usage: graphflow run \"<task>\" | graphflow context preview \"<query>\" | graphflow graph index [path]"
  );
  process.exitCode = 1;
}

main().catch((error) => {
  console.error("GraphFlow execution failed:", error);
  process.exitCode = 1;
});
