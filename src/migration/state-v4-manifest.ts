import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import Database from "better-sqlite3";
import { canonicalJson } from "../domain/canonical-json.js";
import { GRAPH_V4_TABLES } from "./graph-v4-schema.js";
import { REVIEW_V3_TABLE_CLASSIFICATION } from "./review-v3-schema.js";

export interface LegacyTableManifest {
  schemaVersion: "legacy-table-digest-manifest/v1";
  tables: Array<{ name: string; columns: string[]; rowCount: number; rowsSha256: string }>;
}

export interface LegacyDatabaseObservation {
  readonly userVersion: number;
  readonly bytesSha256: string;
  readonly manifest: LegacyTableManifest;
  readonly manifestSha256: string;
}

const sha256 = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");

const sqliteValue = (value: unknown): unknown => {
  if (value === null || typeof value === "string") return { type: value === null ? "null" : "text", value };
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new Error("legacy table contains an unsafe SQLite integer");
    return { type: "integer", value: value.toString() };
  }
  if (typeof value === "bigint") return { type: "integer", value: value.toString() };
  if (Buffer.isBuffer(value)) return { type: "blob", value: value.toString("base64") };
  throw new Error(`unsupported SQLite value in legacy manifest: ${typeof value}`);
};

export function legacyTableManifest(
  db: Database.Database,
  expected?: LegacyTableManifest,
): LegacyTableManifest {
  const graphTables = new Set<string>(GRAPH_V4_TABLES);
  const actualTableNames = (db.prepare(`SELECT name FROM sqlite_schema
    WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`).pluck().all() as string[])
    .filter((name) => !graphTables.has(name));
  const tableNames = expected?.tables.map(({ name }) => name) ?? actualTableNames;
  const expectedNames = new Set(tableNames);
  const allowedAdditions = new Set<string>(REVIEW_V3_TABLE_CLASSIFICATION.added);
  if (expected && (tableNames.some((name) => !actualTableNames.includes(name)) ||
      actualTableNames.some((name) => !expectedNames.has(name) && !allowedAdditions.has(name)))) {
    throw new Error(`legacy manifest non-graph table set changed: expected=${tableNames.join(",")}; actual=${actualTableNames.join(",")}`);
  }
  return {
    schemaVersion: "legacy-table-digest-manifest/v1",
    tables: tableNames.map((name) => {
      const expectedTable = expected?.tables.find((table) => table.name === name);
      const actualColumns = (db.pragma(`table_info('${name.replaceAll("'", "''")}')`) as Array<{ name: string }>)
        .map(({ name: column }) => column);
      const columns = expectedTable?.columns ?? actualColumns;
      if (columns.length === 0 || new Set(columns).size !== columns.length ||
          columns.some((column) => !actualColumns.includes(column))) {
        throw new Error(`legacy manifest column disappeared: ${name}`);
      }
      const digest = createHash("sha256");
      let rowCount = 0;
      const escaped = name.replaceAll('"', '""');
      for (const row of db.prepare(`SELECT * FROM "${escaped}" ORDER BY rowid`).iterate() as Iterable<Record<string, unknown>>) {
        digest.update(canonicalJson(columns.map((column) => sqliteValue(row[column]))));
        digest.update("\n");
        rowCount += 1;
      }
      return { name, columns, rowCount, rowsSha256: digest.digest("hex") };
    }),
  };
}

export const legacyTableManifestSha256 = (manifest: LegacyTableManifest): string =>
  sha256(canonicalJson(manifest));

export const serializeLegacyTableManifest = (manifest: LegacyTableManifest): string =>
  `${canonicalJson(manifest)}\n`;

export function parseLegacyTableManifest(bytes: string): LegacyTableManifest {
  if (!bytes.endsWith("\n")) throw new Error("legacy table manifest is truncated");
  let manifest: LegacyTableManifest;
  try {
    manifest = JSON.parse(bytes) as LegacyTableManifest;
  } catch (error) {
    throw new Error("legacy table manifest is malformed", { cause: error });
  }
  const exactKeys = (value: object, keys: readonly string[]): boolean => {
    const actual = Object.keys(value).sort();
    const expected = [...keys].sort();
    return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
  };
  if (manifest === null || typeof manifest !== "object" || Array.isArray(manifest) ||
      !exactKeys(manifest, ["schemaVersion", "tables"]) ||
      manifest.schemaVersion !== "legacy-table-digest-manifest/v1" || !Array.isArray(manifest.tables) ||
      manifest.tables.some((table) => table === null || typeof table !== "object" || Array.isArray(table) ||
        !exactKeys(table, ["name", "columns", "rowCount", "rowsSha256"]) ||
        typeof table.name !== "string" || table.name.length === 0 || !Array.isArray(table.columns) ||
        table.columns.some((column: unknown) => typeof column !== "string" || column.length === 0) ||
        !Number.isSafeInteger(table.rowCount) || table.rowCount < 0 ||
        !/^[a-f0-9]{64}$/.test(table.rowsSha256))) {
    throw new Error("legacy table manifest is malformed");
  }
  const tableNames = manifest.tables.map(({ name }) => name);
  if (new Set(tableNames).size !== tableNames.length ||
      tableNames.some((name, index) => index > 0 && name <= tableNames[index - 1]!) ||
      manifest.tables.some(({ columns }) => new Set(columns).size !== columns.length)) {
    throw new Error("legacy table manifest order or identity is invalid");
  }
  if (serializeLegacyTableManifest(manifest) !== bytes) {
    throw new Error("legacy table manifest bytes are not canonical");
  }
  return manifest;
}

export function observeLegacyDatabase(
  path: string,
  label: "state" | "history",
  expected?: LegacyTableManifest,
): LegacyDatabaseObservation {
  if (["-wal", "-shm", "-journal"].some((suffix) => existsSync(`${path}${suffix}`))) {
    throw new Error(`${label} database has unbound SQLite sidecar state`);
  }
  const bytesSha256 = sha256(readFileSync(path));
  const db = new Database(path, { readonly: true, fileMustExist: true });
  let observation: LegacyDatabaseObservation;
  try {
    db.pragma("query_only = ON");
    if (String(db.pragma("integrity_check", { simple: true })) !== "ok" ||
        (db.pragma("foreign_key_check") as unknown[]).length !== 0) {
      throw new Error(`${label} database failed SQLite integrity verification`);
    }
    const manifest = legacyTableManifest(db, expected);
    observation = {
      userVersion: Number(db.pragma("user_version", { simple: true })),
      bytesSha256,
      manifest,
      manifestSha256: legacyTableManifestSha256(manifest),
    };
  } finally {
    db.close();
  }
  if (sha256(readFileSync(path)) !== bytesSha256 ||
      ["-wal", "-shm", "-journal"].some((suffix) => existsSync(`${path}${suffix}`))) {
    throw new Error(`${label} database bytes changed during observation`);
  }
  return observation;
}
