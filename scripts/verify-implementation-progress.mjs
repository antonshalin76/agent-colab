#!/usr/bin/env node
import "tsx/esm";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const verifier = await import("../src/flow/implementation-progress-package-verifier.ts");

export const verifyImplementationStart = verifier.verifyImplementationStart;
export const verifyImplementationProgressPackage = verifier.verifyImplementationProgressPackage;

const parseArgs = (argv) => {
  const result = {
    root: process.cwd(),
    gitRoot: undefined,
    packagePath: "docs/hybrid-flow-v1",
    migrationSeedPath: undefined,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--root") result.root = resolve(argv[++index]);
    else if (flag === "--git-root") result.gitRoot = resolve(argv[++index]);
    else if (flag === "--package") result.packagePath = argv[++index];
    else if (flag === "--migration-seed") result.migrationSeedPath = argv[++index];
    else throw new Error(`unknown argument: ${flag}`);
  }
  result.gitRoot ??= result.root;
  return result;
};

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    const result = verifyImplementationStart(parseArgs(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
