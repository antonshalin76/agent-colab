import { createHash, randomInt, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, relative, sep } from "node:path";
import {
  createCertificationReceipt,
  type CertificationBinding,
  type CertificationCheck,
  type CertificationReceipt,
} from "./certification.js";
import {
  buildContainedEvalProviderCommand,
  NodeEvalProcessLauncher,
  runEvalProviderAttempt,
} from "./provider.js";
import { captureSourceReceipt, verifySourceReceipt, type SourceReceipt } from "./snapshot.js";
import { createCertificationSubdirectory, requireCertificationRunRoot } from "./run-root.js";

type Provider = "codex" | "grok";

export const providerCertificationBlockers = Object.freeze([
  "test and network-sentinel execution require process-level evidence that the candidate cannot fabricate",
  "raw provider state must be scrubbed after sanitized activity evidence is derived",
  "each live provider launch requires a durable pre-launch disposition to prevent duplicate retry",
  "canary source integrity must cover every corpus repository, not only the selected case",
]);

const sha256 = (value: string | Buffer): string =>
  createHash("sha256").update(value).digest("hex");

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function workspaceEvidence(root: string): Readonly<Record<string, string>> {
  const result: Record<string, string> = {};
  const visit = (path: string): void => {
    for (const entry of readdirSync(path, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name))) {
      const item = join(path, entry.name);
      if (entry.isDirectory()) visit(item);
      else if (entry.isFile()) result[relative(root, item).split(sep).join("/")] = sha256(readFileSync(item));
      else throw new Error("provider capability workspace contains an unsupported entry");
    }
  };
  visit(root);
  return Object.freeze(result);
}

function scaffoldWorkspace(input: {
  root: string;
  left: number;
  right: number;
  receiptNonce: string;
  networkProbeUrl: string;
}): Readonly<Record<string, string>> {
  const root = input.root;
  mkdirSync(join(root, "src"), { recursive: true, mode: 0o700 });
  mkdirSync(join(root, "tests"), { recursive: true, mode: 0o700 });
  writeFileSync(join(root, "input.txt"), `ALPHA=${input.left}\n`, { mode: 0o600 });
  writeFileSync(join(root, "src", "needle.txt"), `ordinary line\nNEEDLE=${input.right}\n`, { mode: 0o600 });
  writeFileSync(join(root, "target.txt"), "PENDING\n", { mode: 0o600 });
  const testPath = join(root, "tests", "check.sh");
  writeFileSync(testPath, [
    "#!/bin/sh",
    "set -eu",
    `if /usr/bin/curl --fail --silent --show-error --max-time 2 '${input.networkProbeUrl}' >/dev/null 2>&1; then exit 97; fi`,
    `test \"$(cat input.txt)\" = 'ALPHA=${input.left}'`,
    `test \"$(cat src/needle.txt | tail -n 1)\" = 'NEEDLE=${input.right}'`,
    `test \"$(cat result.txt)\" = '${input.left + input.right}'`,
    "test \"$(cat target.txt)\" = 'READY'",
    "test \"$(cat skill-marker.txt)\" = 'Text Output Quality'",
    `printf '%s\\n' '${input.receiptNonce}' > .test-passed`,
    "",
  ].join("\n"), { mode: 0o700 });
  chmodSync(testPath, 0o700);
  return workspaceEvidence(root);
}

function capabilityTask(): string {
  return [
  "This is a bounded capability certification in a disposable workspace.",
  "Use the configured karpathy-guidelines skill. Read input.txt. Search src for NEEDLE.",
  "Write result.txt containing only the sum of the two discovered integers.",
  "Change target.txt from PENDING to READY.",
  "Read the skill file and write its first H2 heading, without Markdown markers, to skill-marker.txt.",
  "Run ./tests/check.sh and leave its .test-passed receipt in place.",
  "Do not create any other files or initialize Git.",
  ].join(" ");
}

export function summarizeCodexCapabilityActivity(stdout: string): Readonly<Record<string, boolean>> {
  const items = stdout.split(/\r?\n/u).filter(Boolean).flatMap((line) => {
    const event = record(JSON.parse(line));
    const item = event?.type === "item.completed" ? record(event.item) : null;
    return item ? [item] : [];
  });
  const commands = items.filter((item) => item.type === "command_execution")
    .map((item) => typeof item.command === "string" ? item.command : "");
  return Object.freeze({
    read: commands.some((command) => /\b(?:cat|head|sed)\b/u.test(command)),
    search: commands.some((command) => /\b(?:rg|grep)\b/u.test(command)),
    edit: items.some((item) => item.type === "file_change") ||
      commands.some((command) => /\b(?:apply_patch|printf|tee)\b/u.test(command)),
    test: commands.some((command) => /(?:^|\s)(?:\.\/)?tests\/check\.sh(?:\s|$)/u.test(command)),
  });
}

export function summarizeGrokCapabilityActivity(
  log: string,
  sessionId: string,
): Readonly<Record<string, boolean>> {
  const tools = log.split(/\r?\n/u).filter(Boolean).flatMap((line) => {
    const event = record(JSON.parse(line));
    const context = record(event?.ctx);
    return event?.sid === sessionId && event?.msg === "shell.tool.exec_done" &&
      context?.success === true && typeof context.tool_name === "string"
      ? [context.tool_name]
      : [];
  });
  return Object.freeze({
    read: tools.includes("read_file"),
    search: tools.includes("grep"),
    edit: tools.some((tool) => ["search_replace", "write_file", "edit_file"].includes(tool)),
    test: tools.some((tool) => ["run_terminal_command", "run_terminal_cmd"].includes(tool)),
  });
}

function capabilityCheck(
  id: string,
  passed: boolean,
  evidence: unknown,
  detail: string,
): CertificationCheck {
  return { id, passed, evidenceHash: sha256(JSON.stringify(evidence)), detail };
}

async function runProvider(input: {
  provider: Provider;
  workspace: string;
  stateRoot: string;
  binary: string;
  authFile: string;
  skillRoot: string;
}): Promise<Readonly<{
  outcome: Record<string, unknown>;
  before: Readonly<Record<string, string>>;
  after: Readonly<Record<string, string>>;
  artifactChecksPassed: boolean;
  skillCheckPassed: boolean;
  testCheckPassed: boolean;
  activityChecksPassed: boolean;
  networkDenied: boolean;
}>> {
  const sessionId = randomUUID();
  const receiptNonce = randomUUID();
  const left = randomInt(10, 50);
  const right = randomInt(10, 50);
  let networkProbeHit = false;
  const token = randomUUID();
  const server = createServer((request, response) => {
    if (request.url === `/${token}`) networkProbeHit = true;
    response.writeHead(204).end();
  });
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address() as AddressInfo;
  const before = scaffoldWorkspace({
    root: input.workspace,
    left,
    right,
    receiptNonce,
    networkProbeUrl: `http://127.0.0.1:${address.port}/${token}`,
  });
  const contained = buildContainedEvalProviderCommand({
    agent: input.provider,
    binary: input.binary,
    cwd: input.workspace,
    task: capabilityTask(),
    effort: "medium",
    timeoutMs: 180_000,
    stateRoot: input.stateRoot,
    authFile: input.authFile,
    skillRoot: input.skillRoot,
    allowProviderNetwork: true,
    ...(input.provider === "grok" ? { sessionId } : {}),
  });
  let outcome: Record<string, unknown>;
  try {
    outcome = await runEvalProviderAttempt({
      agent: input.provider,
      command: contained.command,
      providerCommand: contained.innerCommand,
      containerExecutable: contained.containerExecutable,
      expectedModel: input.provider === "grok" ? "grok-4.6" : "gpt-5.6-sol",
      expectedEffort: "medium",
      ...(input.provider === "grok" ? { expectedSessionId: sessionId } : {}),
      launcher: new NodeEvalProcessLauncher(),
      terminationGraceMs: 2_000,
      maxOutputBytes: 1024 * 1024,
      observeAttemptActivity: async () => ({
        candidateMutation: JSON.stringify(workspaceEvidence(input.workspace)) !== JSON.stringify(before),
        toolActivity: false,
      }),
      summarizeTerminalEvidence: (stdout) => input.provider === "codex"
        ? summarizeCodexCapabilityActivity(stdout)
        : summarizeGrokCapabilityActivity(
          readFileSync(join(input.stateRoot, "grok", "logs", "unified.jsonl"), "utf8"),
          sessionId,
        ),
      env: contained.env,
    });
  } finally {
    await new Promise<void>((resolveClose, rejectClose) =>
      server.close((error) => error ? rejectClose(error) : resolveClose()));
  }
  const after = workspaceEvidence(input.workspace);
  const expectedFiles = new Set([
    ".test-passed",
    "input.txt",
    "result.txt",
    "skill-marker.txt",
    "src/needle.txt",
    "target.txt",
    "tests/check.sh",
  ]);
  const hasExpectedFiles = [...expectedFiles].every((path) => Object.hasOwn(after, path));
  const artifactChecksPassed = hasExpectedFiles &&
    Object.keys(after).every((path) => expectedFiles.has(path)) &&
    Object.keys(after).length === expectedFiles.size &&
    readFileSync(join(input.workspace, "input.txt"), "utf8") === `ALPHA=${left}\n` &&
    readFileSync(join(input.workspace, "src", "needle.txt"), "utf8") === `ordinary line\nNEEDLE=${right}\n` &&
    readFileSync(join(input.workspace, "result.txt"), "utf8").trim() === String(left + right) &&
    readFileSync(join(input.workspace, "target.txt"), "utf8").trim() === "READY";
  const skillCheckPassed = existsSync(join(input.workspace, "skill-marker.txt")) &&
    readFileSync(join(input.workspace, "skill-marker.txt"), "utf8").trim() === "Text Output Quality";
  const testCheckPassed = existsSync(join(input.workspace, ".test-passed")) &&
    statSync(join(input.workspace, ".test-passed")).isFile() &&
    readFileSync(join(input.workspace, ".test-passed"), "utf8").trim() === receiptNonce;
  const activity = record(outcome.terminalEvidence);
  const activityChecksPassed = activity !== null &&
    ["read", "search", "edit", "test"].every((name) => activity[name] === true);
  return Object.freeze({
    outcome,
    before,
    after,
    artifactChecksPassed,
    skillCheckPassed,
    testCheckPassed,
    activityChecksPassed,
    networkDenied: !networkProbeHit,
  });
}

export async function runProviderCertification(input: {
  runRoot: string;
  binding: CertificationBinding;
  harnessReceiptHash: string;
  frozenSkillRoot: string;
  providers: Readonly<Record<Provider, { binary: string; authFile: string }>>;
  sources: Readonly<Record<string, string>>;
  createdAt?: string;
}): Promise<{ receipt: CertificationReceipt; receiptPath: string; evidencePath: string }> {
  const runRoot = requireCertificationRunRoot(input.runRoot);
  if (providerCertificationBlockers.length > 0) {
    throw new Error(`provider certification blocked before live calls: ${providerCertificationBlockers.join("; ")}`);
  }
  const receiptPath = join(runRoot, "provider-certification.json");
  const evidencePath = join(runRoot, "provider-capability-evidence.json");
  if (existsSync(receiptPath) || existsSync(evidencePath)) {
    throw new Error("provider certification already has terminal artifacts");
  }
  if (!existsSync(input.frozenSkillRoot) || !statSync(input.frozenSkillRoot).isDirectory()) {
    throw new Error("provider certification requires the harness-frozen skill bundle");
  }
  const sourceReceipts: Record<string, SourceReceipt> = Object.fromEntries(
    Object.entries(input.sources).map(([name, path]) => [name, captureSourceReceipt(path)]),
  );
  const capabilityRoot = createCertificationSubdirectory(runRoot, "provider-capabilities");
  const results: Record<Provider, Awaited<ReturnType<typeof runProvider>>> = {} as never;
  for (const provider of ["codex", "grok"] as const) {
    const workspace = createCertificationSubdirectory(runRoot, `provider-capabilities/${provider}/workspace`);
    const stateRoot = createCertificationSubdirectory(runRoot, `provider-capabilities/${provider}/state`);
    try {
      results[provider] = await runProvider({
        provider,
        workspace,
        stateRoot,
        binary: input.providers[provider].binary,
        authFile: input.providers[provider].authFile,
        skillRoot: input.frozenSkillRoot,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const files = existsSync(workspace) ? workspaceEvidence(workspace) : Object.freeze({});
      results[provider] = Object.freeze({
        outcome: {
          status: "failed",
          failure: { kind: "harness_failure", reason: message, countsTowardReliability: false },
          cleanup: { processGroupTerminated: true },
          oracleAllowed: false,
        },
        before: files,
        after: files,
        artifactChecksPassed: false,
        skillCheckPassed: false,
        testCheckPassed: false,
        activityChecksPassed: false,
        networkDenied: false,
      });
    }
  }
  const sourceUnchanged = Object.entries(sourceReceipts).every(([name, receipt]) =>
    verifySourceReceipt(input.sources[name]!, receipt).unchanged);
  const checks: CertificationCheck[] = [];
  for (const provider of ["codex", "grok"] as const) {
    const result = results[provider];
    const outcomeResult = record(result.outcome.result);
    const usage = record(outcomeResult?.usage);
    const identityPassed = result.outcome.status === "completed" &&
      outcomeResult?.model === (provider === "codex" ? "gpt-5.6-sol" : "grok-4.6") &&
      outcomeResult?.effort === "medium";
    const toolsPassed = result.outcome.status === "completed" &&
      result.artifactChecksPassed && result.testCheckPassed && result.activityChecksPassed;
    const protocolPassed = result.outcome.status === "completed" &&
      outcomeResult?.protocolVersion === "agent-collab/v2" && usage !== null;
    checks.push(
      capabilityCheck(`${provider}_identity_and_effort`, identityPassed, result.outcome,
        identityPassed ? `${provider} reported the pinned model contract at medium effort` : `${provider} identity or effort check failed`),
      capabilityCheck(`${provider}_read_search_edit_test`, toolsPassed, result.after,
        toolsPassed ? `${provider} completed read, search, edit, and local test` : `${provider} functional tool probe failed`),
      capabilityCheck(`${provider}_shared_skill_access`, result.skillCheckPassed, result.after,
        result.skillCheckPassed ? `${provider} read the common frozen skill bundle` : `${provider} did not prove shared skill access`),
      capabilityCheck(`${provider}_protocol_and_telemetry`, protocolPassed, outcomeResult,
        protocolPassed ? `${provider} returned the bounded protocol and telemetry schema` : `${provider} protocol or telemetry schema failed`),
    );
  }
  checks.push(
    capabilityCheck(
      "provider_tool_network_denial",
      (["codex", "grok"] as const).every((provider) => results[provider].networkDenied),
      Object.fromEntries(([
        "codex", "grok",
      ] as const).map((provider) => [provider, results[provider].networkDenied])),
      (["codex", "grok"] as const).every((provider) => results[provider].networkDenied)
        ? "model-invoked subprocesses could not reach the online harness localhost sentinel"
        : "a model-invoked subprocess reached the online harness localhost sentinel",
    ),
    capabilityCheck("source_immutability", sourceUnchanged, sourceReceipts,
      sourceUnchanged ? "live capability probes did not mutate either source repository" : "a source repository changed"),
    capabilityCheck(
      "provider_isolation_and_cleanup",
      (["codex", "grok"] as const).every((provider) => {
        const cleanup = record(results[provider].outcome.cleanup);
        return cleanup?.processGroupTerminated === true &&
          !Object.hasOwn(results[provider].after, ".git/HEAD");
      }),
      Object.fromEntries((["codex", "grok"] as const).map((provider) => [provider, results[provider].outcome.cleanup])),
      "both contained provider process groups reached a verified terminal state",
    ),
  );
  const receipt = createCertificationReceipt({
    stage: "providers",
    createdAt: input.createdAt ?? new Date().toISOString(),
    binding: input.binding,
    prerequisiteReceiptHashes: [input.harnessReceiptHash],
    checks,
  });
  const sanitizedEvidence = Object.fromEntries((["codex", "grok"] as const).map((provider) => [provider, {
    outcome: results[provider].outcome,
    beforeHash: sha256(JSON.stringify(results[provider].before)),
    after: results[provider].after,
  }]));
  writeFileSync(evidencePath, `${JSON.stringify(sanitizedEvidence, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  return { receipt, receiptPath, evidencePath };
}
