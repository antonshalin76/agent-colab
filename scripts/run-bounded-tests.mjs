#!/usr/bin/env node

import { spawn } from "node:child_process";
import { readdirSync, realpathSync, readFileSync, statSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SUMMARY_SCHEMA = "bounded-test-summary/v1";
const MANIFEST_SCHEMA = "bounded-test-manifest/v2";
const DEFAULT_TIMEOUT_MS = 120_000;
const MIGRATION_TIMEOUT_MS = 180_000;
const EXHAUSTIVE_TIMEOUT_MS = 300_000;
const TERMINATION_GRACE_MS = 10_000;
const FAILURE_TAIL_BYTES = 2_000;
const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = realpathSync(resolve(scriptDirectory, ".."));
const defaultManifest = resolve(scriptDirectory, "production-flow-gate.manifest.json");
const vitestEntry = resolve(repositoryRoot, "node_modules/vitest/vitest.mjs");

const usage = `Usage:
  node scripts/run-bounded-tests.mjs
  node scripts/run-bounded-tests.mjs --manifest <path>
  node scripts/run-bounded-tests.mjs --file <tests/file.test.ts> [--file ...]
`;

function parseArguments(argv) {
  let manifestPath = defaultManifest;
  let manifestSpecified = false;
  const files = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") return { help: true };
    if (argument === "--manifest") {
      const value = argv[index + 1];
      if (!value) throw new Error("--manifest requires a path");
      manifestPath = resolve(process.cwd(), value);
      manifestSpecified = true;
      index += 1;
      continue;
    }
    if (argument === "--file") {
      const value = argv[index + 1];
      if (!value) throw new Error("--file requires a test path");
      files.push(value);
      index += 1;
      continue;
    }
    throw new Error(`unknown argument: ${argument}`);
  }
  if (files.length > 0 && manifestSpecified) {
    throw new Error("--file and --manifest cannot be combined");
  }
  return files.length > 0
    ? { gate: "ad-hoc-bounded-tests", files }
    : { manifestPath };
}

function validateTestFile(file) {
  if (typeof file !== "string" || file.length === 0) {
    throw new Error("test paths must be non-empty strings");
  }
  const absolute = resolve(repositoryRoot, file);
  const canonical = realpathSync(absolute);
  const withinRepository = relative(repositoryRoot, canonical);
  if (withinRepository.startsWith("..") || resolve(repositoryRoot, withinRepository) !== canonical) {
    throw new Error(`test path escapes the repository: ${file}`);
  }
  if (canonical !== absolute || !statSync(canonical).isFile()) {
    throw new Error(`test path must be a canonical regular file: ${file}`);
  }
  const normalized = relative(repositoryRoot, canonical).split("\\").join("/");
  if (!normalized.startsWith("tests/") || !normalized.endsWith(".test.ts")) {
    throw new Error(`unsupported test path: ${file}`);
  }
  return normalized;
}

function isMigrationTest(file) {
  return /(^|[./-])migration([./-]|$)/i.test(file) ||
    file === "tests/stg04-production-close.test.ts" ||
    file === "tests/operational-restore.test.ts" ||
    file === "tests/schema-compatibility.test.ts";
}

function isExhaustiveTest(file) {
  return file === "tests/implementation-progress-v4.test.ts";
}

function inventoryTestFiles(directory = resolve(repositoryRoot, "tests"), prefix = "tests") {
  const files = [];
  const entries = readdirSync(directory, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const path = resolve(directory, entry.name);
    const relativePath = `${prefix}/${entry.name}`;
    if (entry.isDirectory()) files.push(...inventoryTestFiles(path, relativePath));
    else if (entry.isFile() && relativePath.endsWith(".test.ts")) files.push(relativePath);
  }
  return files;
}

function isEvalTest(file) {
  return /^tests\/eval-[^/]*\.test\.ts$/.test(file);
}

function assertManifestCompleteness(files) {
  const excludedEvalTests = files.filter(isEvalTest);
  if (excludedEvalTests.length > 0) {
    throw new Error(`production manifest must exclude eval tests: ${excludedEvalTests.join(", ")}`);
  }
  const productionInventory = inventoryTestFiles().filter((file) => !isEvalTest(file));
  const selected = new Set(files);
  const inventory = new Set(productionInventory);
  const missing = productionInventory.filter((file) => !selected.has(file));
  const extra = files.filter((file) => !inventory.has(file));
  if (missing.length > 0 || extra.length > 0) {
    throw new Error([
      "bounded test manifest does not exactly cover the production test inventory",
      ...(missing.length > 0 ? [`missing: ${missing.join(", ")}`] : []),
      ...(extra.length > 0 ? [`extra: ${extra.join(", ")}`] : []),
    ].join("; "));
  }
}

function loadManifest(path) {
  const parsed = JSON.parse(readFileSync(path, "utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) ||
      parsed.schemaVersion !== MANIFEST_SCHEMA || typeof parsed.name !== "string" ||
      parsed.name.length === 0 || parsed.defaultTimeoutMs !== DEFAULT_TIMEOUT_MS ||
      parsed.migrationTimeoutMs !== MIGRATION_TIMEOUT_MS ||
      parsed.exhaustiveTimeoutMs !== EXHAUSTIVE_TIMEOUT_MS || !Array.isArray(parsed.tests) ||
      !Array.isArray(parsed.migrationTests) || !Array.isArray(parsed.exhaustiveTests)) {
    throw new Error("bounded test manifest has an invalid schema or timeout policy");
  }
  const ordinary = parsed.tests.map(validateTestFile);
  const migrations = parsed.migrationTests.map(validateTestFile);
  const exhaustive = parsed.exhaustiveTests.map(validateTestFile);
  const all = [...ordinary, ...migrations, ...exhaustive];
  if (all.length === 0) throw new Error("bounded test manifest must contain at least one file");
  if (new Set(all).size !== all.length) throw new Error("bounded test manifest contains duplicate files");
  assertManifestCompleteness(all);
  for (const file of ordinary) {
    if (isMigrationTest(file) || isExhaustiveTest(file)) {
      throw new Error(`test must use its bounded long-running group: ${file}`);
    }
  }
  for (const file of migrations) {
    if (isExhaustiveTest(file)) throw new Error(`exhaustive test must use the 300s group: ${file}`);
  }
  return {
    gate: parsed.name,
    tests: [
      ...ordinary.map((file) => ({ file, timeoutMs: DEFAULT_TIMEOUT_MS })),
      ...migrations.map((file) => ({ file, timeoutMs: MIGRATION_TIMEOUT_MS })),
      ...exhaustive.map((file) => ({ file, timeoutMs: EXHAUSTIVE_TIMEOUT_MS })),
    ],
  };
}

function signalProcessGroup(child, signal) {
  if (child.pid === undefined) return false;
  try {
    if (process.platform === "win32") return child.kill(signal);
    process.kill(-child.pid, signal);
    return true;
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ESRCH") return false;
    throw error;
  }
}

function runTest({ file, timeoutMs }) {
  return new Promise((resolveResult) => {
    const startedAt = Date.now();
    let outputBytes = 0;
    let outputTail = Buffer.alloc(0);
    let timedOut = false;
    let settled = false;
    let graceTimer;
    const child = spawn(process.execPath, [
      vitestEntry,
      "run",
      file,
      "--maxWorkers=1",
      "--no-file-parallelism",
      "--reporter=dot",
    ], {
      cwd: repositoryRoot,
      detached: process.platform !== "win32",
      env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });

    const accountOutput = (chunk) => {
      outputBytes += chunk.length;
      outputTail = Buffer.concat([outputTail, chunk]).subarray(-FAILURE_TAIL_BYTES);
    };
    child.stdout.on("data", accountOutput);
    child.stderr.on("data", accountOutput);

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      clearTimeout(graceTimer);
      const failureTail = result.status === "passed" ? undefined : outputTail.toString("utf8")
        .replace(/\u001b\[[0-9;]*m/g, "")
        .trim();
      resolveResult({
        file,
        timeoutMs,
        durationMs: Date.now() - startedAt,
        outputBytes,
        ...(failureTail ? { failureTail } : {}),
        ...result,
      });
    };

    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      let termSent = false;
      try { termSent = signalProcessGroup(child, "SIGTERM"); }
      catch { /* SIGKILL below is the bounded fallback. */ }
      graceTimer = setTimeout(() => {
        let killSent = false;
        try { killSent = signalProcessGroup(child, "SIGKILL"); }
        catch { /* The timeout result remains authoritative. */ }
        child.stdout.destroy();
        child.stderr.destroy();
        child.unref();
        finish({ status: "timeout", exitCode: null, signal: null, termSent, killSent });
      }, TERMINATION_GRACE_MS);
    }, timeoutMs);

    child.once("error", () => {
      finish({ status: timedOut ? "timeout" : "failed", exitCode: null, signal: null });
    });
    child.once("close", (exitCode, signal) => {
      finish({
        status: timedOut ? "timeout" : exitCode === 0 ? "passed" : "failed",
        exitCode,
        signal,
      });
    });
  });
}

async function main() {
  const arguments_ = parseArguments(process.argv.slice(2));
  if (arguments_.help) {
    process.stdout.write(usage);
    return;
  }
  statSync(vitestEntry);
  const gate = "files" in arguments_
    ? {
        gate: arguments_.gate,
        tests: arguments_.files.map(validateTestFile).map((file) => ({
          file,
          timeoutMs: isExhaustiveTest(file) ? EXHAUSTIVE_TIMEOUT_MS
            : isMigrationTest(file) ? MIGRATION_TIMEOUT_MS : DEFAULT_TIMEOUT_MS,
        })),
      }
    : loadManifest(arguments_.manifestPath);
  if (new Set(gate.tests.map(({ file }) => file)).size !== gate.tests.length) {
    throw new Error("bounded test selection contains duplicate files");
  }

  const startedAt = Date.now();
  const results = [];
  for (const test of gate.tests) results.push(await runTest(test));
  const totals = {
    files: results.length,
    passed: results.filter(({ status }) => status === "passed").length,
    failed: results.filter(({ status }) => status === "failed").length,
    timedOut: results.filter(({ status }) => status === "timeout").length,
  };
  const status = totals.failed === 0 && totals.timedOut === 0 ? "passed" : "failed";
  process.stdout.write(`${JSON.stringify({
    schemaVersion: SUMMARY_SCHEMA,
    gate: gate.gate,
    status,
    durationMs: Date.now() - startedAt,
    totals,
    results,
  })}\n`);
  if (status !== "passed") process.exitCode = 1;
}

try {
  await main();
} catch (error) {
  process.stdout.write(`${JSON.stringify({
    schemaVersion: SUMMARY_SCHEMA,
    gate: "configuration",
    status: "configuration_error",
    error: error instanceof Error ? error.message : String(error),
  })}\n`);
  process.exitCode = 2;
}
