#!/usr/bin/env node
import { createHash } from "node:crypto";
import {
  chmodSync,
  constants,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import {
  fingerprintMapRuntimeToolTree,
  verifyInstalledMapProfile,
} from "./map-admin.js";
import {
  classifyMapUpdateCandidateFromEvidence,
  createMapCandidateProtocol,
  createMapPackageInstallArguments,
  createMapToolListArguments,
  createMapUpdateIsolation,
  createMapUpdateSandboxCommand,
  inspectMapCandidateDistributionMetadata,
  isolatedPythonArguments,
  mapUpdateVersionMatches,
  mapCandidateToolIdentitiesMatch,
  type MapCandidateToolIdentity,
  parseMapUvInstallVersion,
  parseMapUvToolListVersion,
  profileFilesFingerprint,
  sanitizeUpdaterEnvironment,
} from "./map-update.js";

const projectRoot = resolve(process.argv[3] ?? process.argv[2] ?? ".");
const mode = process.argv[2] === "candidate" ? "candidate" : null;
if (mode === null) throw new Error("usage: map-update-cli candidate <project-root>");

const before = verifyInstalledMapProfile(projectRoot);
const activeMapifyPath = before.runtimeTool.executablePath;
const activeUvPath = before.updateTool.executablePath;
const trustedUpdaterEnvironment = sanitizeUpdaterEnvironment(process.env);
const activeMapifyRealPath = realpathSync(activeMapifyPath);
const activeToolRoot = before.runtimeTool.toolRoot;
const activePythonPath = join(activeToolRoot, "bin/python");
const activeRelativePath = relative(activeToolRoot, activeMapifyRealPath);
if (activeRelativePath !== join("bin", "mapify") ||
    basename(activeToolRoot) !== "mapify-cli" ||
    basename(dirname(activeToolRoot)) !== "tools" ||
    basename(dirname(dirname(activeToolRoot))) !== "uv") {
  throw new Error("MAP update supports only the verified uv-tool mapify-cli installation");
}
const captureActiveCli = () => {
  const versionResult = spawnSync(
    activePythonPath,
    isolatedPythonArguments([activeMapifyRealPath, "--version"]),
    {
    encoding: "utf8",
    shell: false,
    env: trustedUpdaterEnvironment,
    },
  );
  const version = versionResult.status === 0
    ? versionResult.stdout.match(/\b(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)\b/u)?.[1] ?? null
    : null;
  if (version === null) throw new Error("active MAP CLI version is unavailable");
  return {
    commandPath: activeMapifyPath,
    realPath: realpathSync(activeMapifyPath),
    version,
    toolTreeSha256: fingerprintMapRuntimeToolTree(activeToolRoot),
  };
};

const activeCliBefore = captureActiveCli();
if (activeCliBefore.version !== before.version || activeCliBefore.version !== before.runtimeTool.version ||
    activeCliBefore.toolTreeSha256 !== before.runtimeTool.toolTreeSha256) {
  throw new Error("active MAP CLI version does not match the installed project profile");
}
const candidateRoot = mkdtempSync(join(tmpdir(), "agent-collab-map-update-"));
const isolation = createMapUpdateIsolation(trustedUpdaterEnvironment, candidateRoot);
const isolatedUpdaterDirectory = join(candidateRoot, ".map-update-runtime", "updater");
for (const directory of [
  isolatedUpdaterDirectory,
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
const run = (
  file: string,
  args: string[],
  cwd = candidateRoot,
  networkMode: "offline" | "package_download" = "offline",
) => {
  const sandbox = createMapUpdateSandboxCommand({
    sandboxExecutable: before.sandboxTool.executablePath,
    candidateRoot,
    pythonRealPath: before.runtimeTool.pythonRealPath,
    file,
    args,
    cwd,
    environment: isolation.environment,
    networkMode,
  });
  return spawnSync(sandbox.file, sandbox.args, {
    cwd: sandbox.cwd,
    encoding: "utf8",
    shell: false,
    timeout: 120_000,
    env: sandbox.environment,
  });
};
const isolatedUv = join(isolatedUpdaterDirectory, "uv");
copyFileSync(activeUvPath, isolatedUv, constants.COPYFILE_EXCL);
chmodSync(isolatedUv, 0o700);
const canonicalRegularFileSha256 = (path: string, label: string): string => {
  const metadata = lstatSync(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || realpathSync(path) !== path) {
    throw new Error(`${label} must be a canonical regular file`);
  }
  return createHash("sha256").update(readFileSync(path)).digest("hex");
};
const assertIsolatedUvIdentity = (): string => {
  const digest = canonicalRegularFileSha256(isolatedUv, "candidate-local uv");
  if (digest !== before.updateTool.executableSha256 || (lstatSync(isolatedUv).mode & 0o111) === 0) {
    throw new Error("candidate-local uv does not match the checked-in update-tool identity");
  }
  return digest;
};
const isolatedUvSha256 = assertIsolatedUvIdentity();
const activeUvVersionResult = run(isolatedUv, ["--version"]);
const activeUvVersion = activeUvVersionResult.status === 0
  ? activeUvVersionResult.stdout.match(/^uv (\d+\.\d+\.\d+)\s*$/u)?.[1] ?? null
  : null;
if (activeUvVersion !== before.updateTool.version) {
  throw new Error("active uv version does not match the checked-in update-tool identity");
}
const manifest = JSON.parse(readFileSync(join(projectRoot, ".map/mapify.lock.json"), "utf8")) as {
  entries: Array<{ dest: string }>;
};
const isolatedToolRoot = join(isolation.toolDirectory, "mapify-cli");
const isolatedPython = join(isolatedToolRoot, "bin/python");
const isolatedMapify = join(isolatedToolRoot, "bin/mapify");
const isolatedPublishedMapify = join(isolation.binDirectory, "mapify");
const isolatedUvReceipt = join(isolatedToolRoot, "uv-receipt.toml");
const copied = new Set([
  ...manifest.entries.map(({ dest }) => dest),
  ".map/mapify.lock.json",
  ".map/config.yaml",
  ".agents/skills/map-learn/SKILL.md",
  ".codex/hooks/agent-collab-map-gate.py",
]);
const currentProtected = new Set([
  ...copied,
  "docs/evidence-gated-flow-v1/map-profile-lock.json",
]);
const currentProfileFingerprintBefore = profileFilesFingerprint(projectRoot, [...currentProtected]);
for (const relativePath of [...copied].sort()) {
  const source = join(projectRoot, relativePath);
  const target = join(candidateRoot, relativePath);
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  copyFileSync(source, target);
}

const packageInstallArguments = createMapPackageInstallArguments(before.runtimeTool.pythonRealPath);
const update = run(isolatedUv, packageInstallArguments, candidateRoot, "package_download");
const toolListArguments = createMapToolListArguments();
let toolList: ReturnType<typeof run> | null = null;
let selectedVersionFromInstall: string | null = null;
let selectedVersionFromToolList: string | null = null;
let selectedVersion: string | null = null;
let selectionError: string | null = null;
let candidateToolIdentityBeforeExecution: MapCandidateToolIdentity | null = null;
const captureCandidateToolIdentity = (version: string) => {
  const mapifyMetadata = lstatSync(isolatedMapify);
  if (!mapifyMetadata.isFile() || mapifyMetadata.isSymbolicLink() ||
      realpathSync(isolatedMapify) !== isolatedMapify || (mapifyMetadata.mode & 0o111) === 0) {
    throw new Error("candidate mapify executable must be a canonical executable file");
  }
  const publishedMapifyMetadata = lstatSync(isolatedPublishedMapify);
  if (!publishedMapifyMetadata.isSymbolicLink() ||
      readlinkSync(isolatedPublishedMapify) !== isolatedMapify ||
      realpathSync(isolatedPublishedMapify) !== isolatedMapify) {
    throw new Error("candidate published mapify entry point must target the canonical tool executable");
  }
  const pythonLinkMetadata = lstatSync(isolatedPython);
  if (!pythonLinkMetadata.isFile() && !pythonLinkMetadata.isSymbolicLink()) {
    throw new Error("candidate Python entry point must be a file or symbolic link");
  }
  const pythonRealPath = realpathSync(isolatedPython);
  const pythonMetadata = lstatSync(pythonRealPath);
  const pythonSha256 = canonicalRegularFileSha256(pythonRealPath, "candidate Python runtime");
  if (pythonRealPath !== before.runtimeTool.pythonRealPath ||
      pythonSha256 !== before.runtimeTool.pythonSha256 || (pythonMetadata.mode & 0o111) === 0) {
    throw new Error("candidate Python runtime does not match the profile-locked runtime");
  }
  const distribution = inspectMapCandidateDistributionMetadata(isolatedToolRoot, version);
  return {
    toolTreeSha256: fingerprintMapRuntimeToolTree(isolatedToolRoot),
    uvReceiptSha256: canonicalRegularFileSha256(isolatedUvReceipt, "candidate uv receipt"),
    distributionMetadataPath: distribution.path,
    distributionMetadataSha256: distribution.sha256,
    mapifyExecutableSha256: canonicalRegularFileSha256(isolatedMapify, "candidate mapify executable"),
    publishedMapifyLinkTarget: readlinkSync(isolatedPublishedMapify),
    pythonRealPath,
    pythonSha256,
  };
};
try {
  if (update.status !== 0) {
    throw new Error(`pinned uv package download exited with status ${update.status ?? "unknown"}`);
  }
  selectedVersionFromInstall = parseMapUvInstallVersion(update.stderr);
  assertIsolatedUvIdentity();
  toolList = run(isolatedUv, toolListArguments);
  if (toolList.status !== 0) {
    throw new Error(`pinned uv offline tool list exited with status ${toolList.status ?? "unknown"}`);
  }
  selectedVersionFromToolList = parseMapUvToolListVersion(
    toolList.stdout,
    isolatedToolRoot,
    isolatedPublishedMapify,
  );
  if (selectedVersionFromInstall !== selectedVersionFromToolList) {
    throw new Error("pinned uv install and tool-list reports selected different MAP versions");
  }
  candidateToolIdentityBeforeExecution = captureCandidateToolIdentity(selectedVersionFromInstall);
  selectedVersion = selectedVersionFromInstall;
} catch (error) {
  selectionError = error instanceof Error ? error.message : String(error);
}
const packageInstalled = selectedVersion !== null &&
  existsSync(isolatedMapify) && existsSync(isolatedPython);
const installKindProbe = packageInstalled
  ? run(isolatedPython, isolatedPythonArguments(["-c", [
    "import mapify_cli",
    "from mapify_cli.update_install import detect_install_kind",
    "print(detect_install_kind(mapify_cli.__file__).value)",
  ].join(";")]))
  : null;
const detectedInstallKind = installKindProbe?.status === 0 ? installKindProbe.stdout.trim() : null;
if (packageInstalled && detectedInstallKind !== "uv-tool") {
  throw new Error(`isolated MAP updater is not detected as uv-tool: ${detectedInstallKind ?? installKindProbe?.stderr}`);
}
const candidateCli = packageInstalled
  ? run(isolatedPython, isolatedPythonArguments([isolatedMapify, "--version"]))
  : null;
const candidateCliVersion = candidateCli?.status === 0
  ? candidateCli.stdout.match(/\b(\d+\.\d+\.\d+)\b/u)?.[1] ?? null
  : null;
let protocolError: string | null = null;
let protocol: ReturnType<typeof createMapCandidateProtocol> | null = null;
try {
  if (selectionError !== null || selectedVersion === null) {
    protocolError = selectionError ?? "pinned uv did not select a MAP candidate version";
  } else if (candidateCliVersion === null) {
    protocolError = "installed MAP candidate version is unavailable";
  } else {
    protocol = createMapCandidateProtocol(before.version, selectedVersion);
    if (protocol.status === "error") protocolError = protocol.message ?? "MAP candidate version is invalid";
  }
} catch (error) {
  protocolError = error instanceof Error ? error.message : String(error);
}
const checkable = protocol !== null && protocol.status !== "error";
const refreshed = checkable
  ? run(isolatedPython, isolatedPythonArguments([
    isolatedMapify, "init", ".", "--force", "--no-git", "--provider", "codex", "--refresh-existing",
  ]))
  : null;
const installed = refreshed?.status === 0
  ? run(isolatedPython, isolatedPythonArguments([isolatedMapify, "check-installed", candidateRoot]))
  : null;
const readiness = refreshed?.status === 0
  ? run(isolatedPython, isolatedPythonArguments([isolatedMapify, "check"]), candidateRoot)
  : null;
const afterManifestPath = join(candidateRoot, ".map/mapify.lock.json");
const afterManifestSha256 = createHash("sha256")
  .update(readFileSync(afterManifestPath))
  .digest("hex");
const candidateFileSha256 = (relativePath: string): string => createHash("sha256")
  .update(readFileSync(join(candidateRoot, relativePath)))
  .digest("hex");
const candidateManifest = JSON.parse(readFileSync(afterManifestPath, "utf8")) as { mapify_version?: unknown };
const candidateVersion = typeof candidateManifest.mapify_version === "string"
  ? candidateManifest.mapify_version
  : null;
const versionMatches = mapUpdateVersionMatches(protocol, before.version, candidateVersion);
const candidateCliVersionMatches = candidateCliVersion !== null &&
  selectedVersion !== null && candidateCliVersion === selectedVersion;
let candidateToolIdentityCompleted: typeof candidateToolIdentityBeforeExecution = null;
let candidateToolIdentityError: string | null = null;
try {
  if (selectedVersion !== null) {
    assertIsolatedUvIdentity();
    candidateToolIdentityCompleted = captureCandidateToolIdentity(selectedVersion);
  }
} catch (error) {
  candidateToolIdentityError = error instanceof Error ? error.message : String(error);
}
const candidateToolIdentityMatches = candidateToolIdentityBeforeExecution !== null &&
  mapCandidateToolIdentitiesMatch(
    candidateToolIdentityBeforeExecution,
    candidateToolIdentityCompleted,
  );
const currentProfileFingerprintAfter = profileFilesFingerprint(projectRoot, [...currentProtected]);
let currentProfileVerificationError: string | null = null;
let currentProfileVerified = false;
try {
  const after = verifyInstalledMapProfile(projectRoot);
  currentProfileVerified = after.profileLockSha256 === before.profileLockSha256;
  if (!currentProfileVerified) currentProfileVerificationError = "verified MAP profile lock changed during update";
} catch (error) {
  currentProfileVerificationError = error instanceof Error ? error.message : String(error);
}
const currentProfileMutated = currentProfileFingerprintAfter !== currentProfileFingerprintBefore ||
  !currentProfileVerified;
let activeCliAfter: ReturnType<typeof captureActiveCli> | null = null;
let activeCliVerificationError: string | null = null;
try {
  activeCliAfter = captureActiveCli();
} catch (error) {
  activeCliVerificationError = error instanceof Error ? error.message : String(error);
}
const currentCliMutated = activeCliAfter === null ||
  activeCliAfter.version !== activeCliBefore.version ||
  activeCliAfter.realPath !== activeCliBefore.realPath ||
  activeCliAfter.toolTreeSha256 !== activeCliBefore.toolTreeSha256;
const status = classifyMapUpdateCandidateFromEvidence(protocol, {
  activeVersion: before.version,
  candidateManifestVersion: candidateVersion,
  candidateCliVersion,
  selectedVersion,
  selectedVersionFromInstall,
  selectedVersionFromToolList,
  updateExitCode: update.status,
  toolListExitCode: toolList?.status ?? null,
  providerRefreshExitCode: refreshed?.status ?? null,
  checkInstalledExitCode: installed?.status ?? null,
  readinessExitCode: readiness?.status ?? null,
  installKind: detectedInstallKind,
  toolIdentityBeforeExecution: candidateToolIdentityBeforeExecution,
  completedToolIdentity: candidateToolIdentityCompleted,
  currentProfileMutated,
  currentCliMutated,
});
const receipt = {
  schemaVersion: "map-update-candidate/v2",
  status,
  currentProfileMutated,
  currentCliMutated,
  activeCliVerificationError,
  activeCliBefore,
  activeCliAfter,
  currentProfileVerified,
  currentProfileVerificationError,
  currentProfileFingerprintBefore,
  currentProfileFingerprintAfter,
  rollback: "discard_candidate_directory",
  candidateRoot,
  isolatedUpdater: {
    sandbox: before.sandboxTool,
    sandboxPolicy: "bubblewrap-ro-host-candidate-write-network-split-v2",
    networkAuthority: {
      onlineExecutable: isolatedUv,
      onlineArguments: packageInstallArguments,
      offlineToolListArguments: toolListArguments,
      candidateCodeNetwork: "offline",
    },
    installMethod: detectedInstallKind,
    uvPath: isolatedUv,
    uvSha256: isolatedUvSha256,
    uvVersion: activeUvVersion,
    toolDirectory: isolation.toolDirectory,
    binDirectory: isolation.binDirectory,
    cacheDirectory: isolation.cacheDirectory,
    pythonDirectory: isolation.pythonDirectory,
  },
  before: {
    version: before.version,
    sourceRevision: before.sourceRevision,
    sourceArchiveSha256: before.sourceArchiveSha256,
    mapManifestSha256: before.mapManifestSha256,
    mapConfigSha256: before.mapConfigSha256,
    profileLockSha256: before.profileLockSha256,
    managedFileSha256: before.managedFileSha256,
    outsideScopeSha256: before.outsideScopeSha256,
  },
  candidate: {
    selectedVersion,
    selectedVersionAuthority: "pinned-native-uv-install-plus-offline-tool-list-plus-dist-metadata",
    selectedVersionFromInstall,
    selectedVersionFromToolList,
    selectionError,
    uvInstallReportSha256: createHash("sha256").update(update.stderr).digest("hex"),
    uvToolListSha256: toolList === null
      ? null
      : createHash("sha256").update(toolList.stdout).digest("hex"),
    toolIdentityBeforeExecution: candidateToolIdentityBeforeExecution,
    completedToolIdentity: candidateToolIdentityCompleted,
    toolIdentityMatches: candidateToolIdentityMatches,
    toolIdentityError: candidateToolIdentityError,
    mapManifestSha256: afterManifestSha256,
    mapConfigSha256: candidateFileSha256(".map/config.yaml"),
    outsideScopeSha256: {
      ".agents/skills/map-learn/SKILL.md": candidateFileSha256(".agents/skills/map-learn/SKILL.md"),
      ".codex/hooks/agent-collab-map-gate.py": candidateFileSha256(".codex/hooks/agent-collab-map-gate.py"),
    },
    version: candidateVersion,
    cliVersion: candidateCliVersion,
    cliVersionMatches: candidateCliVersionMatches,
    protocolStatus: protocol?.status ?? null,
    protocolError,
    offeredMajorVersion: protocol?.major?.version ?? null,
    updateExitCode: update.status,
    toolListExitCode: toolList?.status ?? null,
    providerRefreshExitCode: refreshed?.status ?? null,
    checkInstalledExitCode: installed?.status ?? null,
    readinessExitCode: readiness?.status ?? null,
  },
  promotionRequirements: [
    "verify upstream source revision and distribution hash",
    "review the exact managed-file diff",
    "review the isolated mapify-cli target and install it globally only after approval",
    "recompute the completed candidate tool-tree, uv receipt, distribution metadata, mapify executable, and Python identity immediately before promotion",
    "renew map-profile-lock.json including outside-scope adapter digests",
    "run focused tests and three independent audits before replacing current managed bytes",
  ],
};
const receiptPath = join(candidateRoot, "map-update-candidate-receipt.json");
writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
console.log(JSON.stringify({ ...receipt, receiptPath }, null, 2));
if (receipt.status === "CANDIDATE_REJECTED") process.exitCode = 1;
if (receipt.status === "MAJOR_APPROVAL_REQUIRED") process.exitCode = 2;
