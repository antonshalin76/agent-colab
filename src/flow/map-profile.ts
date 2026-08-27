import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
} from "node:fs";
import {
  isAbsolute,
  join,
  parse,
  posix,
  relative,
  resolve,
  sep,
} from "node:path";
import { z } from "zod";

const MAP_VERSION = "3.28.1";
const MAP_SOURCE_REVISION = "1ba52a77b8228a509f3ef08c4fb1f89465699a73";
const MAP_SOURCE_ARCHIVE_SHA256 = "b5a391a4f892334655a9d5dc0a405020dfb9284dbd9c9ee63b8be78a818bf990";
const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const InstalledAtSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
const ManagementModeSchema = z.enum(["fenced", "full", "hooks-merge"]);

const ManifestEntrySchema = z.object({
  dest: z.string().min(1),
  content_hash: Sha256Schema,
  template_hash: z.union([Sha256Schema, z.literal("")]),
  management_mode: ManagementModeSchema,
  committed: z.boolean(),
  mapify_version: z.string(),
  installed_at: z.string(),
}).strict();

const ConfigEntrySchema = z.object({
  file: z.string().min(1),
  key_path: z.string().min(1),
  installed_at: z.string().min(1),
  mapify_version: z.string().min(1),
}).strict();

const InstallManifestSchema = z.object({
  mapify_version: z.string().min(1),
  provider: z.string().min(1),
  installed_at: InstalledAtSchema,
  entries: z.array(ManifestEntrySchema),
  config_entries: z.array(ConfigEntrySchema),
  providers: z.array(z.string().min(1)),
}).strict();

const OutsideScopeSchema = z.object({
  ".agents/skills/map-learn/SKILL.md": Sha256Schema,
  ".codex/hooks/agent-collab-map-gate.py": Sha256Schema,
}).strict();

const ExpectationSchema = z.object({
  version: z.string().min(1),
  sourceRevision: z.string().regex(/^[a-f0-9]{40}$/),
  sourceArchiveSha256: Sha256Schema,
  provider: z.literal("codex"),
  managedFileSha256: z.record(z.string().min(1), Sha256Schema),
  outsideScopeSha256: OutsideScopeSchema,
}).strict();

const ManagedMetadataSchema = z.object({
  generated_by: z.literal("mapify-cli"),
  mapify_version: z.string().min(1),
  template_hash: Sha256Schema,
  installed_at: InstalledAtSchema,
}).strict();

const OFFICIAL_MANAGEMENT_MODE_BY_DESTINATION = {
  ".agents/skills/map-check/SKILL.md": "fenced",
  ".agents/skills/map-efficient/SKILL.md": "fenced",
  ".agents/skills/map-efficient/efficient-reference.md": "fenced",
  ".agents/skills/map-explain/SKILL.md": "fenced",
  ".agents/skills/map-fast/SKILL.md": "fenced",
  ".agents/skills/map-plan/SKILL.md": "fenced",
  ".agents/skills/map-review/SKILL.md": "fenced",
  ".agents/skills/map-review/adversarial-reference.md": "fenced",
  ".agents/skills/map-review/review-reference.md": "fenced",
  ".agents/skills/map-understand/SKILL.md": "fenced",
  ".agents/skills/map-upgrade/SKILL.md": "fenced",
  ".codex/agents/decomposer.toml": "fenced",
  ".codex/agents/evaluator.toml": "fenced",
  ".codex/agents/monitor.toml": "fenced",
  ".codex/agents/predictor.toml": "fenced",
  ".codex/agents/researcher.toml": "fenced",
  ".codex/config.toml": "fenced",
  ".codex/hooks.json": "hooks-merge",
  ".codex/hooks/workflow-gate.py": "fenced",
  ".map/scripts/classify_scope.py": "full",
  ".map/scripts/diagnostics.py": "full",
  ".map/scripts/map_orchestrator.py": "full",
  ".map/scripts/map_step_runner.py": "full",
  ".map/scripts/map_utils.py": "full",
  ".map/scripts/scrub_internal_ids.py": "full",
  ".map/scripts/sofa_client.py": "full",
  ".map/scripts/validate_spec_citations.py": "full",
  ".map/scripts/wayfind_runner.py": "full",
  "AGENTS.md": "fenced",
} as const satisfies Record<string, z.infer<typeof ManagementModeSchema>>;

const OFFICIAL_DESTINATIONS = Object.keys(OFFICIAL_MANAGEMENT_MODE_BY_DESTINATION).sort();
const OFFICIAL_CODEX_SKILLS = [
  "map-check",
  "map-efficient",
  "map-explain",
  "map-fast",
  "map-plan",
  "map-review",
  "map-understand",
  "map-upgrade",
] as const;
const CODEX_AGENTS = ["decomposer", "evaluator", "monitor", "predictor", "researcher"] as const;
const LOCAL_LEARNING_ADAPTER = ".agents/skills/map-learn/SKILL.md";

export interface MapProfileExpectation {
  version: string;
  sourceRevision: string;
  sourceArchiveSha256: string;
  provider: "codex";
  managedFileSha256: Readonly<Record<string, string>>;
  outsideScopeSha256: Readonly<Record<string, string>>;
}

export interface MapProfileReceipt {
  version: typeof MAP_VERSION;
  sourceRevision: typeof MAP_SOURCE_REVISION;
  sourceArchiveSha256: typeof MAP_SOURCE_ARCHIVE_SHA256;
  provider: "codex";
  profile: "full";
  minimality: "lite";
  updatesAuto: false;
  upstreamSkillInventory: string[];
  managedFileSha256: Record<string, string>;
  outsideScopeSha256: Record<string, string>;
}

type InstallManifest = z.infer<typeof InstallManifestSchema>;
type ManifestEntry = z.infer<typeof ManifestEntrySchema>;
type ManagedMetadata = z.infer<typeof ManagedMetadataSchema>;

function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function sameStrings(actual: readonly string[], expected: readonly string[]): boolean {
  return actual.length === expected.length && actual.every((value, index) => value === expected[index]);
}

function schemaError(label: string, issues: readonly { path: PropertyKey[]; message: string }[]): Error {
  const detail = issues.map((issue) => `${issue.path.join(".") || "root"}: ${issue.message}`).join("; ");
  return new Error(`${label} schema is invalid: ${detail}`);
}

function canonicalRoot(root: string): string {
  const absolute = resolve(root);
  let cursor = parse(absolute).root;
  const suffix = relative(cursor, absolute);
  for (const component of suffix.split(sep).filter(Boolean)) {
    cursor = join(cursor, component);
    if (!existsSync(cursor)) throw new Error(`MAP profile root does not exist: ${absolute}`);
    if (lstatSync(cursor).isSymbolicLink()) {
      throw new Error(`MAP profile root crosses a symbolic link: ${cursor}`);
    }
  }
  if (!lstatSync(absolute).isDirectory()) throw new Error(`MAP profile root is not a directory: ${absolute}`);
  const canonical = realpathSync(absolute);
  if (canonical !== absolute) throw new Error(`MAP profile root is not canonical: ${absolute}`);
  return canonical;
}

function requireSafeRelativePath(candidate: string, label: string): void {
  if (
    candidate.length === 0
    || candidate.includes("\\")
    || candidate.includes("\0")
    || isAbsolute(candidate)
    || /^[A-Za-z]:/u.test(candidate)
    || posix.normalize(candidate) !== candidate
    || candidate.split("/").some((component) => component === "" || component === "." || component === "..")
  ) {
    throw new Error(`${label} must be a canonical safe relative path: ${candidate}`);
  }
}

function requireRegularFile(root: string, relativePath: string, label: string): string {
  requireSafeRelativePath(relativePath, label);
  const target = resolve(root, relativePath);
  const rel = relative(root, target);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`${label} escapes the MAP profile root: ${relativePath}`);
  }
  let cursor = root;
  for (const component of relativePath.split("/")) {
    cursor = join(cursor, component);
    if (!existsSync(cursor)) throw new Error(`${label} is missing: ${relativePath}`);
    const stat = lstatSync(cursor);
    if (stat.isSymbolicLink()) throw new Error(`${label} crosses a symbolic link: ${relativePath}`);
  }
  if (!lstatSync(target).isFile()) throw new Error(`${label} is not a regular file: ${relativePath}`);
  if (realpathSync(target) !== target) throw new Error(`${label} is not canonical: ${relativePath}`);
  return target;
}

function requireDirectory(root: string, relativePath: string, label: string): string {
  requireSafeRelativePath(relativePath, label);
  const target = resolve(root, relativePath);
  let cursor = root;
  for (const component of relativePath.split("/")) {
    cursor = join(cursor, component);
    if (!existsSync(cursor)) throw new Error(`${label} is missing: ${relativePath}`);
    if (lstatSync(cursor).isSymbolicLink()) throw new Error(`${label} crosses a symbolic link: ${relativePath}`);
  }
  if (!lstatSync(target).isDirectory()) throw new Error(`${label} is not a directory: ${relativePath}`);
  return target;
}

function readBytes(root: string, relativePath: string, label: string): Buffer {
  return readFileSync(requireRegularFile(root, relativePath, label));
}

function decodeUtf8(bytes: Uint8Array, label: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`${label} is not valid UTF-8`);
  }
}

function parseManifest(bytes: Uint8Array): InstallManifest {
  let value: unknown;
  try {
    value = JSON.parse(decodeUtf8(bytes, "MAP manifest"));
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error(`MAP manifest JSON is invalid: ${error.message}`);
    throw error;
  }
  const parsed = InstallManifestSchema.safeParse(value);
  if (!parsed.success) throw schemaError("MAP manifest", parsed.error.issues);
  return parsed.data;
}

function parseExpectation(expectation: MapProfileExpectation): z.infer<typeof ExpectationSchema> {
  const parsed = ExpectationSchema.safeParse(expectation);
  if (!parsed.success) throw schemaError("MAP profile expectation", parsed.error.issues);
  return parsed.data;
}

function metadataLineIndex(lines: readonly string[], extension: string): number {
  if (extension === ".md" && lines[0]?.replace(/\r$/u, "") === "---") {
    const closing = lines.findIndex((line, index) => index > 0 && line.replace(/\r$/u, "") === "---");
    if (closing < 0) throw new Error("managed Markdown has unterminated frontmatter");
    return closing + 1;
  }
  if ([".py", ".sh", ".bash"].includes(extension) && lines[0]?.startsWith("#!")) return 1;
  return 0;
}

function extractManagedMetadata(content: string, destination: string): {
  metadata: ManagedMetadata;
  cleanContent: string;
} {
  const extension = posix.extname(destination).toLowerCase();
  const lines = content.split("\n");
  const index = metadataLineIndex(lines, extension);
  const line = lines[index]?.replace(/\r$/u, "");
  const match = extension === ".md"
    ? line?.match(/^<!--\s*MAP-MANAGED:\s*(\{.*\})\s*-->$/u)
    : line?.match(/^#\s*MAP-MANAGED:\s*(\{.*\})$/u);
  if (match?.[1] === undefined) throw new Error(`managed metadata is missing: ${destination}`);
  let value: unknown;
  try {
    value = JSON.parse(match[1]);
  } catch (error) {
    throw new Error(`managed metadata JSON is invalid for ${destination}: ${String(error)}`);
  }
  const parsed = ManagedMetadataSchema.safeParse(value);
  if (!parsed.success) throw schemaError(`managed metadata for ${destination}`, parsed.error.issues);
  const cleanLines = [...lines];
  cleanLines.splice(index, 1);
  return { metadata: parsed.data, cleanContent: cleanLines.join("\n") };
}

function assertFenceContract(content: string, destination: string, mode: ManifestEntry["management_mode"]): void {
  if (mode === "hooks-merge") return;
  const extension = posix.extname(destination).toLowerCase();
  const start = extension === ".md" ? "<!-- map:start -->" : "# map:start";
  const end = extension === ".md" ? "<!-- map:end -->" : "# map:end";
  const lines = content.split(/\r?\n/u);
  const startCount = lines.filter((line) => line === start).length;
  const endCount = lines.filter((line) => line === end).length;
  if (mode === "fenced" && (startCount !== 1 || endCount !== 1 || lines.indexOf(start) >= lines.indexOf(end))) {
    throw new Error(`managed fenced content is invalid: ${destination}`);
  }
  if (mode === "full" && (startCount !== 0 || endCount !== 0)) {
    throw new Error(`fully managed content unexpectedly contains fences: ${destination}`);
  }
}

function assertManifestIdentity(manifest: InstallManifest): void {
  if (manifest.mapify_version !== MAP_VERSION) {
    throw new Error(`MAP manifest version must be ${MAP_VERSION}`);
  }
  if (manifest.provider !== "codex" || !sameStrings(manifest.providers, ["codex"])) {
    throw new Error("MAP manifest provider must be exactly codex");
  }
  if (manifest.config_entries.length !== 0) {
    throw new Error("Codex MAP manifest must not claim MCP or merged config entries");
  }
  const destinations = manifest.entries.map((entry) => entry.dest);
  if (new Set(destinations).size !== destinations.length) {
    throw new Error("MAP manifest inventory contains duplicate destinations");
  }
  const sorted = [...destinations].sort();
  if (!sameStrings(sorted, OFFICIAL_DESTINATIONS)) {
    const expected = new Set(OFFICIAL_DESTINATIONS);
    const actual = new Set(sorted);
    const missing = OFFICIAL_DESTINATIONS.filter((destination) => !actual.has(destination));
    const unexpected = sorted.filter((destination) => !expected.has(destination));
    throw new Error(`MAP manifest inventory mismatch; missing=${missing.join(",")}; unexpected=${unexpected.join(",")}`);
  }
  for (const entry of manifest.entries) {
    requireSafeRelativePath(entry.dest, "MAP manifest destination");
    const expectedMode = OFFICIAL_MANAGEMENT_MODE_BY_DESTINATION[
      entry.dest as keyof typeof OFFICIAL_MANAGEMENT_MODE_BY_DESTINATION
    ];
    if (entry.management_mode !== expectedMode) {
      throw new Error(`MAP manifest management mode drift for ${entry.dest}: expected ${expectedMode}`);
    }
    if (!entry.committed) throw new Error(`MAP manifest managed file is not committed: ${entry.dest}`);
    if (entry.management_mode === "hooks-merge") {
      if (entry.template_hash !== "" || entry.mapify_version !== "" || entry.installed_at !== "") {
        throw new Error(`MAP hooks-merge manifest metadata is invalid: ${entry.dest}`);
      }
      continue;
    }
    if (entry.template_hash === "" || entry.mapify_version !== MAP_VERSION) {
      throw new Error(`MAP manifest entry version or template digest is invalid: ${entry.dest}`);
    }
    if (entry.installed_at !== manifest.installed_at) {
      throw new Error(`MAP manifest installed_at mismatch: ${entry.dest}`);
    }
    if (entry.management_mode === "full" && entry.content_hash !== entry.template_hash) {
      throw new Error(`MAP fully managed content/template digest mismatch: ${entry.dest}`);
    }
  }
}

function assertExpectedDigests(
  expected: Readonly<Record<string, string>>,
): void {
  const destinations = Object.keys(expected).sort();
  if (!sameStrings(destinations, OFFICIAL_DESTINATIONS)) {
    throw new Error("MAP managed digest expectation must cover the exact official inventory");
  }
}

function assertManagedFiles(
  root: string,
  manifest: InstallManifest,
  expectedRawDigests: Readonly<Record<string, string>>,
): Record<string, string> {
  const entries = new Map(manifest.entries.map((entry) => [entry.dest, entry]));
  const receiptDigests: Record<string, string> = {};
  for (const destination of OFFICIAL_DESTINATIONS) {
    const entry = entries.get(destination);
    if (entry === undefined) throw new Error(`MAP managed manifest entry is missing: ${destination}`);
    const bytes = readBytes(root, destination, "MAP managed file");
    const rawDigest = sha256(bytes);
    if (rawDigest !== expectedRawDigests[destination]) {
      throw new Error(`MAP managed raw content digest mismatch: ${destination}`);
    }
    receiptDigests[destination] = rawDigest;
    if (entry.management_mode === "hooks-merge") {
      if (rawDigest !== entry.content_hash) {
        throw new Error(`MAP manifest content digest mismatch: ${destination}`);
      }
      continue;
    }
    const content = decodeUtf8(bytes, `MAP managed file ${destination}`);
    const { metadata, cleanContent } = extractManagedMetadata(content, destination);
    if (metadata.mapify_version !== MAP_VERSION || metadata.template_hash !== entry.template_hash) {
      throw new Error(`MAP managed metadata version or template digest mismatch: ${destination}`);
    }
    if (metadata.installed_at !== entry.installed_at) {
      throw new Error(`MAP managed metadata installed_at mismatch: ${destination}`);
    }
    if (sha256(cleanContent) !== entry.content_hash) {
      throw new Error(`MAP manifest content digest mismatch: ${destination}`);
    }
    assertFenceContract(content, destination, entry.management_mode);
  }
  return receiptDigests;
}

function requireFlatConfigValue(config: string, key: string): string {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const pattern = new RegExp(`^${escaped}\\s*:\\s*([^#]*?)(?:\\s+#.*)?$`, "u");
  const values = config.split(/\r?\n/u)
    .map((line) => line.match(pattern)?.[1]?.trim())
    .filter((value): value is string => value !== undefined);
  if (values.length !== 1 || values[0] === "") {
    throw new Error(`MAP config must define exactly one ${key} value`);
  }
  return values[0]!;
}

function assertProjectConfig(root: string): void {
  const config = decodeUtf8(readBytes(root, ".map/config.yaml", "MAP config"), "MAP config");
  if (requireFlatConfigValue(config, "profile") !== "full") {
    throw new Error("MAP config profile must be full");
  }
  if (requireFlatConfigValue(config, "minimality") !== "lite") {
    throw new Error("MAP config minimality must be lite");
  }
  if (requireFlatConfigValue(config, "updates.auto") !== "false") {
    throw new Error("MAP config automatic updates must be disabled");
  }
}

function assertCodexConfig(root: string): void {
  const config = decodeUtf8(readBytes(root, ".codex/config.toml", "Codex config"), "Codex config");
  let section = "";
  let hooksEnabled = false;
  const registrations = new Map<string, string>();
  for (const rawLine of config.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const header = line.match(/^\[([^\]]+)\]$/u);
    if (header?.[1] !== undefined) {
      section = header[1];
      continue;
    }
    if (section === "features" && /^hooks\s*=\s*true$/u.test(line)) hooksEnabled = true;
    const agent = section.match(/^agents\.([a-z][a-z0-9_-]*)$/u)?.[1];
    const configFile = line.match(/^config_file\s*=\s*"([^"]+)"$/u)?.[1];
    if (agent !== undefined && configFile !== undefined) registrations.set(agent, configFile);
  }
  if (!hooksEnabled) throw new Error("Codex MAP hooks feature must be enabled");
  const registeredAgents = [...registrations.keys()].sort();
  if (!sameStrings(registeredAgents, [...CODEX_AGENTS].sort())) {
    throw new Error(`Codex MAP agent registrations are incomplete: ${registeredAgents.join(",")}`);
  }
  for (const agent of CODEX_AGENTS) {
    if (registrations.get(agent) !== `./agents/${agent}.toml`) {
      throw new Error(`Codex MAP agent registration path is invalid: ${agent}`);
    }
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertCodexHooks(root: string, manifest: InstallManifest): void {
  const bytes = readBytes(root, ".codex/hooks.json", "Codex hooks config");
  let value: unknown;
  try {
    value = JSON.parse(decodeUtf8(bytes, "Codex hooks config"));
  } catch (error) {
    throw new Error(`Codex hooks JSON is invalid: ${String(error)}`);
  }
  if (!isObject(value) || !isObject(value.hooks) || !Array.isArray(value.hooks.PreToolUse)) {
    throw new Error("Codex MAP PreToolUse hooks are missing");
  }
  const expectedCommand = "python3 \"$(git rev-parse --show-toplevel)/.codex/hooks/workflow-gate.py\"";
  const expectedAdapterCommand = "python3 \"$(git rev-parse --show-toplevel)/.codex/hooks/agent-collab-map-gate.py\"";
  const mapHooks: Record<string, unknown>[] = [];
  const adapterHooks: Record<string, unknown>[] = [];
  for (const entry of value.hooks.PreToolUse) {
    if (!isObject(entry) || !Array.isArray(entry.hooks)) continue;
    for (const hook of entry.hooks) {
      if (!isObject(hook)) continue;
      if (entry.matcher === "Bash" && hook.command === expectedCommand) mapHooks.push(hook);
      if (
        entry.matcher === "^(apply_patch|Edit|Write|MultiEdit)$" &&
        hook.command === expectedAdapterCommand
      ) {
        adapterHooks.push(hook);
      }
    }
  }
  if (mapHooks.length !== 1 || mapHooks[0]?.type !== "command" || mapHooks[0]?.timeout !== 600) {
    throw new Error("Codex MAP workflow-gate hook registration is invalid");
  }
  if (
    adapterHooks.length !== 1 ||
    adapterHooks[0]?.type !== "command" ||
    adapterHooks[0]?.timeout !== 600
  ) {
    throw new Error("Codex apply_patch MAP adapter hook registration is invalid");
  }
  requireRegularFile(root, ".codex/hooks/agent-collab-map-gate.py", "Codex apply_patch MAP adapter");
  if (manifest.entries.some((entry) => entry.dest === ".codex/hooks/agent-collab-map-gate.py")) {
    throw new Error("MAP manifest must not own the local Codex apply_patch adapter");
  }
}

function assertSkillInventory(root: string, manifest: InstallManifest): string[] {
  const skillsRoot = requireDirectory(root, ".agents/skills", "Codex skills directory");
  const names = readdirSync(skillsRoot, { withFileTypes: true })
    .filter((entry) => entry.name.startsWith("map-"))
    .map((entry) => {
      if (entry.isSymbolicLink() || !entry.isDirectory()) {
        throw new Error(`Codex MAP skill path is not a regular directory: ${entry.name}`);
      }
      return entry.name;
    })
    .sort();
  const expected = [...OFFICIAL_CODEX_SKILLS, "map-learn"].sort();
  if (!sameStrings(names, expected)) {
    throw new Error(`Codex MAP skill inventory mismatch: ${names.join(",")}`);
  }
  requireRegularFile(root, LOCAL_LEARNING_ADAPTER, "local map-learn adapter");
  if (manifest.entries.some((entry) => entry.dest === LOCAL_LEARNING_ADAPTER)) {
    throw new Error("MAP manifest must not own the local map-learn adapter");
  }
  return [...OFFICIAL_CODEX_SKILLS];
}

function assertOutsideScope(
  root: string,
  outsideDigests: Readonly<Record<string, string>>,
): void {
  const reserved = new Set([
    ...OFFICIAL_DESTINATIONS,
    ".map/mapify.lock.json",
    ".map/config.yaml",
  ]);
  for (const [relativePath, expectedDigest] of Object.entries(outsideDigests)) {
    if (reserved.has(relativePath)) {
      throw new Error(`outside-scope digest overlaps MAP-owned content: ${relativePath}`);
    }
    const bytes = readBytes(root, relativePath, "outside-scope user-owned file");
    if (sha256(bytes) !== expectedDigest) {
      throw new Error(`outside-scope user-owned digest mismatch: ${relativePath}`);
    }
  }
}

export function validateMapProfile(
  rootInput: string,
  expectationInput: MapProfileExpectation,
): MapProfileReceipt {
  const expectation = parseExpectation(expectationInput);
  if (expectation.version !== MAP_VERSION) throw new Error(`MAP expected version must be ${MAP_VERSION}`);
  if (expectation.sourceRevision !== MAP_SOURCE_REVISION) {
    throw new Error(`MAP source revision must be pinned to ${MAP_SOURCE_REVISION}`);
  }
  if (expectation.sourceArchiveSha256 !== MAP_SOURCE_ARCHIVE_SHA256) {
    throw new Error(`MAP source archive must be pinned to ${MAP_SOURCE_ARCHIVE_SHA256}`);
  }
  if (expectation.provider !== "codex") throw new Error("MAP expected provider must be codex");
  assertExpectedDigests(expectation.managedFileSha256);

  const root = canonicalRoot(rootInput);
  const manifest = parseManifest(readBytes(root, ".map/mapify.lock.json", "MAP manifest"));
  assertManifestIdentity(manifest);
  const managedFileSha256 = assertManagedFiles(root, manifest, expectation.managedFileSha256);
  assertProjectConfig(root);
  assertCodexConfig(root);
  assertCodexHooks(root, manifest);
  const upstreamSkillInventory = assertSkillInventory(root, manifest);
  assertOutsideScope(root, expectation.outsideScopeSha256);

  return {
    version: MAP_VERSION,
    sourceRevision: MAP_SOURCE_REVISION,
    sourceArchiveSha256: MAP_SOURCE_ARCHIVE_SHA256,
    provider: "codex",
    profile: "full",
    minimality: "lite",
    updatesAuto: false,
    upstreamSkillInventory,
    managedFileSha256,
    outsideScopeSha256: { ...expectation.outsideScopeSha256 },
  };
}
