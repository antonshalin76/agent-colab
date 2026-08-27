import { spawnSync } from "node:child_process";
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const mutations = {
  "review-semantic-pass": {
    file: "src/runtime/review-barrier-store.ts",
    replacements: [{
      before: "isSemanticPass(lane) && this.hasExactRunnerEvidence(review, laneSnapshot(",
      after: "true && this.hasExactRunnerEvidence(review, laneSnapshot(",
    }],
    tests: ["tests/runtime-review-barrier.test.ts"],
    expectedFailure: "keeps exact launched runner evidence blocked when its semantic verdict requests changes",
  },
  "learning-control-fingerprint": {
    file: "src/flow/evidence-ledger.ts",
    replacements: [{
      before: "row.control_fingerprint !== currentControlFingerprint ||",
      after: "false ||",
    }, {
      before: "row?.old_control_fingerprint === currentControlFingerprint &&",
      after: "true &&",
    }],
    tests: ["tests/evidence-ledger.test.ts"],
    expectedFailure: "derives a non-review oracle and owns current executions plus a linked failing old-code mutation",
  },
};

const mutationId = process.argv[2];
const mutation = mutations[mutationId];
if (!mutation) {
  process.stderr.write(`unknown old-code mutation: ${String(mutationId)}\n`);
  process.exit(2);
}

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const temporaryRoot = mkdtempSync(join(tmpdir(), "agent-collab-old-code-"));
const mutatedRoot = join(temporaryRoot, "project");

try {
  cpSync(sourceRoot, mutatedRoot, {
    recursive: true,
    filter(source) {
      const path = relative(sourceRoot, source);
      if (path === "") return true;
      const first = path.split(sep)[0];
      return first !== ".git" && first !== "node_modules" && first !== "dist" &&
        path !== ".map/agent-collab-admin" && !path.startsWith(`.map/agent-collab-admin${sep}`);
    },
  });
  symlinkSync(join(sourceRoot, "node_modules"), join(mutatedRoot, "node_modules"), "dir");

  const target = join(mutatedRoot, mutation.file);
  let mutated = readFileSync(target, "utf8");
  for (const replacement of mutation.replacements) {
    if (mutated.split(replacement.before).length !== 2) {
      process.stderr.write(`old-code mutation anchor is not unique: ${mutationId}\n`);
      process.exit(2);
    }
    mutated = mutated.replace(replacement.before, replacement.after);
  }
  writeFileSync(target, mutated);

  const result = spawnSync(process.execPath, [
    join(mutatedRoot, "node_modules/vitest/vitest.mjs"),
    "run",
    ...mutation.tests,
    "--maxWorkers=1",
    "--no-file-parallelism",
    "--reporter=dot",
  ], {
    cwd: mutatedRoot,
    encoding: "utf8",
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error || result.status === null) {
    process.stderr.write(`old-code mutation probe failed to execute: ${String(result.error ?? result.signal)}\n`);
    process.exit(2);
  }
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  if (result.status === 0) process.exit(0);
  const output = `${result.stdout}\n${result.stderr}`;
  if (result.status === 1 && output.includes(mutation.expectedFailure) &&
      /Tests\s+1 failed/.test(output)) {
    process.exit(42);
  }
  process.stderr.write("old-code mutation probe failed for an unexpected reason\n");
  process.exit(2);
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}
