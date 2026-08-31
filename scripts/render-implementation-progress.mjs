#!/usr/bin/env node
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyImplementationStart } from "./verify-implementation-progress.mjs";

const parseArgs = (argv) => {
  const result = { root: process.cwd(), gitRoot: undefined, packagePath: "docs/hybrid-flow-v1", write: false };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--root") result.root = resolve(argv[++index]);
    else if (flag === "--git-root") result.gitRoot = resolve(argv[++index]);
    else if (flag === "--package") result.packagePath = argv[++index] === "R2" ? "docs/hybrid-flow-v1-r2" : argv[index];
    else if (flag === "--write") result.write = true;
    else throw new Error(`unknown argument: ${flag}`);
  }
  result.gitRoot ??= result.root;
  return result;
};

export function renderProgress(verification) {
  const latest = new Map();
  for (const event of verification.events) {
    const key = `${event.stageId}/${event.gateId}`;
    latest.set(key, event.eventType === "step_completed" && event.terminalResult === "PASS" && event.evidenceVerified === true);
  }
  const lines = [
    "# Hybrid Agent Flow v1 — verified implementation progress",
    "",
    `Start: \`${verification.startSha256}\``,
    `Verified events: ${verification.progressEventCount}`,
    "",
    ...[...latest].sort(([a], [b]) => a.localeCompare(b)).map(([key, complete]) => `- [${complete ? "x" : " "}] ${key}`),
    "",
    "This file is generated from the verified progress ledger. Manual checkbox edits have no authority.",
    "",
  ];
  return lines.join("\n");
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const verification = verifyImplementationStart({ root: args.root, gitRoot: args.gitRoot, packagePath: args.packagePath });
    const rendered = renderProgress(verification);
    if (args.write) writeFileSync(resolve(args.root, args.packagePath, "IMPLEMENTATION_PROGRESS.md"), rendered);
    process.stdout.write(rendered);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
