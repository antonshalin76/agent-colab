import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import {
  closeSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { acquireStateOpenAdmission } from "../src/store/state-open-admission.js";

const roots: string[] = [];
const children = new Set<ChildProcessWithoutNullStreams>();

function stateRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "agent-collab-state-open-admission-"));
  roots.push(root);
  return root;
}

function waitForOutput(
  child: ChildProcessWithoutNullStreams,
  output: { value: string },
  marker: string,
  timeoutMs = 2_000,
): Promise<void> {
  if (output.value.includes(marker)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`timed out waiting for child output ${JSON.stringify(marker)}; got ${JSON.stringify(output.value)}`));
    }, timeoutMs);
    const onData = (): void => {
      if (!output.value.includes(marker)) return;
      cleanup();
      resolve();
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      cleanup();
      reject(new Error(`child exited before ${JSON.stringify(marker)}: code=${code} signal=${signal} output=${JSON.stringify(output.value)}`));
    };
    const cleanup = (): void => {
      clearTimeout(timeout);
      child.stdout.off("data", onData);
      child.off("exit", onExit);
    };
    child.stdout.on("data", onData);
    child.once("exit", onExit);
  });
}

function waitForExit(child: ChildProcessWithoutNullStreams, timeoutMs = 2_000): Promise<void> {
  if (child.exitCode !== null) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("timed out waiting for admission child to exit"));
    }, timeoutMs);
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      cleanup();
      if (code === 0) resolve();
      else reject(new Error(`admission child failed: code=${code} signal=${signal}`));
    };
    const cleanup = (): void => {
      clearTimeout(timeout);
      child.off("exit", onExit);
    };
    child.once("exit", onExit);
  });
}

function competingAdmission(
  root: string,
  mode: "shared" | "exclusive",
): { child: ChildProcessWithoutNullStreams; output: { value: string } } {
  const script = `
    import { acquireStateOpenAdmission } from ${JSON.stringify(
      new URL("../src/store/state-open-admission.ts", import.meta.url).href,
    )};
    process.stdout.write("ATTEMPT\\n");
    const lease = acquireStateOpenAdmission(process.argv[1], process.argv[2]);
    process.stdout.write("ACQUIRED\\n");
    lease.release();
  `;
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "--eval", script, root, mode],
    { cwd: process.cwd(), stdio: ["pipe", "pipe", "pipe"] },
  );
  const output = { value: "" };
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => { output.value += chunk; });
  child.stderr.on("data", (chunk: string) => { output.value += `STDERR:${chunk}`; });
  children.add(child);
  child.once("exit", () => children.delete(child));
  return { child, output };
}

async function expectBlockedUntilRelease(
  ownerMode: "shared" | "exclusive",
  contenderMode: "shared" | "exclusive",
): Promise<void> {
  const root = stateRoot();
  const owner = acquireStateOpenAdmission(root, ownerMode);
  const { child, output } = competingAdmission(root, contenderMode);
  try {
    await waitForOutput(child, output, "ATTEMPT\n");
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(child.exitCode).toBeNull();
    expect(output.value).not.toContain("ACQUIRED\n");
    owner.release();
    await waitForOutput(child, output, "ACQUIRED\n");
    await waitForExit(child);
  } finally {
    owner.release();
    if (child.exitCode === null) child.kill("SIGKILL");
  }
}

afterEach(() => {
  for (const child of children) {
    if (child.exitCode === null) child.kill("SIGKILL");
  }
  children.clear();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("state-open admission", () => {
  it("holds a shared lease against an exclusive process until release", async () => {
    await expectBlockedUntilRelease("shared", "exclusive");
  });

  it("holds an exclusive lease against a shared process until release", async () => {
    await expectBlockedUntilRelease("exclusive", "shared");
  });

  it("fails closed when the root path is replaced while held", () => {
    const root = stateRoot();
    const displaced = `${root}-displaced`;
    roots.push(displaced);
    const lease = acquireStateOpenAdmission(root, "shared");
    renameSync(root, displaced);
    mkdirSync(root, { mode: 0o700 });
    try {
      expect(() => lease.assertCurrent()).toThrow(/root identity changed|root changed/i);
    } finally {
      lease.release();
    }
  });

  it("fails closed when the lock pathname is replaced while held", () => {
    const root = stateRoot();
    const lock = join(root, ".state-open-admission.lock");
    const lease = acquireStateOpenAdmission(root, "shared");
    rmSync(lock);
    const replacement = openSync(lock, "w", 0o600);
    closeSync(replacement);
    try {
      expect(() => lease.assertCurrent()).toThrow(/lock identity changed|lock pathname changed/i);
    } finally {
      lease.release();
    }
  });

  it("rejects root aliases and symbolic-link lock files", () => {
    const root = stateRoot();
    const rootAlias = `${root}-alias`;
    roots.push(rootAlias);
    symlinkSync(root, rootAlias, "dir");
    expect(() => acquireStateOpenAdmission(rootAlias, "shared")).toThrow(/real state root|aliases/i);

    const lockTarget = join(root, "lock-target");
    writeFileSync(lockTarget, "");
    symlinkSync(lockTarget, join(root, ".state-open-admission.lock"));
    expect(() => acquireStateOpenAdmission(root, "exclusive")).toThrow();
  });

  it("rejects a hard-linked admission lock", () => {
    const root = stateRoot();
    const lockTarget = join(root, "lock-target");
    writeFileSync(lockTarget, "");
    linkSync(lockTarget, join(root, ".state-open-admission.lock"));
    expect(() => acquireStateOpenAdmission(root, "shared")).toThrow(/lock identity is invalid/i);
  });
});
