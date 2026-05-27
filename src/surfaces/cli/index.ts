#!/usr/bin/env node

import { runSimpleTask } from "../../core/state-machine";

async function main(): Promise<void> {
  const [, , command, ...args] = process.argv;

  if (command !== "run") {
    console.log("Usage: graphflow run \"<task>\"");
    process.exitCode = 1;
    return;
  }

  const task = args.join(" ").trim();
  if (!task) {
    console.log("Task is required.");
    process.exitCode = 1;
    return;
  }

  const result = await runSimpleTask({ task });
  console.log(`status=${result.status}; attempts=${result.attempts}; feedback=${result.feedback}`);
}

main().catch((error) => {
  console.error("GraphFlow execution failed:", error);
  process.exitCode = 1;
});
