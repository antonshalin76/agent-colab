import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildOracleSandboxCommand,
  createOracleSandboxExecutor,
} from "../src/eval/oracle-sandbox.js";

const roots: string[] = [];

const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), "agent-collab-oracle-sandbox-"));
  roots.push(root);
  const workspaceRoot = join(root, "candidate");
  const oracleRoot = join(root, "private-oracle");
  const scratchRoot = join(root, "oracle-scratch");
  mkdirSync(workspaceRoot);
  mkdirSync(oracleRoot);
  mkdirSync(scratchRoot);
  return { root, workspaceRoot, oracleRoot, scratchRoot };
};

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("oracle bubblewrap sandbox", () => {
  it("mounts only frozen runtime, read-only candidate and oracle, and writable scratch", () => {
    const roots = fixture();
    const command = buildOracleSandboxCommand({
      ...roots,
      request: {
        file: "/usr/bin/python3",
        args: [join(roots.oracleRoot, "TR-BUG-01.py"), roots.workspaceRoot],
        cwd: roots.oracleRoot,
        timeoutMs: 10_000,
        workspaceAccess: "read_only",
      },
      maxOutputBytes: 4096,
      maxAddressSpaceBytes: 2 ** 30,
      maxFileBytes: 2 ** 20,
    });

    expect(command.file).toBe("/usr/bin/bwrap");
    expect(command.args).toEqual(expect.arrayContaining([
      "--unshare-all", "--unshare-user", "--disable-userns", "--clearenv",
      "--ro-bind", roots.workspaceRoot, "/workspace",
      "--ro-bind", roots.oracleRoot, "/oracle",
      "--bind", roots.scratchRoot, "/scratch",
    ]));
    expect(command.args).not.toContain("--share-net");
    expect(command.args.slice(command.args.indexOf("/usr/bin/prlimit"))).toEqual([
      "/usr/bin/prlimit",
      "--core=0", `--fsize=${2 ** 20}`, "--nofile=256", `--as=${2 ** 30}`,
      "--cpu=15",
      "--",
      "/usr/bin/python3", "/oracle/TR-BUG-01.py", "/workspace",
    ]);
  });

  it("allows build regressions to write only the candidate and omits the hidden oracle mount", () => {
    const roots = fixture();
    const command = buildOracleSandboxCommand({
      ...roots,
      request: {
        file: "/bin/bash",
        args: ["-lc", "touch build-proof"],
        cwd: roots.workspaceRoot,
        timeoutMs: 10_000,
        workspaceAccess: "read_write",
      },
      maxOutputBytes: 4096,
      maxAddressSpaceBytes: 2 ** 30,
      maxFileBytes: 2 ** 20,
    });

    expect(command.args).toEqual(expect.arrayContaining([
      "--bind", roots.workspaceRoot, "/workspace",
    ]));
    expect(command.args).not.toEqual(expect.arrayContaining([
      "--ro-bind", roots.oracleRoot, "/oracle",
    ]));
  });

  it("mounts a fingerprinted Python runtime read-only for Translator checks", () => {
    const roots = fixture();
    const pythonRuntimeRoot = join(roots.root, "python-runtime");
    mkdirSync(join(pythonRuntimeRoot, "bin"), { recursive: true });
    const command = buildOracleSandboxCommand({
      ...roots,
      pythonRuntimeRoot,
      request: {
        file: "/usr/bin/python3",
        args: [join(roots.oracleRoot, "TR-BUG-01.py"), roots.workspaceRoot],
        cwd: roots.oracleRoot,
        timeoutMs: 10_000,
        workspaceAccess: "read_only",
      },
      maxOutputBytes: 4096,
      maxAddressSpaceBytes: 2 ** 30,
      maxFileBytes: 2 ** 20,
    });

    expect(command.args).toEqual(expect.arrayContaining([
      "--ro-bind", pythonRuntimeRoot, "/oracle-python",
      "--setenv", "VIRTUAL_ENV", "/oracle-python",
    ]));
    expect(command.args.slice(command.args.lastIndexOf("--") + 1)).toEqual([
      "/oracle-python/bin/python", "/oracle/TR-BUG-01.py", "/workspace",
    ]);
  });

  it("rejects path escapes, unexpected environment variables, and overlapping private roots", () => {
    const roots = fixture();
    const base = {
      ...roots,
      maxOutputBytes: 4096,
      maxAddressSpaceBytes: 2 ** 30,
      maxFileBytes: 2 ** 20,
    };
    expect(() => buildOracleSandboxCommand({
      ...base,
      request: {
        file: "/usr/bin/python3", args: ["/home/anton/.ssh/id_ed25519"],
        cwd: roots.workspaceRoot, timeoutMs: 1000, workspaceAccess: "read_only",
      },
    })).toThrow(/argument.*outside|path.*allowed/i);
    expect(() => buildOracleSandboxCommand({
      ...base,
      request: {
        file: "/usr/bin/python3", args: [], cwd: roots.workspaceRoot, timeoutMs: 1000,
        workspaceAccess: "read_only", env: { LD_PRELOAD: "/tmp/attack.so" },
      },
    })).toThrow(/environment/i);
    expect(() => buildOracleSandboxCommand({
      ...base,
      scratchRoot: join(roots.workspaceRoot, "scratch"),
      request: {
        file: "/usr/bin/python3", args: [], cwd: roots.workspaceRoot, timeoutMs: 1000,
        workspaceAccess: "read_only",
      },
    })).toThrow(/roots.*overlap|scratch/i);
  });

  it.skipIf(process.platform !== "linux" || !existsSync("/usr/bin/bwrap"))(
    "executes with no host home/evidence visibility and honors workspace access",
    async () => {
      const roots = fixture();
      const hostEvidence = join(roots.root, "run-evidence-secret");
      writeFileSync(hostEvidence, "secret");
      const script = join(roots.oracleRoot, "check.py");
      writeFileSync(script, [
        "from pathlib import Path",
        "import json",
        "workspace = Path('/workspace')",
        "blocked = not Path('" + hostEvidence + "').exists() and not Path('/home/anton').exists()",
        "writable = True",
        "try: (workspace / 'forbidden').write_text('x')",
        "except OSError: writable = False",
        "print(json.dumps({'blocked': blocked, 'writable': writable}))",
      ].join("\n"));
      const execute = createOracleSandboxExecutor({
        ...roots,
        maxOutputBytes: 4096,
        terminationGraceMs: 50,
      });
      const readOnly = await execute({
        file: "/usr/bin/python3",
        args: [script],
        cwd: roots.oracleRoot,
        timeoutMs: 5_000,
        workspaceAccess: "read_only",
      });

      expect(readOnly.exitCode).toBe(0);
      expect(JSON.parse(readOnly.stdout)).toEqual({ blocked: true, writable: false });
      expect(readOnly.cleanupVerified).toBe(true);
      expect(readFileSync(hostEvidence, "utf8")).toBe("secret");
    },
  );

  it.skipIf(process.platform !== "linux" || !existsSync("/usr/bin/bwrap"))(
    "bounds output and kills the complete sandbox process group",
    async () => {
      const roots = fixture();
      const script = join(roots.oracleRoot, "flood.py");
      writeFileSync(script, "while True: print('x' * 1024, flush=True)\n");
      const execute = createOracleSandboxExecutor({
        ...roots,
        maxOutputBytes: 2048,
        terminationGraceMs: 50,
      });
      const result = await execute({
        file: "/usr/bin/python3", args: [script], cwd: roots.oracleRoot,
        timeoutMs: 5_000, workspaceAccess: "read_only",
      });

      expect(result.exitCode).not.toBe(0);
      expect(result.outputLimitExceeded).toBe(true);
      expect(result.stdout.length + result.stderr.length).toBeLessThanOrEqual(2048);
      expect(result.cleanupVerified).toBe(true);
    },
  );
});
