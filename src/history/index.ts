import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  statSync,
} from "node:fs";
import Database from "better-sqlite3";
import { basename, dirname, isAbsolute } from "node:path";
import { redactSensitive } from "../security/redaction.js";
import {
  adaptClaudeRecord,
  adaptCodexRecord,
  adaptGrokRecord,
  type AdapterContext,
} from "./adapters.js";
import type {
  ActiveAgentId,
  HistoryCandidate,
  HistoryKind,
  HistoryNamespace,
  HistoryRow,
  HistorySearchRow,
  HistorySourceAgent,
  PendingTool,
} from "./types.js";
import { HistoryVisibilityPolicy } from "./visibility-policy.js";

interface SourceState {
  checkpoint_offset: number;
  checkpoint_line: number;
  prefix_hash: string;
  session_id: string | null;
}

export type MemorySourceStatus = "projected" | "unavailable" | "no_project_section";

export interface MemorySourceHealth {
  project: string;
  namespace: "grok_native" | "codex_native";
  status: MemorySourceStatus;
  sourcePath: string | null;
  updatedAt: number;
}

interface StoredPendingTool {
  agent: HistorySourceAgent;
  call_id: string;
  name: string;
  session_id: string | null;
  source_path: string;
  source_line: number;
  timestamp: string | null;
  record_key: string;
}

interface StoredRow {
  source_agent: HistorySourceAgent;
  namespace: HistoryNamespace;
  kind: HistoryRow["kind"];
  session_id: string | null;
  role: HistoryRow["role"];
  content: string;
  source_path: string;
  source_line: number;
  timestamp: string | null;
  record_key: string;
  content_hash: string;
  trust: "untrusted";
}

interface IndexResult {
  added: number;
  duplicates: number;
  malformed: number;
  partial: boolean;
  rotated: boolean;
  removed: number;
  resumedFrom: number;
  checkpoint: { offset: number };
}

const EMPTY_HASH = createHash("sha256").update(Buffer.alloc(0)).digest("hex");
const MAX_GROK_RECORD_BYTES = 1024 * 1024;
const MAX_TOOL_NAME_BYTES = 128;
const HISTORY_KINDS: ReadonlySet<HistoryKind> = new Set(["memory", "message", "tool_summary"]);
type HistoryIngestAgent = HistorySourceAgent | "claude";

function sourceAgent(agent: HistoryIngestAgent): HistorySourceAgent {
  return agent === "claude" ? "claude_legacy" : agent;
}

function nativeNamespace(agent: HistorySourceAgent): HistoryNamespace {
  return agent === "grok"
    ? "grok_native"
    : agent === "codex"
      ? "codex_native"
      : "claude_legacy";
}

function memoryNamespace(
  agent: HistorySourceAgent,
  requested?: HistoryNamespace,
): HistoryNamespace {
  const expected = nativeNamespace(agent);
  if (requested === undefined || requested === expected) return expected;
  if (requested === "collaboration_shared" && agent !== "claude_legacy") {
    return requested;
  }
  throw new Error(`invalid memory namespace ${requested} for ${agent}`);
}

function truncateUtf8(value: string, maxBytes: number): string {
  let result = "";
  let bytes = 0;
  for (const character of value) {
    const size = Buffer.byteLength(character, "utf8");
    if (bytes + size > maxBytes) break;
    result += character;
    bytes += size;
  }
  return result;
}

function hash(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function hashFilePrefix(path: string, length: number): string {
  const digest = createHash("sha256");
  const fd = openSync(path, "r");
  try {
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let position = 0;
    while (position < length) {
      const bytes = readSync(fd, buffer, 0, Math.min(buffer.length, length - position), position);
      if (bytes === 0) break;
      digest.update(buffer.subarray(0, bytes));
      position += bytes;
    }
  } finally { closeSync(fd); }
  return digest.digest("hex");
}

function forEachCompleteLine(
  path: string,
  offset: number,
  visit: (line: string, index: number) => void,
): { completedLength: number; lineCount: number; partial: boolean } {
  const fd = openSync(path, "r");
  let position = offset; let completedLength = 0; let lineCount = 0; let carry = Buffer.alloc(0);
  try {
    const chunk = Buffer.allocUnsafe(1024 * 1024);
    while (true) {
      const bytes = readSync(fd, chunk, 0, chunk.length, position);
      if (bytes === 0) break;
      position += bytes;
      let data = carry.length === 0 ? Buffer.from(chunk.subarray(0, bytes)) : Buffer.concat([carry, chunk.subarray(0, bytes)]);
      let start = 0;
      while (true) {
        const newline = data.indexOf(0x0a, start);
        if (newline < 0) break;
        visit(data.subarray(start, newline).toString("utf8"), lineCount);
        lineCount += 1;
        completedLength += newline - start + 1;
        start = newline + 1;
      }
      carry = start === data.length ? Buffer.alloc(0) : Buffer.from(data.subarray(start));
    }
  } finally { closeSync(fd); }
  return { completedLength, lineCount, partial: carry.length > 0 };
}

function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Read-only native-history index. Use a dedicated SQLite database so its scan
 * transactions cannot block the collaboration run queue.
 */
export class HistoryIndex {
  private readonly db: Database.Database;
  private readonly visibilityPolicy: HistoryVisibilityPolicy;

  constructor(path: string, options: { visibilityPolicy: HistoryVisibilityPolicy }) {
    this.db = new Database(path);
    this.visibilityPolicy = options.visibilityPolicy;
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.pragma("busy_timeout = 5000");
    const existing = this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='sources'").get();
    if (existing !== undefined) {
      const sourceColumns = this.db.pragma("table_info(sources)") as Array<{ name: string; pk: number }>;
      const historyColumns = this.db.pragma("table_info(history_rows)") as Array<{ name: string }>;
      if (
        sourceColumns.find((column) => column.name === "project")?.pk !== 1 ||
        !historyColumns.some((column) => column.name === "namespace")
      ) {
        this.db.close();
        throw new Error("history tables require offline v1-to-v2 migration");
      }
    }
    this.createSchema();
  }

  private createSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sources (
        project TEXT NOT NULL,
        source_path TEXT NOT NULL,
        agent TEXT NOT NULL CHECK (agent IN ('grok', 'codex', 'claude_legacy')),
        checkpoint_offset INTEGER NOT NULL,
        checkpoint_line INTEGER NOT NULL,
        prefix_hash TEXT NOT NULL,
        session_id TEXT,
        PRIMARY KEY (project, source_path)
      );
      CREATE TABLE IF NOT EXISTS history_rows (
        project TEXT NOT NULL,
        source_path TEXT NOT NULL,
        record_key TEXT NOT NULL,
        source_agent TEXT NOT NULL CHECK (source_agent IN ('grok', 'codex', 'claude_legacy')),
        namespace TEXT NOT NULL CHECK (namespace IN ('grok_native', 'codex_native', 'collaboration_shared', 'claude_legacy')),
        kind TEXT NOT NULL CHECK (kind IN ('memory', 'message', 'tool_summary')),
        session_id TEXT,
        role TEXT NOT NULL CHECK (role IN ('assistant', 'memory', 'user')),
        content TEXT NOT NULL,
        source_line INTEGER NOT NULL,
        timestamp TEXT,
        content_hash TEXT NOT NULL,
        trust TEXT NOT NULL CHECK (trust = 'untrusted'),
        PRIMARY KEY (project, source_path, record_key)
      );
      CREATE INDEX IF NOT EXISTS history_rows_project ON history_rows(project, source_agent, source_path, source_line);
      CREATE TABLE IF NOT EXISTS pending_tools (
        project TEXT NOT NULL,
        source_path TEXT NOT NULL,
        call_id TEXT NOT NULL,
        agent TEXT NOT NULL CHECK (agent IN ('grok', 'codex', 'claude_legacy')),
        name TEXT NOT NULL,
        session_id TEXT,
        source_line INTEGER NOT NULL,
        timestamp TEXT,
        record_key TEXT NOT NULL,
        PRIMARY KEY (project, source_path, call_id)
      );
      CREATE TABLE IF NOT EXISTS history_issues (
        project TEXT NOT NULL,
        source_path TEXT NOT NULL,
        code TEXT NOT NULL,
        source_line INTEGER NOT NULL DEFAULT -1,
        details TEXT,
        PRIMARY KEY (project, source_path, code, source_line)
      );
      CREATE TABLE IF NOT EXISTS memory_source_health (
        project TEXT NOT NULL,
        namespace TEXT NOT NULL CHECK (namespace IN ('grok_native', 'codex_native')),
        status TEXT NOT NULL CHECK (status IN ('projected', 'unavailable', 'no_project_section')),
        source_path TEXT,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (project, namespace)
      );
    `);
  }

  recordMemorySourceHealth(input: MemorySourceHealth): void {
    this.db.prepare(`INSERT INTO memory_source_health
      (project,namespace,status,source_path,updated_at) VALUES (?,?,?,?,?)
      ON CONFLICT(project,namespace) DO UPDATE SET
        status=excluded.status,source_path=excluded.source_path,updated_at=excluded.updated_at`)
      .run(input.project, input.namespace, input.status, input.sourcePath, input.updatedAt);
  }

  memorySourceHealth(project?: string): MemorySourceHealth[] {
    const rows = (project === undefined
      ? this.db.prepare(`SELECT project,namespace,status,source_path,updated_at
          FROM memory_source_health ORDER BY project,namespace`).all()
      : this.db.prepare(`SELECT project,namespace,status,source_path,updated_at
          FROM memory_source_health WHERE project=? ORDER BY namespace`).all(project)) as Array<{
      project: string;
      namespace: MemorySourceHealth["namespace"];
      status: MemorySourceStatus;
      source_path: string | null;
      updated_at: number;
    }>;
    return rows.map((row) => ({ project: row.project, namespace: row.namespace,
      status: row.status, sourcePath: row.source_path, updatedAt: row.updated_at }));
  }

  async indexClaudeFile(path: string, project: string): Promise<IndexResult> {
    return this.indexJsonl("claude_legacy", path, project);
  }

  async indexCodexFile(path: string, project: string): Promise<IndexResult> {
    return this.indexJsonl("codex", path, project);
  }

  async indexGrokFile(path: string, project: string): Promise<IndexResult> {
    const canonicalProject = realpathSync(project);
    const canonicalPath = realpathSync(path);
    const directorySession = basename(dirname(canonicalPath));
    const initialSessionId = /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(directorySession)
      ? directorySession : null;
    return this.indexJsonl("grok", canonicalPath, canonicalProject, initialSessionId);
  }

  async indexMemoryFile(input: {
    agent: HistoryIngestAgent;
    path: string;
    project: string;
    namespace?: HistoryNamespace;
  }): Promise<{ added: number }> {
    return this.indexMemoryProjection({
      ...input,
      startLine: 1,
      endLine: null,
    });
  }

  async indexProjectMemorySection(input: {
    agent: HistoryIngestAgent;
    path: string;
    project: string;
    namespace?: HistoryNamespace;
    section: {
      startLine: number;
      endLine: number;
    };
  }): Promise<{ added: number }> {
    if (!isAbsolute(input.project) || input.project === "/" || input.project === "__global__") {
      throw new Error("project memory section requires an absolute non-root project path");
    }
    const { startLine, endLine } = input.section;
    if (
      !Number.isSafeInteger(startLine) ||
      !Number.isSafeInteger(endLine) ||
      startLine < 1 ||
      endLine < startLine
    ) {
      throw new Error("project memory section must be one valid contiguous line range");
    }
    const project = realpathSync(input.project);
    if (project === "/") {
      throw new Error("project memory section requires an absolute non-root project path");
    }
    return this.indexMemoryProjection({
      agent: input.agent,
      path: realpathSync(input.path),
      project,
      ...(input.namespace === undefined ? {} : { namespace: input.namespace }),
      startLine,
      endLine,
    });
  }

  private indexMemoryProjection(input: {
    agent: HistoryIngestAgent;
    path: string;
    project: string;
    namespace?: HistoryNamespace;
    startLine: number;
    endLine: number | null;
  }): { added: number } {
    const bytes = readFileSync(input.path);
    const text = bytes.toString("utf8");
    const lines = text.split(/\r?\n/);
    if (input.endLine !== null && input.endLine > lines.length) {
      throw new Error("project memory section exceeds the source line count");
    }
    const agent = sourceAgent(input.agent);
    const namespace = memoryNamespace(agent, input.namespace);
    const endLine = input.endLine ?? lines.length;
    const remove = this.db.transaction(() => {
      this.db.prepare("DELETE FROM history_rows WHERE project = ? AND source_path = ?").run(input.project, input.path);
      this.db.prepare("DELETE FROM pending_tools WHERE project = ? AND source_path = ?").run(input.project, input.path);
      let added = 0;
      let insidePrivateKey = false;
      for (const [index, line] of lines.entries()) {
        const sourceLine = index + 1;
        const beginsPrivateKey = /^\s*-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----\s*$/.test(line);
        const endsPrivateKey = /^\s*-----END [A-Z0-9 ]*PRIVATE KEY-----\s*$/.test(line);
        if (insidePrivateKey) {
          if (endsPrivateKey) insidePrivateKey = false;
          continue;
        }
        if (beginsPrivateKey) insidePrivateKey = true;
        if (sourceLine < input.startLine || sourceLine > endLine) continue;
        const projected = this.visibilityPolicy.project({
          visibility: "visible",
          sourceAgent: agent,
          namespace,
          kind: "memory",
          sessionId: null,
          role: "memory",
          content: beginsPrivateKey ? "[REDACTED]" : line,
          project: input.project,
          sourcePath: input.path,
          sourceLine,
          timestamp: null,
          recordKey: `memory:${sourceLine}`,
        });
        if (projected && this.insertRow(projected)) added += 1;
      }
      this.upsertSource(input.path, agent, input.project, bytes.length, lines.length - 1, hash(bytes), null);
      return added;
    });
    return { added: remove() };
  }

  async indexClaudeSessionIndex(path: string, project: string): Promise<{
    indexed: number;
    orphans: Array<{ sessionId: string; transcriptPath: string; reason: "missing_transcript" }>;
  }> {
    const root = asObject(JSON.parse(readFileSync(path, "utf8")));
    const entries = Array.isArray(root?.entries) ? root.entries : [];
    const orphans: Array<{ sessionId: string; transcriptPath: string; reason: "missing_transcript" }> = [];
    let indexed = 0;
    for (const rawEntry of entries) {
      const entry = asObject(rawEntry);
      const sessionId = typeof entry?.sessionId === "string" ? entry.sessionId : null;
      const transcriptPath = typeof entry?.transcriptPath === "string" ? entry.transcriptPath : null;
      if (!sessionId || !transcriptPath) continue;
      if (!existsSync(transcriptPath)) {
        const orphan = { sessionId, transcriptPath, reason: "missing_transcript" as const };
        orphans.push(orphan);
        this.addIssue(project, path, "orphan_session", -1, { sessionId, transcriptPath });
        continue;
      }
      await this.indexClaudeFile(transcriptPath, project);
      indexed += 1;
    }
    return { indexed, orphans };
  }

  search(input: {
    requester: ActiveAgentId;
    project: string;
    query?: string;
    limit?: number;
    kinds?: readonly HistoryKind[];
  }): HistorySearchRow[] {
    void input.requester;
    const limit = Math.min(200, Math.max(1, input.limit ?? 100));
    const query = input.query?.trim() ?? "";
    const kinds = input.kinds === undefined
      ? [...HISTORY_KINDS]
      : [...new Set(input.kinds)];
    if (kinds.length === 0) return [];
    if (kinds.some((kind) => !HISTORY_KINDS.has(kind))) {
      throw new Error("invalid history kind filter");
    }
    const kindPlaceholders = kinds.map(() => "?").join(", ");
    const stored = this.db
      .prepare(
        `SELECT source_agent, namespace, kind, session_id, role, content, source_path,
                source_line, timestamp, record_key, content_hash, trust
           FROM history_rows
          WHERE project = ?
            AND kind IN (${kindPlaceholders})
            AND (? = '' OR instr(lower(content), lower(?)) > 0)
          ORDER BY source_agent, source_path, source_line, record_key
          LIMIT ?`,
      )
      .all(input.project, ...kinds, query, query, limit) as StoredRow[];
    return stored
      .map((row) => ({
        sourceAgent: row.source_agent,
        namespace: row.namespace,
        kind: row.kind,
        sessionId: row.session_id,
        role: row.role,
        content: row.content,
        sourcePath: row.source_path,
        sourceLine: row.source_line,
        timestamp: row.timestamp,
        recordKey: row.record_key,
        contentHash: row.content_hash,
        trust: row.trust,
      }));
  }

  countBySource(path: string, project?: string): number {
    const row = (project === undefined
      ? this.db.prepare("SELECT COUNT(*) AS count FROM history_rows WHERE source_path = ?").get(path)
      : this.db
          .prepare("SELECT COUNT(*) AS count FROM history_rows WHERE project = ? AND source_path = ?")
          .get(project, path)) as { count: number };
    return row.count;
  }

  reconcileSources(input: {
    agent: HistoryIngestAgent;
    project: string;
    presentPaths: readonly string[];
  }): {
    removedSources: string[];
    removedRows: number;
  } {
    const present = new Set(input.presentPaths);
    const agent = sourceAgent(input.agent);
    const known = this.db
      .prepare("SELECT source_path FROM sources WHERE agent = ? AND project = ? ORDER BY source_path")
      .all(agent, input.project) as Array<{ source_path: string }>;
    const removedSources = known.map((row) => row.source_path).filter((path) => !present.has(path));
    let removedRows = 0;
    const remove = this.db.transaction(() => {
      for (const path of removedSources) {
        removedRows += this.countBySource(path, input.project);
        this.db.prepare("DELETE FROM history_rows WHERE project = ? AND source_path = ?").run(input.project, path);
        this.db.prepare("DELETE FROM pending_tools WHERE project = ? AND source_path = ?").run(input.project, path);
        this.db.prepare("DELETE FROM sources WHERE project = ? AND source_path = ?").run(input.project, path);
        this.addIssue(input.project, path, "source_deleted", -1, null);
      }
    });
    remove();
    return { removedSources, removedRows };
  }

  listIssues(input: { sourcePath: string; project?: string }): Array<Record<string, unknown>> {
    const rows = (input.project === undefined
      ? this.db
          .prepare("SELECT code, source_line, details FROM history_issues WHERE source_path = ? ORDER BY rowid")
          .all(input.sourcePath)
      : this.db
          .prepare(
            "SELECT code, source_line, details FROM history_issues WHERE project = ? AND source_path = ? ORDER BY rowid",
          )
          .all(input.project, input.sourcePath)) as Array<{
      code: string;
      source_line: number;
      details: string | null;
    }>;
    return rows.map((row) => {
      const details = row.details ? (JSON.parse(row.details) as Record<string, unknown>) : {};
      return {
        code: row.code,
        sourcePath: input.sourcePath,
        ...(row.source_line >= 0 ? { sourceLine: row.source_line } : {}),
        ...details,
      };
    });
  }

  close(): void {
    this.db.close();
  }

  private indexJsonl(agent: HistorySourceAgent, path: string, project: string,
    initialSessionId: string | null = null): IndexResult {
    const fileSize = statSync(path).size;
    let state = this.db
      .prepare("SELECT * FROM sources WHERE project = ? AND source_path = ?")
      .get(project, path) as SourceState | undefined;
    const resumedFrom = state?.checkpoint_offset ?? 0;
    const rotated = Boolean(
      state &&
        (fileSize < state.checkpoint_offset ||
          hashFilePrefix(path, state.checkpoint_offset) !== state.prefix_hash),
    );
    let removed = 0;
    if (rotated) {
      removed = this.countBySource(path, project);
      const reset = this.db.transaction(() => {
        this.db.prepare("DELETE FROM history_rows WHERE project = ? AND source_path = ?").run(project, path);
        this.db.prepare("DELETE FROM pending_tools WHERE project = ? AND source_path = ?").run(project, path);
        this.db.prepare("DELETE FROM sources WHERE project = ? AND source_path = ?").run(project, path);
        this.db.prepare("DELETE FROM history_issues WHERE project = ? AND source_path = ?").run(project, path);
      });
      reset();
      state = undefined;
    }
    const offset = state?.checkpoint_offset ?? 0;
    const baseLine = state?.checkpoint_line ?? 0;
    let sessionId = state?.session_id ?? initialSessionId;
    let added = 0;
    let duplicates = 0;
    let malformed = 0;

    const process = this.db.transaction(() => {
      const scanned = forEachCompleteLine(path, offset, (line, index) => {
        const sourceLine = baseLine + index + 1;
        if (agent === "grok" && Buffer.byteLength(line, "utf8") > MAX_GROK_RECORD_BYTES) {
          malformed += 1;
          this.addIssue(project, path, "oversized_record", sourceLine, null);
          return;
        }
        let record: unknown;
        try {
          record = JSON.parse(line);
        } catch {
          malformed += 1;
          this.addIssue(project, path, "malformed_record", sourceLine, null);
          return;
        }
        const context: AdapterContext = { project, sourcePath: path, sourceLine, sessionId };
        const events =
          agent === "claude_legacy"
            ? adaptClaudeRecord(record, context)
            : agent === "codex"
              ? adaptCodexRecord(record, context)
              : adaptGrokRecord(record, context);
        for (const event of events) {
          if (event.type === "session") {
            sessionId = event.sessionId;
          } else if (event.type === "candidate") {
            const projected = this.visibilityPolicy.project(event.candidate);
            if (!projected) continue;
            if (this.insertRow(projected)) added += 1;
            else duplicates += 1;
          } else if (event.type === "tool_call") {
            this.savePendingTool(event.tool, project);
          } else {
            const tool = this.takePendingTool(project, path, event.callId);
            if (!tool) continue;
            const projected = this.visibilityPolicy.project(this.toolCandidate(tool, project, event.status));
            if (!projected) continue;
            if (this.insertRow(projected)) added += 1;
            else duplicates += 1;
          }
        }
      });
      const checkpointOffset = offset + scanned.completedLength;
      this.upsertSource(
        path,
        agent,
        project,
        checkpointOffset,
        baseLine + scanned.lineCount,
        hashFilePrefix(path, checkpointOffset),
        sessionId,
      );
      return scanned;
    });
    const scanned = process();
    const completedLength = scanned.completedLength;
    const checkpointOffset = offset + completedLength;
    return {
      added,
      duplicates,
      malformed,
      partial: scanned.partial,
      rotated,
      removed,
      resumedFrom: rotated ? 0 : resumedFrom,
      checkpoint: { offset: checkpointOffset },
    };
  }

  private insertRow(row: HistoryRow): boolean {
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO history_rows (
          project, source_path, record_key, source_agent, namespace, kind, session_id, role,
          content, source_line, timestamp, content_hash, trust
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.project,
        row.sourcePath,
        row.recordKey,
        row.sourceAgent,
        row.namespace,
        row.kind,
        row.sessionId,
        row.role,
        row.content,
        row.sourceLine,
        row.timestamp,
        row.contentHash,
        row.trust,
      );
    return result.changes === 1;
  }

  private savePendingTool(tool: PendingTool, project: string): void {
    const safeName = truncateUtf8(redactSensitive(tool.name).trim(), MAX_TOOL_NAME_BYTES) || "unknown_tool";
    this.db
      .prepare(
        `INSERT INTO pending_tools (
          project, source_path, call_id, agent, name, session_id, source_line, timestamp, record_key
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(project, source_path, call_id) DO UPDATE SET
          agent = excluded.agent,
          name = excluded.name,
          session_id = excluded.session_id,
          source_line = excluded.source_line,
          timestamp = excluded.timestamp,
          record_key = excluded.record_key`,
      )
      .run(
        project,
        tool.sourcePath,
        tool.callId,
        tool.sourceAgent,
        safeName,
        tool.sessionId,
        tool.sourceLine,
        tool.timestamp,
        tool.recordKey,
      );
  }

  private takePendingTool(project: string, path: string, callId: string): StoredPendingTool | null {
    const tool = this.db
      .prepare(
        `SELECT source_path, call_id, agent, name, session_id, source_line, timestamp, record_key
           FROM pending_tools WHERE project = ? AND source_path = ? AND call_id = ?`,
      )
      .get(project, path, callId) as StoredPendingTool | undefined;
    if (!tool) return null;
    this.db
      .prepare("DELETE FROM pending_tools WHERE project = ? AND source_path = ? AND call_id = ?")
      .run(project, path, callId);
    return tool;
  }

  private toolCandidate(tool: StoredPendingTool, project: string, status: "completed" | "failed"): HistoryCandidate {
    return {
      visibility: "visible",
      sourceAgent: tool.agent,
      namespace: nativeNamespace(tool.agent),
      kind: "tool_summary",
      sessionId: tool.session_id,
      role: "assistant",
      content: `${tool.name}: ${status}`,
      project,
      sourcePath: tool.source_path,
      sourceLine: tool.source_line,
      timestamp: tool.timestamp,
      recordKey: tool.record_key,
    };
  }

  private upsertSource(
    path: string,
    agent: HistorySourceAgent,
    project: string,
    checkpointOffset: number,
    checkpointLine: number,
    prefixHash: string,
    sessionId: string | null,
  ): void {
    this.db
      .prepare(
        `INSERT INTO sources (
          project, source_path, agent, checkpoint_offset, checkpoint_line, prefix_hash, session_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(project, source_path) DO UPDATE SET
          agent = excluded.agent,
          checkpoint_offset = excluded.checkpoint_offset,
          checkpoint_line = excluded.checkpoint_line,
          prefix_hash = excluded.prefix_hash,
          session_id = excluded.session_id`,
      )
      .run(project, path, agent, checkpointOffset, checkpointLine, prefixHash || EMPTY_HASH, sessionId);
  }

  private addIssue(
    project: string,
    path: string,
    code: string,
    sourceLine: number,
    details: Record<string, unknown> | null,
  ): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO history_issues (project, source_path, code, source_line, details)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(project, path, code, sourceLine, details ? JSON.stringify(details) : null);
  }
}
