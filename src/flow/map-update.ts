import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { dirname, delimiter, join, resolve, sep } from "node:path";
import { z } from "zod";

const VersionSchema = z.string().regex(/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u);
const StableVersionSchema = z.string().regex(/^\d+\.\d+\.\d+$/u);
const MAP_PACKAGE_INDEX = "https://pypi.org/simple";
const SYSTEM_EXECUTABLE_PATH = [
  "/usr/local/sbin",
  "/usr/local/bin",
  "/usr/sbin",
  "/usr/bin",
  "/sbin",
  "/bin",
].join(delimiter);
const MajorSchema = z.object({
  version: VersionSchema,
  title: z.string(),
  body: z.string(),
  url: z.string(),
}).strict();

const MapUpdateProtocolSchema = z.object({
  status: z.enum(["current", "skipped", "updated", "major_available", "error"]),
  current_version: VersionSchema,
  installed_version: VersionSchema.optional(),
  message: z.string().optional(),
  refreshed_providers: z.array(z.string().min(1)).optional(),
  reload_current_skill: z.boolean(),
  major: MajorSchema.optional(),
}).strict().superRefine((value, context) => {
  if (value.status === "updated" && value.installed_version === undefined) {
    context.addIssue({ code: "custom", message: "updated MAP result requires installed_version" });
  }
  if (value.status === "major_available" && value.major === undefined) {
    context.addIssue({ code: "custom", message: "major_available MAP result requires major metadata" });
  }
  if (value.status !== "major_available" && value.major !== undefined) {
    context.addIssue({ code: "custom", message: "major metadata is allowed only for major_available" });
  }
});

export type MapUpdateProtocol = z.infer<typeof MapUpdateProtocolSchema>;
export type MapUpdateCandidateStatus =
  | "CANDIDATE_READY_FOR_REVIEW"
  | "CURRENT_PROFILE_VERIFIED"
  | "MAJOR_APPROVAL_REQUIRED"
  | "CANDIDATE_REJECTED";

export interface MapUpdateExecution {
  protocol: MapUpdateProtocol | null;
  protocolError: string | null;
  exitedCleanly: boolean;
}

export interface MapUpdateIsolation {
  environment: NodeJS.ProcessEnv;
  toolDirectory: string;
  binDirectory: string;
  cacheDirectory: string;
  pythonDirectory: string;
  homeDirectory: string;
  temporaryDirectory: string;
  configDirectory: string;
  dataDirectory: string;
}

export interface MapUpdateSandboxCommand {
  file: string;
  args: string[];
  cwd: string;
  environment: NodeJS.ProcessEnv;
}

export type MapUpdateNetworkMode = "offline" | "package_download";

export interface MapCandidateDistributionMetadata {
  path: string;
  version: string;
  sha256: string;
}

export interface MapCandidateToolIdentity {
  toolTreeSha256: string;
  uvReceiptSha256: string;
  distributionMetadataPath: string;
  distributionMetadataSha256: string;
  mapifyExecutableSha256: string;
  publishedMapifyLinkTarget: string;
  pythonRealPath: string;
  pythonSha256: string;
}

export interface MapCandidateVerificationEvidence {
  activeVersion: string;
  candidateManifestVersion: string | null;
  candidateCliVersion: string | null;
  selectedVersion: string | null;
  selectedVersionFromInstall: string | null;
  selectedVersionFromToolList: string | null;
  updateExitCode: number | null;
  toolListExitCode: number | null;
  providerRefreshExitCode: number | null;
  checkInstalledExitCode: number | null;
  readinessExitCode: number | null;
  installKind: string | null;
  toolIdentityBeforeExecution: MapCandidateToolIdentity | null;
  completedToolIdentity: MapCandidateToolIdentity | null;
  currentProfileMutated: boolean;
  currentCliMutated: boolean;
}

export function sanitizeUpdaterEnvironment(
  _baseEnvironment: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  return {};
}

export function isolatedPythonArguments(arguments_: readonly string[]): string[] {
  return ["-I", "-B", ...arguments_];
}

export function createMapPackageInstallArguments(pythonRealPath: string): string[] {
  return [
    "tool", "install",
    "--force",
    "--refresh",
    "--no-build",
    "--no-sources",
    "--no-config",
    "--keyring-provider", "disabled",
    "--resolution", "highest",
    "--prerelease", "disallow",
    "--default-index", MAP_PACKAGE_INDEX,
    "--python", pythonRealPath,
    "--no-python-downloads",
    "--link-mode", "copy",
    "--color", "never",
    "--no-progress",
    "mapify-cli",
  ];
}

export function createMapToolListArguments(): string[] {
  return [
    "tool", "list",
    "--show-paths",
    "--show-version-specifiers",
    "--offline",
    "--no-config",
    "--color", "never",
  ];
}

function assertBoundedNativeUvOutput(output: string, label: string): void {
  const size = Buffer.byteLength(output, "utf8");
  if (size === 0 || size > 64 * 1024 || output.includes("\r")) {
    throw new Error(`${label} must be bounded canonical UTF-8 output`);
  }
}

export function parseMapUvInstallVersion(stderr: string): string {
  assertBoundedNativeUvOutput(stderr, "pinned uv install report");
  const versions = stderr.split("\n").flatMap((line) => {
    const match = line.match(/^ [~+] mapify-cli==(\d+\.\d+\.\d+)$/u);
    return match === null ? [] : [StableVersionSchema.parse(match[1])];
  });
  if (versions.length !== 1) {
    throw new Error("pinned uv install report must contain exactly one mapify-cli version");
  }
  return versions[0]!;
}

export function parseMapUvToolListVersion(
  stdout: string,
  expectedToolRoot: string,
  expectedBinPath: string,
): string {
  assertBoundedNativeUvOutput(stdout, "pinned uv tool-list report");
  const lines = stdout.split("\n");
  if (lines.at(-1) === "") lines.pop();
  const firstLine = lines[0]?.match(/^mapify-cli v(\d+\.\d+\.\d+) \((.+)\)$/u);
  if (lines.length !== 2 || firstLine === undefined || firstLine === null) {
    throw new Error("pinned uv tool-list report must contain one canonical mapify-cli entry");
  }
  const version = StableVersionSchema.parse(firstLine[1]);
  if (lines[0] !== `mapify-cli v${version} (${expectedToolRoot})` ||
      lines[1] !== `- mapify (${expectedBinPath})`) {
    throw new Error("pinned uv tool-list report does not match the canonical mapify-cli entry");
  }
  return version;
}

function parseMapDistributionMetadataVersion(metadata: string): string {
  const size = Buffer.byteLength(metadata, "utf8");
  if (size === 0 || size > 256 * 1024 || metadata.includes("\r")) {
    throw new Error("mapify-cli distribution metadata must be bounded canonical UTF-8");
  }
  const names = metadata.split("\n").filter((line) => line.startsWith("Name: "));
  const versions = metadata.split("\n").filter((line) => line.startsWith("Version: "));
  if (names.length !== 1 || names[0] !== "Name: mapify-cli" || versions.length !== 1) {
    throw new Error("mapify-cli distribution metadata must contain one exact name and version");
  }
  return StableVersionSchema.parse(versions[0]!.slice("Version: ".length));
}

export function inspectMapCandidateDistributionMetadata(
  toolRootInput: string,
  expectedVersion: string,
): MapCandidateDistributionMetadata {
  const version = StableVersionSchema.parse(expectedVersion);
  const toolRoot = resolve(toolRootInput);
  if (toolRoot !== toolRootInput || !existsSync(toolRoot) || !lstatSync(toolRoot).isDirectory() ||
      lstatSync(toolRoot).isSymbolicLink() || realpathSync(toolRoot) !== toolRoot) {
    throw new Error("candidate mapify-cli tool root must be a canonical absolute directory");
  }
  const libRoot = join(toolRoot, "lib");
  if (!existsSync(libRoot) || !lstatSync(libRoot).isDirectory() ||
      lstatSync(libRoot).isSymbolicLink() || realpathSync(libRoot) !== libRoot) {
    throw new Error("candidate mapify-cli lib root must be a canonical directory");
  }
  const metadataPaths: string[] = [];
  for (const pythonEntry of readdirSync(libRoot, { withFileTypes: true })) {
    if (!/^python\d+\.\d+$/u.test(pythonEntry.name)) continue;
    const pythonDirectory = join(libRoot, pythonEntry.name);
    if (!pythonEntry.isDirectory() || lstatSync(pythonDirectory).isSymbolicLink() ||
        realpathSync(pythonDirectory) !== pythonDirectory) {
      throw new Error("candidate mapify-cli Python library root must be canonical");
    }
    const sitePackages = join(pythonDirectory, "site-packages");
    if (!existsSync(sitePackages)) continue;
    if (!lstatSync(sitePackages).isDirectory() || lstatSync(sitePackages).isSymbolicLink() ||
        realpathSync(sitePackages) !== sitePackages) {
      throw new Error("candidate mapify-cli site-packages root must be canonical");
    }
    for (const distribution of readdirSync(sitePackages, { withFileTypes: true })) {
      if (!/^mapify_cli-.+\.dist-info$/u.test(distribution.name)) continue;
      const distributionRoot = join(sitePackages, distribution.name);
      if (!distribution.isDirectory() || lstatSync(distributionRoot).isSymbolicLink() ||
          realpathSync(distributionRoot) !== distributionRoot) {
        throw new Error("candidate mapify-cli distribution root must be canonical");
      }
      metadataPaths.push(join(distributionRoot, "METADATA"));
    }
  }
  if (metadataPaths.length !== 1) {
    throw new Error("candidate tool tree must contain exactly one mapify-cli distribution");
  }
  const path = metadataPaths[0]!;
  if (!existsSync(path) || !lstatSync(path).isFile() || lstatSync(path).isSymbolicLink() ||
      realpathSync(path) !== path) {
    throw new Error("candidate mapify-cli METADATA must be a canonical regular file");
  }
  const bytes = readFileSync(path);
  const metadataVersion = parseMapDistributionMetadataVersion(bytes.toString("utf8"));
  if (metadataVersion !== version || !path.endsWith(`/mapify_cli-${version}.dist-info/METADATA`)) {
    throw new Error("candidate distribution metadata version does not match pinned uv selection");
  }
  return {
    path,
    version: metadataVersion,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

function stableVersionParts(version: string): readonly [number, number, number] {
  const parsed = StableVersionSchema.parse(version).split(".").map(Number);
  return [parsed[0]!, parsed[1]!, parsed[2]!];
}

function compareStableVersions(left: readonly number[], right: readonly number[]): number {
  for (let index = 0; index < 3; index += 1) {
    if (left[index]! !== right[index]!) return left[index]! - right[index]!;
  }
  return 0;
}

export function createMapCandidateProtocol(
  currentVersion: string,
  candidateVersion: string,
): MapUpdateProtocol {
  const current = stableVersionParts(currentVersion);
  const candidate = stableVersionParts(candidateVersion);
  const comparison = compareStableVersions(candidate, current);
  if (comparison < 0) {
    return {
      status: "error",
      current_version: currentVersion,
      message: `candidate MAP ${candidateVersion} is older than active MAP ${currentVersion}`,
      reload_current_skill: false,
    };
  }
  if (comparison === 0) {
    return { status: "current", current_version: currentVersion, reload_current_skill: false };
  }
  if (candidate[0] === current[0]) {
    return {
      status: "updated",
      current_version: currentVersion,
      installed_version: candidateVersion,
      reload_current_skill: true,
    };
  }
  return {
    status: "major_available",
    current_version: currentVersion,
    reload_current_skill: false,
    major: {
      version: candidateVersion,
      title: `MAP ${candidateVersion} isolated candidate`,
      body: "Downloaded as wheels into a disposable candidate; approval and independent review are required before promotion.",
      url: `https://pypi.org/project/mapify-cli/${candidateVersion}/`,
    },
  };
}

export function createMapUpdateIsolation(
  baseEnvironment: NodeJS.ProcessEnv,
  candidateRoot: string,
): MapUpdateIsolation {
  const root = resolve(candidateRoot);
  if (root !== candidateRoot) throw new Error("MAP update candidate root must be canonical and absolute");
  const isolationRoot = join(root, ".map-update-runtime");
  const uvRoot = join(isolationRoot, "uv");
  const toolDirectory = join(uvRoot, "tools");
  const binDirectory = join(uvRoot, "bin");
  const cacheDirectory = join(uvRoot, "cache");
  const pythonDirectory = join(uvRoot, "python");
  const homeDirectory = join(isolationRoot, "home");
  const temporaryDirectory = join(isolationRoot, "tmp");
  const configDirectory = join(isolationRoot, "xdg-config");
  const dataDirectory = join(isolationRoot, "xdg-data");
  const environment = sanitizeUpdaterEnvironment(baseEnvironment);
  return {
    environment: {
      ...environment,
      UV_TOOL_DIR: toolDirectory,
      UV_TOOL_BIN_DIR: binDirectory,
      UV_CACHE_DIR: cacheDirectory,
      UV_PYTHON_INSTALL_DIR: pythonDirectory,
      UV_NO_CONFIG: "1",
      PYTHONDONTWRITEBYTECODE: "1",
      PIPX_HOME: join(isolationRoot, "pipx"),
      PIPX_BIN_DIR: binDirectory,
      HOME: homeDirectory,
      TMPDIR: temporaryDirectory,
      XDG_CONFIG_HOME: configDirectory,
      XDG_DATA_HOME: dataDirectory,
      XDG_CACHE_HOME: cacheDirectory,
      LANG: "C.UTF-8",
      LC_ALL: "C.UTF-8",
      PATH: `${binDirectory}${delimiter}${SYSTEM_EXECUTABLE_PATH}`,
    },
    toolDirectory,
    binDirectory,
    cacheDirectory,
    pythonDirectory,
    homeDirectory,
    temporaryDirectory,
    configDirectory,
    dataDirectory,
  };
}

function isContainedPath(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${sep}`);
}

export function createMapUpdateSandboxCommand(input: {
  sandboxExecutable: string;
  candidateRoot: string;
  pythonRealPath: string;
  file: string;
  args: readonly string[];
  cwd: string;
  environment: NodeJS.ProcessEnv;
  networkMode: MapUpdateNetworkMode;
}): MapUpdateSandboxCommand {
  const candidateRoot = resolve(input.candidateRoot);
  const cwd = resolve(input.cwd);
  const file = resolve(input.file);
  if (candidateRoot !== input.candidateRoot || realpathSync(candidateRoot) !== candidateRoot ||
      !lstatSync(candidateRoot).isDirectory()) {
    throw new Error("MAP update sandbox candidate root must be a canonical absolute directory");
  }
  if (!isContainedPath(candidateRoot, cwd) || !isContainedPath(candidateRoot, file)) {
    throw new Error("MAP update sandbox command and cwd must stay inside the candidate root");
  }
  const pythonRealPath = realpathSync(input.pythonRealPath);
  if (pythonRealPath !== input.pythonRealPath || !lstatSync(pythonRealPath).isFile()) {
    throw new Error("MAP update sandbox Python must be a canonical regular file");
  }
  const pythonRoot = dirname(dirname(pythonRealPath));
  const onlineRuntimeArgs = input.networkMode === "package_download"
    ? [
      "--ro-bind", "/etc/ssl", "/etc/ssl",
      "--ro-bind", "/etc/hosts", "/etc/hosts",
      "--ro-bind", "/etc/nsswitch.conf", "/etc/nsswitch.conf",
      "--ro-bind", realpathSync("/etc/resolv.conf"), "/etc/resolv.conf",
    ]
    : [];
  const environmentArgs = Object.entries(input.environment)
    .filter((entry): entry is [string, string] => entry[1] !== undefined)
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .flatMap(([name, value]) => ["--setenv", name, value]);
  return {
    file: input.sandboxExecutable,
    args: [
      "--die-with-parent",
      "--new-session",
      "--unshare-all",
      ...(input.networkMode === "package_download" ? ["--share-net"] : []),
      "--clearenv",
      "--cap-drop", "ALL",
      "--ro-bind", "/usr", "/usr",
      "--symlink", "usr/bin", "/bin",
      "--symlink", "usr/sbin", "/sbin",
      "--symlink", "usr/lib", "/lib",
      "--symlink", "usr/lib64", "/lib64",
      "--dir", "/etc",
      "--ro-bind", "/etc/passwd", "/etc/passwd",
      "--ro-bind", "/etc/group", "/etc/group",
      ...onlineRuntimeArgs,
      "--tmpfs", "/home",
      "--ro-bind", pythonRoot, pythonRoot,
      "--remount-ro", "/home",
      "--tmpfs", "/root",
      "--remount-ro", "/root",
      "--tmpfs", "/tmp",
      "--dir", candidateRoot,
      "--remount-ro", "/tmp",
      "--bind", candidateRoot, candidateRoot,
      "--tmpfs", "/run",
      "--remount-ro", "/run",
      "--proc", "/proc",
      "--dev", "/dev",
      "--chdir", cwd,
      ...environmentArgs,
      "--",
      file,
      ...input.args,
    ],
    cwd: candidateRoot,
    environment: {},
  };
}

export function parseMapUpdateProtocol(stdout: string): MapUpdateProtocol {
  if (Buffer.byteLength(stdout, "utf8") === 0 || Buffer.byteLength(stdout, "utf8") > 64 * 1024) {
    throw new Error("MAP update protocol must contain one bounded JSON line");
  }
  const lines = stdout.split("\n");
  if (lines.at(-1) === "") lines.pop();
  if (lines.length !== 1 || lines[0] === "" || lines[0]!.trim() !== lines[0]) {
    throw new Error("MAP update protocol must contain exactly one canonical JSON line");
  }
  let value: unknown;
  try {
    value = JSON.parse(lines[0]!);
  } catch (error) {
    throw new Error(`MAP update protocol JSON is invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
  const parsed = MapUpdateProtocolSchema.safeParse(value);
  if (!parsed.success) throw new Error(`MAP update protocol schema is invalid: ${parsed.error.message}`);
  return parsed.data;
}

export function interpretMapUpdateExecution(
  stdout: string,
  exitStatus: number | null,
): MapUpdateExecution {
  let protocol: MapUpdateProtocol | null = null;
  let protocolError: string | null = null;
  try {
    protocol = parseMapUpdateProtocol(stdout);
  } catch (error) {
    protocolError = error instanceof Error ? error.message : String(error);
  }
  const exitedCleanly = exitStatus === 0;
  if (protocol?.status === "error") {
    protocolError = protocol.message ?? "MAP updater returned an official error result";
  } else if (!exitedCleanly) {
    const statusError = `MAP updater exited with status ${exitStatus ?? "unknown"}`;
    protocolError = protocolError === null ? statusError : `${statusError}: ${protocolError}`;
  }
  return { protocol, protocolError, exitedCleanly };
}

export function mapUpdateVersionMatches(
  protocol: MapUpdateProtocol | null,
  activeVersion: string,
  candidateVersion: string | null,
): boolean {
  if (protocol?.current_version !== activeVersion) return false;
  if (protocol.status === "current") return candidateVersion === activeVersion;
  if (protocol.status === "major_available") return candidateVersion === protocol.major?.version;
  return protocol.status === "updated" && candidateVersion === protocol.installed_version;
}

export function profileFilesFingerprint(root: string, paths: readonly string[]): string {
  const hash = createHash("sha256");
  for (const path of [...paths].sort()) {
    const target = resolve(root, path);
    const metadata = lstatSync(target);
    if (metadata.isSymbolicLink() || !metadata.isFile() || realpathSync(target) !== target) {
      throw new Error(`MAP protected profile path is not a canonical regular file: ${path}`);
    }
    const bytes = readFileSync(target);
    hash.update(`${Buffer.byteLength(path, "utf8")}:`);
    hash.update(path);
    hash.update(`:${metadata.mode & 0o777}:${bytes.length}:`);
    hash.update(bytes);
  }
  return hash.digest("hex");
}

export function classifyMapUpdateCandidate(
  protocol: MapUpdateProtocol | null,
  checksPass: boolean,
): MapUpdateCandidateStatus {
  if (protocol?.status === "updated" && checksPass) return "CANDIDATE_READY_FOR_REVIEW";
  if (protocol?.status === "current" && checksPass) return "CURRENT_PROFILE_VERIFIED";
  if (protocol?.status === "major_available" && checksPass) return "MAJOR_APPROVAL_REQUIRED";
  return "CANDIDATE_REJECTED";
}

export function mapCandidateToolIdentitiesMatch(
  before: MapCandidateToolIdentity | null,
  completed: MapCandidateToolIdentity | null,
): boolean {
  if (before === null || completed === null) return false;
  return before.toolTreeSha256 === completed.toolTreeSha256 &&
    before.uvReceiptSha256 === completed.uvReceiptSha256 &&
    before.distributionMetadataPath === completed.distributionMetadataPath &&
    before.distributionMetadataSha256 === completed.distributionMetadataSha256 &&
    before.mapifyExecutableSha256 === completed.mapifyExecutableSha256 &&
    before.publishedMapifyLinkTarget === completed.publishedMapifyLinkTarget &&
    before.pythonRealPath === completed.pythonRealPath &&
    before.pythonSha256 === completed.pythonSha256;
}

export function classifyMapUpdateCandidateFromEvidence(
  protocol: MapUpdateProtocol | null,
  evidence: MapCandidateVerificationEvidence,
): MapUpdateCandidateStatus {
  const selectedVersionMatches = evidence.selectedVersion !== null &&
    evidence.selectedVersionFromInstall === evidence.selectedVersion &&
    evidence.selectedVersionFromToolList === evidence.selectedVersion;
  const checksPass = evidence.updateExitCode === 0 &&
    evidence.toolListExitCode === 0 &&
    evidence.providerRefreshExitCode === 0 &&
    evidence.checkInstalledExitCode === 0 &&
    evidence.readinessExitCode === 0 &&
    selectedVersionMatches &&
    evidence.candidateCliVersion === evidence.selectedVersion &&
    mapUpdateVersionMatches(protocol, evidence.activeVersion, evidence.candidateManifestVersion) &&
    mapCandidateToolIdentitiesMatch(
      evidence.toolIdentityBeforeExecution,
      evidence.completedToolIdentity,
    ) &&
    evidence.installKind === "uv-tool" &&
    !evidence.currentProfileMutated &&
    !evidence.currentCliMutated;
  return classifyMapUpdateCandidate(protocol, checksPass);
}
