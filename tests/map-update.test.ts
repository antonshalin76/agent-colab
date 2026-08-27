import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  classifyMapUpdateCandidate,
  classifyMapUpdateCandidateFromEvidence,
  createMapCandidateProtocol,
  createMapPackageInstallArguments,
  createMapToolListArguments,
  createMapUpdateIsolation,
  createMapUpdateSandboxCommand,
  inspectMapCandidateDistributionMetadata,
  isolatedPythonArguments,
  interpretMapUpdateExecution,
  mapUpdateVersionMatches,
  parseMapUvInstallVersion,
  parseMapUvToolListVersion,
  parseMapUpdateProtocol,
  profileFilesFingerprint,
} from "../src/flow/map-update.js";
import { fingerprintMapRuntimeToolTree } from "../src/flow/map-admin.js";

describe("MAP manual update protocol", () => {
  it("redirects updater tool, bin, and cache writes into the disposable candidate", () => {
    const root = mkdtempSync(join(tmpdir(), "agent-collab-map-update-isolation-"));
    const globalToolDir = join(root, "global-tools");
    const globalBinDir = join(root, "global-bin");
    const candidateRoot = join(root, "candidate");
    try {
      mkdirSync(globalToolDir, { recursive: true });
      mkdirSync(globalBinDir, { recursive: true });
      mkdirSync(candidateRoot, { recursive: true });
      const isolation = createMapUpdateIsolation({
        PATH: `/usr/bin:${globalBinDir}`,
        PYTHONPATH: join(root, "attacker-python-path"),
        PYTHONHOME: join(root, "attacker-python-home"),
        VIRTUAL_ENV: join(root, "attacker-virtualenv"),
        CONDA_PREFIX: join(root, "attacker-conda"),
        PIP_INDEX_URL: "https://attacker.invalid/simple",
        PIP_CONFIG_FILE: join(root, "attacker-pip.conf"),
        UV_INDEX_URL: "https://attacker.invalid/simple",
        UV_CONFIG_FILE: join(root, "attacker-uv.toml"),
        UV_PYTHON: join(root, "attacker-python"),
        UV_TOOL_DIR: globalToolDir,
        UV_TOOL_BIN_DIR: globalBinDir,
        UV_CACHE_DIR: join(root, "global-cache"),
        HOME: join(root, "attacker-home"),
        INIT_CWD: join(root, "attacker-project"),
        SENTINEL_CREDENTIAL: "must-not-cross",
      }, candidateRoot);
      const child = spawnSync(process.execPath, ["-e", [
        "const fs=require('node:fs');",
        "const path=require('node:path');",
        "fs.mkdirSync(process.env.UV_TOOL_BIN_DIR,{recursive:true});",
        "fs.writeFileSync(path.join(process.env.UV_TOOL_BIN_DIR,'mapify'),'candidate-only');",
      ].join("")], { env: isolation.environment, encoding: "utf8" });
      expect(child.status, child.stderr).toBe(0);
      expect(isolation.toolDirectory.startsWith(`${candidateRoot}/`)).toBe(true);
      expect(isolation.toolDirectory.replaceAll("\\", "/")).toMatch(/\/uv\/tools$/u);
      expect(isolation.binDirectory.startsWith(`${candidateRoot}/`)).toBe(true);
      expect(isolation.cacheDirectory.startsWith(`${candidateRoot}/`)).toBe(true);
      expect(isolation.environment.PATH).toBe([
        isolation.binDirectory,
        "/usr/local/sbin",
        "/usr/local/bin",
        "/usr/sbin",
        "/usr/bin",
        "/sbin",
        "/bin",
      ].join(":"));
      expect(isolation.environment.PATH).not.toContain(globalBinDir);
      expect(isolation.environment.PYTHONPATH).toBeUndefined();
      expect(isolation.environment.PYTHONHOME).toBeUndefined();
      expect(isolation.environment.VIRTUAL_ENV).toBeUndefined();
      expect(isolation.environment.CONDA_PREFIX).toBeUndefined();
      expect(isolation.environment.PIP_INDEX_URL).toBeUndefined();
      expect(isolation.environment.PIP_CONFIG_FILE).toBeUndefined();
      expect(isolation.environment.UV_INDEX_URL).toBeUndefined();
      expect(isolation.environment.UV_CONFIG_FILE).toBeUndefined();
      expect(isolation.environment.UV_PYTHON).toBeUndefined();
      expect(isolation.environment.UV_NO_CONFIG).toBe("1");
      expect(isolation.environment.PYTHONDONTWRITEBYTECODE).toBe("1");
      expect(isolation.environment.HOME).toBe(isolation.homeDirectory);
      expect(isolation.environment.INIT_CWD).toBeUndefined();
      expect(isolation.environment.SENTINEL_CREDENTIAL).toBeUndefined();
      expect(isolatedPythonArguments(["mapify", "--version"]))
        .toEqual(["-I", "-B", "mapify", "--version"]);
      expect(existsSync(join(isolation.binDirectory, "mapify"))).toBe(true);
      expect(existsSync(join(globalBinDir, "mapify"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("contains candidate code to its writable root, minimal environment, and offline network", async () => {
    const candidateRoot = mkdtempSync(join(tmpdir(), "agent-collab-map-update-sandbox-"));
    const outsideRoot = mkdtempSync(join(tmpdir(), "agent-collab-map-update-outside-"));
    const credentialPath = join(outsideRoot, "credential");
    const outsideWritePath = join(outsideRoot, "written");
    const script = join(candidateRoot, "candidate-check");
    const listener = createServer();
    try {
      await new Promise<void>((resolve, reject) => {
        listener.once("error", reject);
        listener.listen(0, "127.0.0.1", () => resolve());
      });
      const address = listener.address();
      if (address === null || typeof address === "string") throw new Error("test listener address is unavailable");
      writeFileSync(credentialPath, "sentinel-credential");
      writeFileSync(script, [
        "#!/bin/sh",
        `if test -r ${JSON.stringify(credentialPath)}; then cp ${JSON.stringify(credentialPath)} "$PWD/leaked-file"; fi`,
        "if test -n \"${SENTINEL_CREDENTIAL:-}\"; then printf '%s' \"$SENTINEL_CREDENTIAL\" > \"$PWD/leaked-env\"; fi",
        `printf 'outside' > ${JSON.stringify(outsideWritePath)} 2>/dev/null || true`,
        `if /bin/bash -c 'exec 3<>/dev/tcp/127.0.0.1/${address.port}' 2>/dev/null; then printf 'network' > "$PWD/network-leak"; fi`,
        "printf 'candidate' > \"$PWD/local-write\"",
      ].join("\n"));
      chmodSync(script, 0o700);
      const isolation = createMapUpdateIsolation({
        ...process.env,
        SENTINEL_CREDENTIAL: "must-not-cross",
      }, candidateRoot);
      for (const directory of [
        isolation.toolDirectory,
        isolation.binDirectory,
        isolation.cacheDirectory,
        isolation.pythonDirectory,
        isolation.homeDirectory,
        isolation.temporaryDirectory,
        isolation.configDirectory,
        isolation.dataDirectory,
        isolation.environment.PIPX_HOME!,
      ]) mkdirSync(directory, { recursive: true, mode: 0o700 });
      const command = createMapUpdateSandboxCommand({
        sandboxExecutable: "/usr/bin/bwrap",
        candidateRoot,
        pythonRealPath: "/usr/bin/python3.12",
        file: script,
        args: [],
        cwd: candidateRoot,
        environment: isolation.environment,
        networkMode: "offline",
      });
      expect(command.args).toEqual(expect.arrayContaining([
        "--clearenv", "--ro-bind", "/usr", "/usr", "--tmpfs", "/home",
        "--remount-ro", "/tmp", "--bind", candidateRoot, candidateRoot,
      ]));
      expect(command.args).not.toEqual(expect.arrayContaining(["--ro-bind", "/", "/"]));
      expect(command.args).not.toContain("--share-net");
      const result = spawnSync(command.file, command.args, {
        cwd: command.cwd,
        env: command.environment,
        encoding: "utf8",
      });
      expect(result.status, result.stderr).toBe(0);
      expect(existsSync(join(candidateRoot, "local-write"))).toBe(true);
      expect(existsSync(join(candidateRoot, "leaked-env"))).toBe(false);
      expect(existsSync(join(candidateRoot, "leaked-file"))).toBe(false);
      expect(existsSync(join(candidateRoot, "network-leak"))).toBe(false);
      expect(existsSync(outsideWritePath)).toBe(false);
    } finally {
      listener.close();
      rmSync(candidateRoot, { recursive: true, force: true });
      rmSync(outsideRoot, { recursive: true, force: true });
    }
  });

  it("grants network only to the pinned uv wheel download command", () => {
    const candidateRoot = mkdtempSync(join(tmpdir(), "agent-collab-map-update-online-"));
    const uv = join(candidateRoot, "uv");
    try {
      writeFileSync(uv, "uv");
      chmodSync(uv, 0o700);
      const isolation = createMapUpdateIsolation(process.env, candidateRoot);
      const installArguments = createMapPackageInstallArguments("/usr/bin/python3.12");
      expect(installArguments).toEqual([
        "tool", "install", "--force", "--refresh", "--no-build", "--no-sources",
        "--no-config", "--keyring-provider", "disabled", "--resolution", "highest",
        "--prerelease", "disallow", "--default-index", "https://pypi.org/simple",
        "--python", "/usr/bin/python3.12", "--no-python-downloads", "--link-mode", "copy",
        "--color", "never", "--no-progress", "mapify-cli",
      ]);
      const command = createMapUpdateSandboxCommand({
        sandboxExecutable: "/usr/bin/bwrap",
        candidateRoot,
        pythonRealPath: "/usr/bin/python3.12",
        file: uv,
        args: installArguments,
        cwd: candidateRoot,
        environment: isolation.environment,
        networkMode: "package_download",
      });
      expect(command.args).toContain("--share-net");
    } finally {
      rmSync(candidateRoot, { recursive: true, force: true });
    }
  });

  it("derives the selected version from pinned uv output before candidate code can report a version", () => {
    const toolRoot = "/tmp/candidate/.map-update-runtime/uv/tools/mapify-cli";
    const binPath = "/tmp/candidate/.map-update-runtime/uv/bin/mapify";
    const installOutput = [
      "Resolved 22 packages in 120ms",
      "Prepared 22 packages in 90ms",
      "Installed 22 packages in 10ms",
      " + mapify-cli==4.0.0",
      "",
    ].join("\n");
    const toolListOutput = `mapify-cli v4.0.0 (${toolRoot})\n- mapify (${binPath})\n`;
    const selectedVersion = parseMapUvInstallVersion(installOutput);
    expect(selectedVersion).toBe("4.0.0");
    expect(parseMapUvToolListVersion(toolListOutput, toolRoot, binPath)).toBe(selectedVersion);
    expect(createMapToolListArguments()).toEqual([
      "tool", "list", "--show-paths", "--show-version-specifiers",
      "--offline", "--no-config", "--color", "never",
    ]);
    expect(createMapCandidateProtocol("3.28.1", selectedVersion)).toMatchObject({
      status: "major_available",
      major: { version: "4.0.0" },
    });
    expect(() => parseMapUvInstallVersion(`${installOutput} + mapify-cli==3.29.0\n`))
      .toThrow(/exactly one mapify-cli version/i);
    expect(() => parseMapUvToolListVersion(
      `mapify-cli v4.0.0 (/tmp/other)\n- mapify (${binPath})\n`,
      toolRoot,
      binPath,
    )).toThrow(/canonical mapify-cli entry/i);
  });

  it("binds distribution metadata and the completed candidate tool tree", () => {
    const root = mkdtempSync(join(tmpdir(), "agent-collab-map-update-candidate-tree-"));
    const toolRoot = join(root, ".map-update-runtime/uv/tools/mapify-cli");
    const metadataDirectory = join(
      toolRoot,
      "lib/python3.14/site-packages/mapify_cli-3.28.1.dist-info",
    );
    try {
      mkdirSync(join(toolRoot, "bin"), { recursive: true });
      mkdirSync(metadataDirectory, { recursive: true });
      writeFileSync(join(toolRoot, "bin/mapify"), "#!/bin/sh\n");
      writeFileSync(join(toolRoot, "uv-receipt.toml"), [
        "[tool]",
        "requirements = [{ name = \"mapify-cli\", specifier = \"==3.28.1\" }]",
        "",
      ].join("\n"));
      writeFileSync(join(metadataDirectory, "METADATA"), [
        "Metadata-Version: 2.5",
        "Name: mapify-cli",
        "Version: 3.28.1",
        "",
      ].join("\n"));
      const metadata = inspectMapCandidateDistributionMetadata(toolRoot, "3.28.1");
      expect(metadata.version).toBe("3.28.1");
      expect(metadata.path).toBe(join(metadataDirectory, "METADATA"));
      const completedTree = fingerprintMapRuntimeToolTree(toolRoot);
      writeFileSync(join(metadataDirectory, "METADATA"), [
        "Metadata-Version: 2.5",
        "Name: mapify-cli",
        "Version: 3.28.1",
        "X-Post-Receipt-Mutation: true",
        "",
      ].join("\n"));
      expect(fingerprintMapRuntimeToolTree(toolRoot)).not.toBe(completedTree);
      expect(inspectMapCandidateDistributionMetadata(toolRoot, "3.28.1").sha256)
        .not.toBe(metadata.sha256);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects the candidate at the orchestration decision seam when completed identity changes", () => {
    const protocol = createMapCandidateProtocol("3.28.1", "3.28.1");
    const identity = {
      toolTreeSha256: "a".repeat(64),
      uvReceiptSha256: "b".repeat(64),
      distributionMetadataPath: "/tmp/candidate/METADATA",
      distributionMetadataSha256: "c".repeat(64),
      mapifyExecutableSha256: "d".repeat(64),
      publishedMapifyLinkTarget: "/tmp/candidate/bin/mapify",
      pythonRealPath: "/opt/pinned/python",
      pythonSha256: "e".repeat(64),
    };
    const passingEvidence = {
      activeVersion: "3.28.1",
      candidateManifestVersion: "3.28.1",
      candidateCliVersion: "3.28.1",
      selectedVersion: "3.28.1",
      selectedVersionFromInstall: "3.28.1",
      selectedVersionFromToolList: "3.28.1",
      updateExitCode: 0,
      toolListExitCode: 0,
      providerRefreshExitCode: 0,
      checkInstalledExitCode: 0,
      readinessExitCode: 0,
      installKind: "uv-tool",
      toolIdentityBeforeExecution: identity,
      completedToolIdentity: identity,
      currentProfileMutated: false,
      currentCliMutated: false,
    };
    expect(classifyMapUpdateCandidateFromEvidence(protocol, passingEvidence))
      .toBe("CURRENT_PROFILE_VERIFIED");
    expect(classifyMapUpdateCandidateFromEvidence(protocol, {
      ...passingEvidence,
      completedToolIdentity: {
        ...identity,
        distributionMetadataSha256: "f".repeat(64),
      },
    })).toBe("CANDIDATE_REJECTED");
    expect(classifyMapUpdateCandidateFromEvidence(protocol, {
      ...passingEvidence,
      candidateCliVersion: "3.29.0",
    })).toBe("CANDIDATE_REJECTED");
  });

  it("blocks inherited Python module injection for updater invocations", () => {
    const root = mkdtempSync(join(tmpdir(), "agent-collab-map-update-python-injection-"));
    const attackDirectory = join(root, "attacker");
    const candidateRoot = join(root, "candidate");
    const sentinel = join(root, "outside-candidate-sentinel");
    const script = join(root, "mapify");
    try {
      mkdirSync(attackDirectory, { recursive: true });
      mkdirSync(candidateRoot, { recursive: true });
      writeFileSync(join(attackDirectory, "mapify_cli.py"), [
        "from pathlib import Path",
        `Path(${JSON.stringify(sentinel)}).write_text('forged')`,
        "VERSION = '3.28.1'",
      ].join("\n"));
      writeFileSync(script, "import mapify_cli\nprint(mapify_cli.VERSION)\n");

      const vulnerable = spawnSync("python3", [script], {
        encoding: "utf8",
        env: { ...process.env, PYTHONPATH: attackDirectory },
      });
      expect(vulnerable.status, vulnerable.stderr).toBe(0);
      expect(vulnerable.stdout.trim()).toBe("3.28.1");
      expect(existsSync(sentinel)).toBe(true);
      rmSync(sentinel);

      const isolation = createMapUpdateIsolation({
        ...process.env,
        PYTHONPATH: attackDirectory,
      }, candidateRoot);
      const protectedRun = spawnSync("python3", isolatedPythonArguments([script]), {
        encoding: "utf8",
        env: isolation.environment,
      });
      expect(protectedRun.status).not.toBe(0);
      expect(existsSync(sentinel)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each([
    ["current", { status: "current", current_version: "3.28.1", reload_current_skill: false }],
    ["updated", { status: "updated", current_version: "3.28.1", installed_version: "3.29.0", reload_current_skill: true }],
    ["major_available", { status: "major_available", current_version: "3.28.1", reload_current_skill: false,
      major: { version: "4.0.0", title: "v4", body: "breaking", url: "https://example.invalid/v4" } }],
  ])("accepts the exact upstream %s result", (_status, payload) => {
    expect(parseMapUpdateProtocol(`${JSON.stringify(payload)}\n`)).toEqual(payload);
  });

  it.each([
    "not-json\n",
    `${JSON.stringify({ status: "updated", current_version: "3.28.1", reload_current_skill: true })}\n`,
    `${JSON.stringify({ status: "major_available", current_version: "3.28.1", reload_current_skill: false })}\n`,
    `${JSON.stringify({ status: "current", current_version: "3.28.1", reload_current_skill: false })}\nextra\n`,
    `${JSON.stringify({ status: "unknown", current_version: "3.28.1", reload_current_skill: false })}\n`,
  ])("rejects malformed or semantically incomplete success output", (stdout) => {
    expect(() => parseMapUpdateProtocol(stdout)).toThrow(/MAP update protocol/i);
  });

  it("detects a mutation in the exact current profile file set", () => {
    const root = mkdtempSync(join(tmpdir(), "agent-collab-map-update-fingerprint-"));
    try {
      mkdirSync(join(root, ".map"));
      writeFileSync(join(root, ".map/config.yaml"), "updates.auto: false\n");
      writeFileSync(join(root, ".map/mapify.lock.json"), "{}\n");
      const paths = [".map/config.yaml", ".map/mapify.lock.json"];
      const before = profileFilesFingerprint(root, paths);
      expect(profileFilesFingerprint(root, paths)).toBe(before);
      writeFileSync(join(root, ".map/config.yaml"), "updates.auto: true\n");
      expect(profileFilesFingerprint(root, paths)).not.toBe(before);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects a protected profile path replaced by a same-byte symlink", () => {
    const root = mkdtempSync(join(tmpdir(), "agent-collab-map-update-symlink-"));
    const outside = join(root, "same-bytes.txt");
    try {
      mkdirSync(join(root, ".map"));
      writeFileSync(outside, "same bytes\n");
      symlinkSync(outside, join(root, ".map/config.yaml"));
      expect(() => profileFilesFingerprint(root, [".map/config.yaml"]))
        .toThrow(/canonical regular file/i);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("distinguishes no-op, reviewed candidate, major approval, and failed checks", () => {
    const current = parseMapUpdateProtocol('{"status":"current","current_version":"3.28.1","reload_current_skill":false}\n');
    const updated = parseMapUpdateProtocol('{"status":"updated","current_version":"3.28.1","installed_version":"3.29.0","reload_current_skill":true}\n');
    const major = parseMapUpdateProtocol('{"status":"major_available","current_version":"3.28.1","reload_current_skill":false,"major":{"version":"4.0.0","title":"v4","body":"breaking","url":"https://example.invalid/v4"}}\n');
    expect(classifyMapUpdateCandidate(current, true)).toBe("CURRENT_PROFILE_VERIFIED");
    expect(classifyMapUpdateCandidate(updated, true)).toBe("CANDIDATE_READY_FOR_REVIEW");
    expect(classifyMapUpdateCandidate(major, true)).toBe("MAJOR_APPROVAL_REQUIRED");
    expect(classifyMapUpdateCandidate(updated, false)).toBe("CANDIDATE_REJECTED");
    expect(classifyMapUpdateCandidate(null, true)).toBe("CANDIDATE_REJECTED");
  });

  it("binds both the active source version and candidate target version", () => {
    const updated = parseMapUpdateProtocol('{"status":"updated","current_version":"3.28.1","installed_version":"3.29.0","reload_current_skill":true}\n');
    expect(mapUpdateVersionMatches(updated, "3.28.1", "3.29.0")).toBe(true);
    expect(mapUpdateVersionMatches(updated, "3.27.0", "3.29.0")).toBe(false);
    expect(mapUpdateVersionMatches(updated, "3.28.1", "3.30.0")).toBe(false);
  });

  it("classifies an isolated wheel candidate without executing candidate code online", () => {
    const current = createMapCandidateProtocol("3.28.1", "3.28.1");
    const minor = createMapCandidateProtocol("3.28.1", "3.29.0");
    const major = createMapCandidateProtocol("3.28.1", "4.0.0");
    const downgrade = createMapCandidateProtocol("3.28.1", "3.27.9");
    expect(current.status).toBe("current");
    expect(minor).toMatchObject({ status: "updated", installed_version: "3.29.0" });
    expect(major).toMatchObject({ status: "major_available", major: { version: "4.0.0" } });
    expect(downgrade).toMatchObject({ status: "error" });
    expect(mapUpdateVersionMatches(major, "3.28.1", "4.0.0")).toBe(true);
    expect(mapUpdateVersionMatches(major, "3.28.1", "3.28.1")).toBe(false);
  });

  it("preserves the official error message even when the updater exits nonzero", () => {
    expect(interpretMapUpdateExecution(
      '{"status":"error","current_version":"3.28.1","message":"signature failed","reload_current_skill":false}\n',
      1,
    )).toMatchObject({
      protocol: { status: "error", message: "signature failed" },
      protocolError: "signature failed",
      exitedCleanly: false,
    });
  });
});
