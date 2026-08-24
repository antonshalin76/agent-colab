import { createHash } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  cpSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { basename, dirname, join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import {
  createV1RuntimeManifest,
  preflightV1Runtime,
  runtimeSnapshotDigest,
  v1RuntimeTreeDigest,
  verifyV1RuntimeSnapshot,
} from "../src/migration/v1-runtime.js";

const MANIFEST = "manifest.json";
const DISPATCHER = "/home/anton/.local/bin/agent-collab-dispatcher";
const GOLDEN_V1_SYSTEMD_UNIT = [
  "[Unit]",
  "Description=Claude Code and Codex collaboration worker",
  "After=default.target",
  "",
  "[Service]",
  "Type=simple",
  "WorkingDirectory=/home/anton/.local/share/agent-collab/current",
  `ExecStart=${DISPATCHER} worker`,
  "Restart=on-failure",
  "RestartSec=3",
  "UMask=0077",
  "NoNewPrivileges=true",
  "PrivateTmp=true",
  "Environment=AGENT_COLLAB_STATE_DIR=/home/anton/.local/share/agent-collab",
  "Environment=AGENT_COLLAB_CLAUDE_BIN=/home/anton/.local/bin/claude",
  "Environment=AGENT_COLLAB_CODEX_BIN=/home/anton/.local/bin/codex",
  "Environment=PATH=/home/anton/.nvm/versions/node/v24.14.1/bin:/home/anton/.local/bin:/usr/local/bin:/usr/bin:/bin",
  "",
  "[Install]",
  "WantedBy=default.target",
  "",
].join("\n");
const SKILL_PATH = "skills/files/agent-collaboration/SKILL.md";
const REQUIRED_FILES = [
  "dist/cli.js",
  "mcp/registrations.json",
  "node_modules/fixture-runtime-dependency/index.js",
  "node_modules/fixture-runtime-dependency/package.json",
  "package-lock.json",
  "package.json",
  "proof/gate-receipt.json",
  "runtime/node.json",
  SKILL_PATH,
  "skills/manifest.json",
  "systemd/agent-collab.service",
] as const;
const roots: string[] = [];
const baseProof = {
  source: "append-only-rollout-reconstruction",
  sourceDigest: "a".repeat(64),
  gate: { command: "npm test && npm run typecheck && npm run build", exitCode: 0 },
} as const;

const sha256 = (bytes: string | Buffer): string =>
  createHash("sha256").update(bytes).digest("hex");
const nodeRealpath = realpathSync(process.execPath);
const nodeSha256 = sha256(readFileSync(nodeRealpath));

function write(path: string, content: string, mode = 0o600): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, content, { mode });
  chmodSync(path, mode);
}

function outsideFile(content = "outside", mode = 0o600): string {
  const root = mkdtempSync(join(tmpdir(), "agent-collab-v1-outside-"));
  roots.push(root);
  const path = join(root, "file");
  write(path, content, mode);
  return path;
}

function proofFor(root: string) {
  const receiptBytes = readFileSync(join(root, "proof/gate-receipt.json"));
  const receipt = JSON.parse(receiptBytes.toString("utf8")) as { runtimeTreeDigest: string };
  return { ...baseProof, runtimeTreeDigest: receipt.runtimeTreeDigest, gateReceiptSha256: sha256(receiptBytes) };
}

function attest(root: string, metadata: { source: string; sourceDigest: string;
  gate: { command: string; exitCode: number } } = baseProof) {
  const runtimeTreeDigest = v1RuntimeTreeDigest(root);
  write(join(root, "proof/gate-receipt.json"), `${JSON.stringify({
    format: "agent-collab-v1-gate-receipt/v1",
    ...metadata,
    runtimeTreeDigest,
  }, null, 2)}\n`);
  return proofFor(root);
}

type CliBehavior = "descendant" | "ok" | "malformed" | "network" | "nonzero" | "timeout";

function fixtureCli(protocol = "agent-collab/v1", behavior: CliBehavior = "ok"): string {
  return `#!/usr/bin/env node
import { appendFileSync, existsSync } from "node:fs";
import { realpathSync, statfsSync, statSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { runtimeDependency } from "fixture-runtime-dependency";
const command = process.argv[2] ?? "status";
const log = process.env.V1_FIXTURE_LOG;
const record = (value) => { if (log) appendFileSync(log, JSON.stringify(value) + "\\n"); };
if (command !== "status") {
  record({ kind: "provider_invocation", command });
  process.exit(91);
}
const stateRoot = process.env.AGENT_COLLAB_STATE_DIR;
if (!stateRoot || !existsSync(join(stateRoot, "collaboration.db")) ||
    !existsSync(join(stateRoot, "history.db"))) process.exit(92);
const inspect = (path, sql) => {
  const db = new DatabaseSync(path, { readOnly: true });
  const userVersion = db.prepare("PRAGMA user_version").get().user_version;
  const row = db.prepare(sql).get();
  db.close();
  const stat = statSync(path);
  return { realpath: realpathSync(path), dev: stat.dev, ino: stat.ino, userVersion, row };
};
record({ kind: "runtime", command, pid: process.pid, cwd: process.cwd(), stateRoot, runtimeDependency,
  environment: { inheritedSentinel: process.env.V1_INHERITED_SENTINEL ?? null, home: process.env.HOME }, databases: {
  state: inspect(join(stateRoot, "collaboration.db"),
    "SELECT agent, health FROM runtime_provider_health ORDER BY agent LIMIT 1"),
  history: inspect(join(stateRoot, "history.db"),
    "SELECT project, source_path AS sourcePath FROM sources ORDER BY project LIMIT 1"),
} });
const sealProbe = process.env.V1_SEAL_PROBE_LOG;
if (sealProbe) {
  let writeError = null;
  try { appendFileSync(new URL(import.meta.url), "// seal probe\\n"); }
  catch (error) { writeError = error?.code ?? String(error); }
  appendFileSync(sealProbe, JSON.stringify({
    readOnly: writeError === "EROFS",
    tmpfs: Number(statfsSync(process.cwd()).type) === 0x01021994,
  }) + "\\n");
}
if ("${behavior}" === "network") {
  let connected = false;
  try { await fetch(process.env.V1_NETWORK_URL ?? ""); connected = true; } catch {}
  record({ kind: "network", connected });
  if (connected) process.exit(95);
}
if ("${behavior}" === "descendant") {
  const descendant = spawn(process.execPath, ["-e",
    "setTimeout(() => require('node:fs').appendFileSync(process.env.V1_LATE_SIDE_EFFECT, 'escaped\\n'), 250)"],
    { detached: true, stdio: "ignore", env: process.env });
  descendant.unref();
}
if ("${behavior}" === "nonzero") process.exit(86);
if ("${behavior}" === "malformed") { console.log("not-json"); process.exit(0); }
if ("${behavior}" === "timeout") {
  setTimeout(() => appendFileSync(process.env.V1_LATE_SIDE_EFFECT, "late\\n"), 250);
  await new Promise((resolve) => setTimeout(resolve, 2_000));
}
console.log(JSON.stringify({ protocol: "${protocol}", providers: {
  claude: "unavailable", codex: "healthy" } }));
`;
}

function makeSnapshot(protocol = "agent-collab/v1", behavior: CliBehavior = "ok"): string {
  const root = mkdtempSync(join(tmpdir(), "agent-collab-v1-runtime-"));
  roots.push(root);
  const dependency = { "fixture-runtime-dependency": "1.0.0" };
  const skillBytes = "# Agent Collaboration v1\n\nPinned rollback skill bytes.\n";
  write(join(root, "package.json"), `${JSON.stringify({
    name: "agent-collab-v1-fixture",
    version: "1.0.0",
    private: true,
    type: "module",
    dependencies: dependency,
    engines: { node: ">=24" },
  }, null, 2)}\n`);
  write(join(root, "package-lock.json"), `${JSON.stringify({
    name: "agent-collab-v1-fixture",
    version: "1.0.0",
    lockfileVersion: 3,
    requires: true,
    packages: {
      "": { name: "agent-collab-v1-fixture", version: "1.0.0", dependencies: dependency },
      "node_modules/fixture-runtime-dependency": { version: "1.0.0" },
    },
  }, null, 2)}\n`);
  write(join(root, "node_modules/fixture-runtime-dependency/package.json"), `${JSON.stringify({
    name: "fixture-runtime-dependency", version: "1.0.0", type: "module", main: "index.js",
  }, null, 2)}\n`);
  write(join(root, "node_modules/fixture-runtime-dependency/index.js"),
    "export const runtimeDependency = 'closed';\n");
  write(join(root, "dist/cli.js"), fixtureCli(protocol, behavior), 0o700);
  write(join(root, "systemd/agent-collab.service"), GOLDEN_V1_SYSTEMD_UNIT);
  write(join(root, "mcp/registrations.json"), `${JSON.stringify({
    format: "agent-collab-mcp-receipts/v1",
    registrations: [
      { agent: "codex", transport: "stdio", command: DISPATCHER, args: ["mcp"] },
      { agent: "grok", transport: "stdio", command: DISPATCHER, args: ["mcp"] },
    ],
  }, null, 2)}\n`);
  write(join(root, "runtime/node.json"), `${JSON.stringify({
    format: "agent-collab-node-runtime/v1",
    identity: "node",
    binaryRealpath: nodeRealpath,
    version: process.version,
    sha256: nodeSha256,
    nativeAbi: process.versions.modules,
  }, null, 2)}\n`);
  write(join(root, SKILL_PATH), skillBytes);
  write(join(root, "skills/manifest.json"), `${JSON.stringify({
    format: "agent-collab-skills/v1",
    root: "/home/anton/.agents/skills",
    files: [{ path: "agent-collaboration/SKILL.md", sha256: sha256(skillBytes) }],
  }, null, 2)}\n`);
  attest(root);
  return root;
}

function createSnapshot(protocol = "agent-collab/v1", behavior: CliBehavior = "ok"): string {
  const root = makeSnapshot(protocol, behavior);
  createV1RuntimeManifest({ snapshotDirectory: root, proof: proofFor(root) });
  return root;
}

function makeDatabases(): {
  root: string; state: string; history: string; log: string; providerLog: string;
  lateEffect: string; poisonBinary: string; sealProbe: string;
} {
  const root = mkdtempSync(join(tmpdir(), "agent-collab-v1-state-"));
  roots.push(root);
  const state = join(root, "collaboration.db");
  const history = join(root, "history.db");
  const log = join(root, "preflight.jsonl");
  const providerLog = join(root, "provider.jsonl");
  const lateEffect = join(root, "late-side-effect");
  const sealProbe = join(root, "seal-probe.jsonl");
  const poisonBinary = join(root, "provider-poison");
  const stateDb = new Database(state);
  stateDb.pragma("user_version = 1");
  stateDb.exec("CREATE TABLE runtime_provider_health (agent TEXT PRIMARY KEY, health TEXT NOT NULL)");
  stateDb.prepare("INSERT INTO runtime_provider_health VALUES (?, ?)").run("codex", "healthy");
  stateDb.close();
  const historyDb = new Database(history);
  historyDb.pragma("user_version = 1");
  historyDb.exec("CREATE TABLE sources (project TEXT NOT NULL, source_path TEXT NOT NULL)");
  historyDb.prepare("INSERT INTO sources VALUES (?, ?)").run("/fixture", "/fixture/history.jsonl");
  historyDb.close();
  write(poisonBinary, `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
appendFileSync(process.env.V1_PROVIDER_LOG, JSON.stringify({ argv: process.argv.slice(2) }) + "\\n");
process.exit(93);
`, 0o700);
  return { root, state, history, log, providerLog, lateEffect, poisonBinary, sealProbe };
}

const preflightInput = (snapshot: string, databases: ReturnType<typeof makeDatabases>) => ({
  snapshotDirectory: snapshot,
  expectedRuntimeDigest: runtimeSnapshotDigest(snapshot),
  expectedGateReceiptSha256: proofFor(snapshot).gateReceiptSha256,
  expectedSourceDigest: proofFor(snapshot).sourceDigest,
  stateDatabase: databases.state,
  historyDatabase: databases.history,
  nodeBinary: process.execPath,
  timeoutMs: 1_000,
  env: {
    V1_FIXTURE_LOG: databases.log,
    V1_PROVIDER_LOG: databases.providerLog,
    V1_LATE_SIDE_EFFECT: databases.lateEffect,
    AGENT_COLLAB_CLAUDE_BIN: databases.poisonBinary,
    AGENT_COLLAB_CODEX_BIN: databases.poisonBinary,
    AGENT_COLLAB_GROK_BIN: databases.poisonBinary,
  },
});

function logicalDatabase(path: string, sql: string): { userVersion: number; row: unknown } {
  const db = new Database(path, { readonly: true });
  try {
    return { userVersion: Number(db.pragma("user_version", { simple: true })), row: db.prepare(sql).get() };
  } finally { db.close(); }
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("RB-01/02/03 immutable v1 runtime snapshot", () => {
  it("records the complete exact file set, hashes, modes, proof and external digest", () => {
    const root = createSnapshot();
    const verified = verifyV1RuntimeSnapshot(root);
    const manifestBytes = readFileSync(join(root, MANIFEST));
    const decoded = JSON.parse(manifestBytes.toString("utf8")) as {
      format: string;
      proof: unknown;
      files: Array<{ path: string; sha256: string; size: number; mode: number }>;
    };

    expect(verified.manifest).toEqual(decoded);
    expect(decoded.format).toBe("agent-collab-v1-runtime/v1");
    expect(decoded.proof).toEqual(proofFor(root));
    expect(decoded.files.map((file) => file.path)).toEqual([...REQUIRED_FILES]);
    for (const file of decoded.files) {
      const path = join(root, file.path);
      expect(file).toEqual({
        path: file.path,
        sha256: sha256(readFileSync(path)),
        size: lstatSync(path).size,
        mode: lstatSync(path).mode & 0o777,
      });
    }
    expect(JSON.parse(readFileSync(join(root, "runtime/node.json"), "utf8"))).toEqual({
      format: "agent-collab-node-runtime/v1", identity: "node", binaryRealpath: nodeRealpath,
      version: process.version, sha256: nodeSha256, nativeAbi: process.versions.modules,
    });
    const receipts = JSON.parse(readFileSync(join(root, "mcp/registrations.json"), "utf8")) as {
      registrations: Array<{ agent: string; command: string; args: string[] }>;
    };
    expect(receipts.registrations.map(({ agent, command, args }) => [agent, command, ...args])).toEqual([
      ["codex", DISPATCHER, "mcp"], ["grok", DISPATCHER, "mcp"],
    ]);
    expect(readFileSync(join(root, "systemd/agent-collab.service"), "utf8"))
      .toContain(`ExecStart=${DISPATCHER} worker`);
    expect(runtimeSnapshotDigest(root)).toBe(sha256(manifestBytes));
  });

  it.each(REQUIRED_FILES)("rejects a snapshot missing %s", (required) => {
    const root = makeSnapshot();
    const validProof = proofFor(root);
    rmSync(join(root, required));
    const candidateProof = required === "proof/gate-receipt.json" ? validProof : attest(root);
    expect(() => createV1RuntimeManifest({ snapshotDirectory: root, proof: candidateProof })).toThrow(/missing|required/i);
  });

  it("rejects an incomplete dependency lock before attesting the runtime", () => {
    const root = makeSnapshot();
    const packagePath = join(root, "package.json");
    const pkg = JSON.parse(readFileSync(packagePath, "utf8")) as Record<string, unknown>;
    pkg.dependencies = { "missing-from-lock": "1.0.0" };
    write(packagePath, `${JSON.stringify(pkg, null, 2)}\n`);
    expect(() => createV1RuntimeManifest({ snapshotDirectory: root, proof: attest(root) })).toThrow(/dependenc|lock/i);
  });

  it("rejects an unclosed transitive production dependency", () => {
    const unclosed = makeSnapshot();
    const dependencyPath = join(unclosed, "node_modules/fixture-runtime-dependency/package.json");
    const dependency = JSON.parse(readFileSync(dependencyPath, "utf8")) as Record<string, unknown>;
    dependency.dependencies = { "missing-transitive-dependency": "1.0.0" };
    write(dependencyPath, `${JSON.stringify(dependency, null, 2)}\n`);
    expect(() => createV1RuntimeManifest({ snapshotDirectory: unclosed, proof: attest(unclosed) }))
      .toThrow(/dependenc|node_modules|closed/i);
  });

  it("rejects an installed package absent from the lock", () => {
    const root = makeSnapshot();
    write(join(root, "node_modules/rogue/package.json"),
      `${JSON.stringify({ name: "rogue", version: "1.0.0" })}\n`);
    write(join(root, "node_modules/rogue/index.js"), "export default 'rogue';\n");
    expect(() => createV1RuntimeManifest({ snapshotDirectory: root, proof: attest(root) }))
      .toThrow(/rogue|lock|undeclared|node_modules/i);
  });

  it("accepts a locked nested optional production dependency", () => {
    const root = makeSnapshot();
    const parentPath = join(root, "node_modules/fixture-runtime-dependency/package.json");
    const parent = JSON.parse(readFileSync(parentPath, "utf8")) as Record<string, unknown>;
    parent.optionalDependencies = { nested: "2.0.0" };
    write(parentPath, `${JSON.stringify(parent, null, 2)}\n`);
    const lockPath = join(root, "package-lock.json");
    const lock = JSON.parse(readFileSync(lockPath, "utf8")) as { packages: Record<string, unknown> };
    lock.packages["node_modules/fixture-runtime-dependency/node_modules/nested"] = { version: "2.0.0" };
    write(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
    write(join(root, "node_modules/fixture-runtime-dependency/node_modules/nested/package.json"),
      `${JSON.stringify({ name: "nested", version: "2.0.0", main: "index.js" })}\n`);
    write(join(root, "node_modules/fixture-runtime-dependency/node_modules/nested/index.js"),
      "export default 'nested';\n");
    expect(() => createV1RuntimeManifest({ snapshotDirectory: root, proof: attest(root) })).not.toThrow();
  });

  it("rejects an installed dependency version that differs from its lock entry", () => {
    const root = makeSnapshot();
    const path = join(root, "node_modules/fixture-runtime-dependency/package.json");
    const dependency = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    dependency.version = "9.9.9";
    write(path, `${JSON.stringify(dependency, null, 2)}\n`);
    expect(() => createV1RuntimeManifest({ snapshotDirectory: root, proof: attest(root) }))
      .toThrow(/version|lock|dependency/i);
  });

  it("rejects an installed dependency name that differs from its node_modules location", () => {
    const root = makeSnapshot();
    const path = join(root, "node_modules/fixture-runtime-dependency/package.json");
    const dependency = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    dependency.name = "different-package";
    write(path, `${JSON.stringify(dependency, null, 2)}\n`);
    expect(() => createV1RuntimeManifest({ snapshotDirectory: root, proof: attest(root) }))
      .toThrow(/name|location|dependency/i);
  });

  it("rejects a missing required root peer dependency", () => {
    const root = makeSnapshot();
    const packagePath = join(root, "package.json");
    const pkg = JSON.parse(readFileSync(packagePath, "utf8")) as Record<string, unknown>;
    pkg.peerDependencies = { "missing-root-peer": "1.0.0" };
    write(packagePath, `${JSON.stringify(pkg, null, 2)}\n`);
    const lockPath = join(root, "package-lock.json");
    const lock = JSON.parse(readFileSync(lockPath, "utf8")) as { packages: Record<string, Record<string, unknown>> };
    lock.packages[""]!.peerDependencies = { "missing-root-peer": "1.0.0" };
    write(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
    expect(() => createV1RuntimeManifest({ snapshotDirectory: root, proof: attest(root) }))
      .toThrow(/missing|required|peer|dependency/i);
  });

  it.each(["gate", "digest", "source"] as const)("rejects invalid reconstruction proof %s", (field) => {
    const root = makeSnapshot();
    const validProof = proofFor(root);
    const invalidProof = field === "gate" ? { ...validProof, gate: { ...validProof.gate, exitCode: 1 } }
      : field === "digest" ? { ...validProof, sourceDigest: "not-a-sha256" }
        : { ...validProof, source: "unattested-manual-copy" };
    expect(() => createV1RuntimeManifest({ snapshotDirectory: root, proof: invalidProof as never }))
      .toThrow(/proof|source|digest|gate/i);
  });

  it("rejects credentials embedded in reconstruction gate evidence", () => {
    const root = makeSnapshot();
    const credentialProof = attest(root, { ...baseProof,
      gate: { command: "npm test --token sk-proj-secretcredential", exitCode: 0 } });
    expect(() => createV1RuntimeManifest({ snapshotDirectory: root, proof: credentialProof }))
      .toThrow(/credential|secret|proof|gate/i);
  });

  it.each([
    ["direct service CLI", (root: string) => write(join(root, "systemd/agent-collab.service"),
      `[Service]\nExecStart=${process.execPath} /versions/v1/dist/cli.js worker\n`), /dispatcher|service|versioned|direct/i],
    ["direct MCP CLI", (root: string) => {
      const path = join(root, "mcp/registrations.json");
      const receipt = JSON.parse(readFileSync(path, "utf8")) as { registrations: unknown[] };
      receipt.registrations[0] = { agent: "codex", transport: "stdio", command: process.execPath,
        args: ["/versions/v1/dist/cli.js", "mcp"] };
      write(path, `${JSON.stringify(receipt, null, 2)}\n`);
    }, /dispatcher|mcp|versioned|direct/i],
    ["extra systemd side effect", (root: string) => write(join(root, "systemd/agent-collab.service"),
      GOLDEN_V1_SYSTEMD_UNIT.replace("NoNewPrivileges=true", "ExecStartPost=/bin/false\nNoNewPrivileges=true")),
    /systemd|frozen|exact|dispatcher/i],
  ] as const)("rejects %s bypass of the stable dispatcher", (_case, mutate, error) => {
    const root = makeSnapshot();
    mutate(root);
    expect(() => createV1RuntimeManifest({ snapshotDirectory: root, proof: attest(root) })).toThrow(error);
  });

  it.each([
    ["non-executable CLI", (root: string) => chmodSync(join(root, "dist/cli.js"), 0o600), /executable|mode/i],
    ["credential-bearing MCP receipt", (root: string) => {
      const path = join(root, "mcp/registrations.json");
      const receipt = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
      receipt.env = { PROVIDER_API_KEY: "CREDENTIAL_SENTINEL" };
      write(path, `${JSON.stringify(receipt, null, 2)}\n`);
    }, /credential|secret|sanit|environment/i],
    ["malformed skills hash", (root: string) => {
      const path = join(root, "skills/manifest.json");
      const skills = JSON.parse(readFileSync(path, "utf8")) as { files: Array<{ sha256: string }> };
      skills.files[0]!.sha256 = "not-a-sha256";
      write(path, `${JSON.stringify(skills, null, 2)}\n`);
    }, /skill|sha|hash/i],
    ["skill byte drift", (root: string) => appendFileSync(join(root, SKILL_PATH), "drift\n"),
      /skill|sha|hash|drift/i],
    ["node_modules .bin shim", (root: string) =>
      write(join(root, "node_modules/.bin/fixture-runtime-dependency"), "#!/bin/sh\n", 0o700),
    /\.bin|shim|excluded/i],
  ] as const)("rejects %s", (_case, mutate, error) => {
    const root = makeSnapshot();
    mutate(root);
    expect(() => createV1RuntimeManifest({ snapshotDirectory: root, proof: attest(root) })).toThrow(error);
  });

  it.each([
    ["binaryRealpath", "/not/the/attested/node"],
    ["sha256", "f".repeat(64)],
    ["version", "v0.0.0"],
    ["nativeAbi", "0"],
  ] as const)("rejects invalid Node %s evidence", (field, value) => {
    const root = makeSnapshot();
    const path = join(root, "runtime/node.json");
    const receipt = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    receipt[field] = value;
    write(path, `${JSON.stringify(receipt, null, 2)}\n`);
    expect(() => createV1RuntimeManifest({ snapshotDirectory: root, proof: attest(root) }))
      .toThrow(/node|identity|binary|sha|version|abi/i);
  });
});

describe("RB-05/06 closed-world verification", () => {
  it.each([
    ["content", (root: string) => appendFileSync(join(root, "dist/cli.js"), "// tampered\n")],
    ["mode", (root: string) => chmodSync(join(root, "dist/cli.js"), 0o755)],
    ["file set", (root: string) => write(join(root, "undeclared.txt"), "extra")],
  ] as const)("rejects post-attestation %s drift", (_case, mutate) => {
    const root = createSnapshot();
    mutate(root);
    expect(() => verifyV1RuntimeSnapshot(root)).toThrow(/hash|metadata|mode|file set|undeclared/i);
  });

  it.each([
    ["required file symlink", () => {
      const root = createSnapshot();
      const path = join(root, "dist/cli.js");
      const outside = outsideFile(readFileSync(path, "utf8"), lstatSync(path).mode & 0o777);
      rmSync(path);
      symlinkSync(outside, path);
      return root;
    }, /symlink/i],
    ["required file hardlink", () => {
      const root = createSnapshot();
      const path = join(root, "dist/cli.js");
      const outside = outsideFile(readFileSync(path, "utf8"), lstatSync(path).mode & 0o777);
      rmSync(path);
      linkSync(outside, path);
      return root;
    }, /hardlink|link count|nlink/i],
    ["manifest symlink", () => {
      const root = createSnapshot();
      const path = join(root, MANIFEST);
      const outside = outsideFile(readFileSync(path, "utf8"));
      rmSync(path);
      symlinkSync(outside, path);
      return root;
    }, /manifest|symlink/i],
    ["manifest hardlink", () => {
      const root = createSnapshot();
      const path = join(root, MANIFEST);
      const outside = outsideFile(readFileSync(path, "utf8"));
      rmSync(path);
      linkSync(outside, path);
      return root;
    }, /manifest|hardlink|link count|nlink/i],
  ] as const)("rejects post-attestation %s replacement", (_case, setup, error) => {
    expect(() => verifyV1RuntimeSnapshot(setup())).toThrow(error);
  });

  it("rejects manifest traversal even when the referenced bytes exist", () => {
    const root = makeSnapshot();
    const manifestPath = join(root, MANIFEST);
    const outside = `${root}-outside`;
    write(outside, "outside");
    roots.push(outside);
    const stat = lstatSync(outside);
    const manifest = {
      format: "agent-collab-v1-runtime/v1",
      proof: proofFor(root),
      files: [{ path: "../outside", sha256: sha256(readFileSync(outside)),
        size: stat.size, mode: stat.mode & 0o777 }],
    };
    write(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    expect(() => verifyV1RuntimeSnapshot(root)).toThrow(/path|relative|traversal|manifest/i);
  });

  it.each([
    ["extra symlink", () => {
      const root = makeSnapshot();
      symlinkSync(outsideFile(), join(root, "escape-link"));
      return root;
    }, /symlink/i],
    ["extra hardlink", () => {
      const root = makeSnapshot();
      linkSync(outsideFile(), join(root, "escape-hardlink"));
      return root;
    }, /hardlink|link count|nlink/i],
    ["snapshot root symlink", () => {
      const root = makeSnapshot();
      const alias = `${root}-link`;
      roots.push(alias);
      symlinkSync(root, alias, "dir");
      return alias;
    }, /root|symlink/i],
    ["ancestor symlink", () => {
      const root = makeSnapshot();
      const base = mkdtempSync(join(tmpdir(), "agent-collab-v1-ancestor-"));
      roots.push(base);
      symlinkSync(dirname(root), join(base, "alias"), "dir");
      return join(base, "alias", basename(root));
    }, /ancestor|symlink/i],
    ["required-file symlink", () => {
      const root = makeSnapshot();
      rmSync(join(root, "dist/cli.js"));
      symlinkSync(outsideFile(fixtureCli(), 0o700), join(root, "dist/cli.js"));
      return root;
    }, /symlink/i],
    ["required-file hardlink", () => {
      const root = makeSnapshot();
      rmSync(join(root, "dist/cli.js"));
      linkSync(outsideFile(fixtureCli(), 0o700), join(root, "dist/cli.js"));
      return root;
    }, /hardlink|link count|nlink/i],
  ] as const)("rejects %s escape", (_case, setup, error) => {
    const root = setup();
    expect(() => createV1RuntimeManifest({ snapshotDirectory: root, proof: proofFor(root) })).toThrow(error);
  });
});

describe("RB-07/14 non-launching v1 preflight", () => {
  it("returns exact v1 status and caller-attested runtime digest", async () => {
    const snapshot = createSnapshot();
    const databases = makeDatabases();
    const result = await preflightV1Runtime(preflightInput(snapshot, databases));
    expect(result).toMatchObject({
      protocol: "agent-collab/v1",
      runtimeDigest: runtimeSnapshotDigest(snapshot),
    });
  });

  it("runs status against an isolated copied database root", async () => {
    const snapshot = createSnapshot();
    const databases = makeDatabases();
    await preflightV1Runtime(preflightInput(snapshot, databases));
    expect(existsSync(databases.log)).toBe(true);
    const records = readFileSync(databases.log, "utf8").trim().split("\n").map((line) => JSON.parse(line)) as
      Array<{ kind: string; command: string; cwd: string; stateRoot: string; runtimeDependency: string;
        environment: { inheritedSentinel: string | null; home: string }; databases: {
        state: { realpath: string; dev: number; ino: number; userVersion: number; row: unknown };
        history: { realpath: string; dev: number; ino: number; userVersion: number; row: unknown };
      } }>;
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ kind: "runtime", command: "status", runtimeDependency: "closed" });
    expect(records[0]!.cwd).not.toBe(snapshot);
    expect(basename(records[0]!.cwd)).toBe("sealed-runtime");
    expect(typeof records[0]!.stateRoot).toBe("string");
    expect(records[0]!.stateRoot).not.toBe(databases.root);
    const copied = records[0]!.databases;
    const originalStateStat = lstatSync(databases.state);
    const originalHistoryStat = lstatSync(databases.history);
    expect(copied.state.realpath).not.toBe(realpathSync(databases.state));
    expect([copied.state.dev, copied.state.ino]).not.toEqual([originalStateStat.dev, originalStateStat.ino]);
    expect(copied.history.realpath).not.toBe(realpathSync(databases.history));
    expect([copied.history.dev, copied.history.ino]).not.toEqual([originalHistoryStat.dev, originalHistoryStat.ino]);
    expect({ userVersion: copied.state.userVersion, row: copied.state.row }).toEqual(logicalDatabase(
      databases.state, "SELECT agent, health FROM runtime_provider_health ORDER BY agent LIMIT 1"));
    expect({ userVersion: copied.history.userVersion, row: copied.history.row }).toEqual(logicalDatabase(
      databases.history, "SELECT project, source_path AS sourcePath FROM sources ORDER BY project LIMIT 1"));
  });

  it("does not inherit the coordinator process environment", async () => {
    const snapshot = createSnapshot();
    const databases = makeDatabases();
    process.env.V1_INHERITED_SENTINEL = "must-not-cross";
    try {
      await preflightV1Runtime(preflightInput(snapshot, databases));
    } finally {
      delete process.env.V1_INHERITED_SENTINEL;
    }
    const record = JSON.parse(readFileSync(databases.log, "utf8").trim().split("\n")[0]!) as {
      environment: { inheritedSentinel: string | null; home: string };
    };
    expect(record.environment.inheritedSentinel).toBeNull();
    expect(record.environment.home).not.toBe(process.env.HOME);
  });

  it("runs status in an offline network namespace", async () => {
    let connections = 0;
    const server = createServer((_request, response) => { connections += 1; response.end("ok"); });
    await new Promise<void>((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
    const address = server.address() as AddressInfo;
    const snapshot = createSnapshot("agent-collab/v1", "network");
    const databases = makeDatabases();
    try {
      await preflightV1Runtime({
        ...preflightInput(snapshot, databases),
        env: { ...preflightInput(snapshot, databases).env,
          V1_NETWORK_URL: `http://127.0.0.1:${address.port}/provider` },
      });
    } finally {
      await new Promise<void>((resolvePromise, rejectPromise) =>
        server.close((error) => error ? rejectPromise(error) : resolvePromise()));
    }
    const records = readFileSync(databases.log, "utf8").trim().split("\n").map((line) => JSON.parse(line)) as
      Array<{ kind: string; connected?: boolean }>;
    expect(records.find((record) => record.kind === "network")).toEqual({ kind: "network", connected: false });
    expect(connections).toBe(0);
  });

  it("backs up committed uncheckpointed WAL rows and schema metadata", async () => {
    const snapshot = createSnapshot();
    const databases = makeDatabases();
    const state = new Database(databases.state);
    const history = new Database(databases.history);
    state.pragma("journal_mode = WAL");
    state.pragma("wal_autocheckpoint = 0");
    history.pragma("journal_mode = WAL");
    history.pragma("wal_autocheckpoint = 0");
    state.prepare("INSERT INTO runtime_provider_health VALUES (?, ?)").run("aardvark", "wal-committed");
    history.prepare("INSERT INTO sources VALUES (?, ?)").run("/aaa", "/wal/committed.jsonl");
    state.pragma("user_version = 7");
    history.pragma("user_version = 9");
    try {
      await preflightV1Runtime(preflightInput(snapshot, databases));
    } finally {
      state.close();
      history.close();
    }
    const record = JSON.parse(readFileSync(databases.log, "utf8").trim().split("\n")[0]!) as {
      databases: { state: { userVersion: number; row: unknown }; history: { userVersion: number; row: unknown } };
    };
    expect(record.databases.state).toMatchObject({ userVersion: 7, row: { agent: "aardvark", health: "wal-committed" } });
    expect(record.databases.history).toMatchObject({ userVersion: 9,
      row: { project: "/aaa", sourcePath: "/wal/committed.jsonl" } });
  });

  it("does not invoke Claude, Codex, or Grok poison binaries", async () => {
    const snapshot = createSnapshot();
    const databases = makeDatabases();
    await preflightV1Runtime(preflightInput(snapshot, databases));
    expect(existsSync(databases.providerLog)).toBe(false);
  });

  it("rejects explicitly supplied provider credentials before status", async () => {
    const snapshot = createSnapshot();
    const databases = makeDatabases();
    await expect(preflightV1Runtime({
      ...preflightInput(snapshot, databases),
      env: { XAI_API_KEY: "sk-proj-secretcredential" },
    })).rejects.toThrow(/credential|secret|environment/i);
    expect(existsSync(databases.log)).toBe(false);
  });

  it.each(["HOME", "NODE_OPTIONS", "LD_PRELOAD", "NODE_PATH"])(
    "rejects caller-controlled loader or confinement variable %s", async (key) => {
      const snapshot = createSnapshot();
      const databases = makeDatabases();
      await expect(preflightV1Runtime({
        ...preflightInput(snapshot, databases),
        env: { [key]: "/tmp/unattested" },
      })).rejects.toThrow(/allowlist|environment/i);
      expect(existsSync(databases.log)).toBe(false);
    });

  it.each([
    ["gate receipt", { expectedGateReceiptSha256: "f".repeat(64) }],
    ["source", { expectedSourceDigest: "f".repeat(64) }],
  ] as const)("rejects an external %s trust-anchor mismatch before status", async (_case, override) => {
    const snapshot = createSnapshot();
    const databases = makeDatabases();
    await expect(preflightV1Runtime({ ...preflightInput(snapshot, databases), ...override }))
      .rejects.toThrow(/trust anchor|receipt|source/i);
    expect(existsSync(databases.log)).toBe(false);
  });

  it("does not mutate either caller-owned v1 database", async () => {
    const snapshot = createSnapshot();
    const databases = makeDatabases();
    const before = { state: sha256(readFileSync(databases.state)), history: sha256(readFileSync(databases.history)) };
    await preflightV1Runtime(preflightInput(snapshot, databases));
    expect(sha256(readFileSync(databases.state))).toBe(before.state);
    expect(sha256(readFileSync(databases.history))).toBe(before.history);
  });

  it("fails closed on a non-v1 status protocol", async () => {
    const snapshot = createSnapshot("agent-collab/v2");
    const databases = makeDatabases();
    await expect(preflightV1Runtime(preflightInput(snapshot, databases))).rejects.toThrow(/protocol|v1/i);
  });

  it.each([
    ["malformed JSON", "malformed", /json|malformed|parse/i],
    ["nonzero exit", "nonzero", /exit|status|86|failed/i],
  ] as const)("rejects %s status output", async (_case, behavior, error) => {
    const snapshot = createSnapshot("agent-collab/v1", behavior);
    const databases = makeDatabases();
    const input = { ...preflightInput(snapshot, databases), timeoutMs: 1_000 };
    await expect(preflightV1Runtime(input)).rejects.toThrow(error);
  });

  it("rejects a status timeout", async () => {
    const snapshot = createSnapshot("agent-collab/v1", "timeout");
    const databases = makeDatabases();
    const input = { ...preflightInput(snapshot, databases), timeoutMs: 25 };
    await expect(preflightV1Runtime(input))
      .rejects.toThrow(/timeout|timed out/i);
  });

  it("kills the timed-out PID before its delayed side effect", async () => {
    const snapshot = createSnapshot("agent-collab/v1", "timeout");
    const databases = makeDatabases();
    const input = { ...preflightInput(snapshot, databases), timeoutMs: 25 };
    await preflightV1Runtime(input).catch(() => undefined);
    const pid = existsSync(databases.log)
      ? (JSON.parse(readFileSync(databases.log, "utf8").trim().split("\n")[0]!) as { pid: number }).pid
      : null;
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect.soft(pid).not.toBeNull();
    expect.soft(existsSync(databases.lateEffect)).toBe(false);
    if (pid !== null) expect(() => process.kill(pid, 0)).toThrow();
  });

  it("kills a detached descendant when a successful status process exits", async () => {
    const snapshot = createSnapshot("agent-collab/v1", "descendant");
    const databases = makeDatabases();
    await preflightV1Runtime(preflightInput(snapshot, databases));
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(existsSync(databases.lateEffect)).toBe(false);
  });

  it("rejects caller digest mismatch before executing snapshot bytes", async () => {
    const snapshot = createSnapshot();
    const databases = makeDatabases();
    await expect(preflightV1Runtime({
      ...preflightInput(snapshot, databases),
      expectedRuntimeDigest: "f".repeat(64),
    })).rejects.toThrow(/digest|hash/i);
  });

  it("checks caller digest before executing snapshot bytes", async () => {
    const snapshot = createSnapshot();
    const databases = makeDatabases();
    await preflightV1Runtime({ ...preflightInput(snapshot, databases),
      expectedRuntimeDigest: "f".repeat(64) }).catch(() => undefined);
    expect(existsSync(databases.log)).toBe(false);
  });

  it("rejects a self-consistent M2 source replacement between M1 verification and staging", async () => {
    const original = createSnapshot();
    const replacement = createSnapshot();
    appendFileSync(join(replacement, "dist/cli.js"), "// replacement runtime\n");
    createV1RuntimeManifest({ snapshotDirectory: replacement, proof: attest(replacement) });
    const databases = makeDatabases();
    await expect(preflightV1Runtime({
      ...preflightInput(original, databases),
      testing: { beforeRuntimeStage: () => {
        rmSync(original, { recursive: true, force: true });
        mkdirSync(original, { recursive: true });
        cpSync(replacement, original, { recursive: true, preserveTimestamps: true });
      } },
    })).rejects.toThrow(/staged|digest|attested|runtime/i);
    expect(existsSync(databases.log)).toBe(false);
  });

  it.each([
    ["declared non-CLI file", (runtime: string) => {
      appendFileSync(join(runtime, "node_modules/fixture-runtime-dependency/index.js"),
        "// post-verification mutation\n");
    }],
    ["rogue file", (runtime: string) => {
      write(join(runtime, "node_modules/rogue.js"), "export default 'rogue';\n");
    }],
  ] as const)("rejects %s mutation after parent verification before sealed runtime execution", async (_case, mutate) => {
    const snapshot = createSnapshot();
    const databases = makeDatabases();
    let mutationApplied = false;
    let failure: unknown;
    await preflightV1Runtime({
      ...preflightInput(snapshot, databases),
      testing: {
        afterChildRunnerStarted: (runtime: string) => {
          mutate(runtime);
          mutationApplied = true;
        },
      },
    }).catch((error: unknown) => { failure = error; });
    expect.soft(mutationApplied).toBe(true);
    expect.soft(failure instanceof Error ? failure.message : "")
      .toContain("V1_SEALED_RUNTIME_INTEGRITY");
    expect.soft(existsSync(databases.log)).toBe(false);
  });

  it("rejects self-consistent snapshot replacement after child runner starts", async () => {
    const original = createSnapshot();
    const replacement = createSnapshot();
    appendFileSync(join(replacement, "dist/cli.js"), "// self-consistent replacement\n");
    createV1RuntimeManifest({ snapshotDirectory: replacement, proof: attest(replacement) });
    const databases = makeDatabases();
    let mutationApplied = false;
    let failure: unknown;
    await preflightV1Runtime({
      ...preflightInput(original, databases),
      testing: {
        afterChildRunnerStarted: (runtime) => {
          rmSync(runtime, { recursive: true, force: true });
          cpSync(replacement, runtime, { recursive: true, preserveTimestamps: true });
          mutationApplied = true;
        },
      },
    }).catch((error: unknown) => { failure = error; });
    expect.soft(mutationApplied).toBe(true);
    expect.soft(failure instanceof Error ? failure.message : "")
      .toContain("V1_SEALED_RUNTIME_INTEGRITY");
    expect.soft(existsSync(databases.log)).toBe(false);
  });

  it("executes the verified runtime from a private read-only tmpfs", async () => {
    const snapshot = createSnapshot();
    const databases = makeDatabases();
    const input = preflightInput(snapshot, databases);
    await preflightV1Runtime({
      ...input,
      env: { ...input.env, V1_SEAL_PROBE_LOG: databases.sealProbe },
    });
    const probe = JSON.parse(readFileSync(databases.sealProbe, "utf8")) as {
      readOnly: boolean; tmpfs: boolean;
    };
    expect(probe).toEqual({ readOnly: true, tmpfs: true });
  });

  it("retains containment roots when process-group reap cannot be proven", async () => {
    const snapshot = createSnapshot("agent-collab/v1", "timeout");
    const databases = makeDatabases();
    let containment: { runtime: string; state: string } | undefined;
    await expect(preflightV1Runtime({
      ...preflightInput(snapshot, databases),
      timeoutMs: 25,
      testing: {
        forceReapTimeout: true,
        onContainmentRoots: (value) => { containment = value; },
      },
    })).rejects.toThrow(/reap|retained|containment/i);
    expect(containment).toBeDefined();
    expect(existsSync(containment!.runtime)).toBe(true);
    expect(existsSync(containment!.state)).toBe(true);
    roots.push(containment!.runtime, containment!.state);
  });

  it.each([
    ["mismatched", (_databases: ReturnType<typeof makeDatabases>): string => "/bin/true", /node|identity|sha|version|abi/i],
    ["missing", (databases: ReturnType<typeof makeDatabases>): string => join(databases.root, "missing-node"),
      /node|missing|exist|binary/i],
    ["non-executable", (databases: ReturnType<typeof makeDatabases>): string => {
      const path = join(databases.root, "non-executable-node");
      write(path, "not executable", 0o600);
      return path;
    }, /node|executable|permission|mode/i],
  ] as const)("rejects %s nodeBinary before status", async (_case, binary, error) => {
    const snapshot = createSnapshot();
    const databases = makeDatabases();
    await expect(preflightV1Runtime({
      ...preflightInput(snapshot, databases), nodeBinary: binary(databases),
    })).rejects.toThrow(error);
  });
});
