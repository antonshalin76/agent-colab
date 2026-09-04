import Database from "better-sqlite3";
import { canonicalJson, computeJsonSha256 } from "../domain/canonical-json.js";
import { assertGraphV4PersistenceSchema } from "../migration/graph-v4-schema.js";
import { openStateStoreAccess, type StateDatabaseAccess } from "./state-database-fence.js";
import {
  BASELINE_PLAN_SHA256,
  IMPLEMENTATION_PLAN_ID,
  type JsonObject,
  type AmendmentCommitClaim,
  type AmendmentCommitPort,
  type AuthorizedAmendment,
} from "../flow/implementation-amendment.js";
import {
  buildAmendmentAcceptanceEvents,
  type VerifiedProgressEvent,
} from "../flow/implementation-progress.js";
import type {
  AuthorizedProgressEvent,
  ProgressEventCommitClaim,
  ProgressEventCommitPort,
  ProgressStoreIdentity,
} from "../flow/implementation-progress-authority.js";

declare const progressStoreAccessBrand: unique symbol;
export interface ProgressStoreAccess {
  readonly [progressStoreAccessBrand]: true;
}

export interface ProgressProjectionSnapshot {
  readonly watermarkSequence: number;
  readonly watermarkEventSha256: string;
  readonly events: readonly JsonObject[];
}

interface EventRow {
  plan_id: string;
  sequence_no: number;
  event_id: string;
  start_sha256: string;
  previous_event_sha256: string;
  effective_plan_sha256: string;
  event_json: string;
  event_sha256: string;
  created_at: number;
}

interface OutboxRow {
  event_id: string;
  projection_payload_json: string;
  published_at: number | null;
  terminal_reason: string | null;
}

interface VerifiedRows {
  readonly rows: readonly EventRow[];
  readonly outbox: readonly OutboxRow[];
  readonly events: readonly JsonObject[];
}

const SHA256 = /^[a-f0-9]{64}$/;

function eventRecord(value: unknown): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("progress ledger event projection is not an object");
  }
  return value as JsonObject;
}

export class ImplementationProgressStore {
  readonly #lease: StateDatabaseAccess;
  readonly #closeLease: () => void;
  readonly #database: Database.Database;
  readonly #faultInjector: ((point: string) => void) | undefined;
  readonly #progressAuthority: ProgressEventCommitPort | undefined;
  readonly #amendmentAuthority: AmendmentCommitPort | undefined;
  readonly #identity: ProgressStoreIdentity;
  readonly #issuedAccess = new WeakSet<object>();
  readonly #activeAccess = new WeakSet<object>();
  #closed = false;

  constructor(databasePath: string, options: {
    faultInjector?: (point: string) => void;
    progressAuthority?: ProgressEventCommitPort;
    amendmentAuthority?: AmendmentCommitPort;
  } = {}) {
    const opened = openStateStoreAccess(databasePath);
    this.#lease = opened.access;
    this.#closeLease = opened.close;
    this.#database = opened.access.database;
    this.#faultInjector = options.faultInjector;
    this.#progressAuthority = options.progressAuthority;
    this.#amendmentAuthority = options.amendmentAuthority;
    this.#identity = Object.freeze({ databasePath: opened.access.canonicalPath, generation: opened.access.generation });
    this.#progressAuthority?.attach(this.#identity);
    this.#amendmentAuthority?.attach(this.#identity);
    assertGraphV4PersistenceSchema(this.#database);
  }

  withImmediateTransaction<T>(operation: (access: ProgressStoreAccess) => T): T {
    this.#assertOpen();
    const transaction = this.#database.transaction(() => {
      const access = Object.freeze({}) as ProgressStoreAccess;
      this.#issuedAccess.add(access);
      this.#activeAccess.add(access);
      try { return operation(access); }
      finally { this.#activeAccess.delete(access); }
    });
    return transaction.immediate();
  }

  authorityIdentity(): ProgressStoreIdentity {
    this.#assertOpen();
    this.#lease.assertUsable();
    return this.#identity;
  }

  appendVerifiedEvent(input: AuthorizedProgressEvent): {
    eventId: string;
    sequence: number;
    replayed: boolean;
  } {
    const claims: ProgressEventCommitClaim[] = [];
    try {
      const result = this.withImmediateTransaction((access) => {
        const ledger = this.#verifiedRows();
        const replay = this.#exactReplay(ledger, input);
        if (replay) return replay;
        claims.push(this.#claim(input, ledger.events));
        return this.#appendVerifiedEvent(ledger, input);
      });
      for (const claim of claims) claim.complete();
      return result;
    } catch (error) {
      for (const claim of claims) claim.abort();
      throw error;
    }
  }

  appendVerifiedEventsAtomically(inputs: readonly AuthorizedProgressEvent[]): {
    eventId: string; sequence: number; replayed: boolean;
  } {
    if (inputs.length === 0) throw new Error("progress atomic append requires at least one authorized event");
    const claims: ProgressEventCommitClaim[] = [];
    try {
      const result = this.withImmediateTransaction((access) => {
        let first: { eventId: string; sequence: number; replayed: boolean } | undefined;
        for (const input of inputs) {
          this.#assertAccess(access);
          const ledger = this.#verifiedRows();
          const replay = this.#exactReplay(ledger, input);
          const current = replay ?? (() => {
            claims.push(this.#claim(input, ledger.events));
            return this.#appendVerifiedEvent(ledger, input);
          })();
          first ??= current;
        }
        return first!;
      });
      for (const claim of claims) claim.complete();
      return result;
    } catch (error) {
      for (const claim of claims) claim.abort();
      throw error;
    }
  }

  acceptVerifiedAmendment(input: { verifiedAmendment: AuthorizedAmendment; acceptedAt: number }): {
    effectivePlanSha256: string;
    replayed: boolean;
  } {
    let claim: AmendmentCommitClaim | undefined;
    try {
      const result = this.withImmediateTransaction((access) => {
        const ledger = this.#verifiedRows();
        if (ledger.events.length < 4) throw new Error("AMD-0001 acceptance requires the verified STG-03 predecessor");
        const predecessor = ledger.events[3]!;
        if (predecessor.eventId !== "stg-03-pass" || predecessor.effectivePlanSha256 !== BASELINE_PLAN_SHA256) {
          throw new Error("AMD-0001 predecessor or effective plan epoch is invalid");
        }
        const { acceptance, eligibility } = buildAmendmentAcceptanceEvents({ ...input, predecessor });
        const existingAcceptance = ledger.events[4];
        const existingEligibility = ledger.events[5];
        if (existingAcceptance !== undefined || existingEligibility !== undefined) {
          if (ledger.events.length >= 6 && canonicalJson(existingAcceptance) === canonicalJson(acceptance) &&
              canonicalJson(existingEligibility) === canonicalJson(eligibility)) {
            claim = this.#claimAmendment(input.verifiedAmendment, ledger.events);
            claim.abort();
            claim = undefined;
            return { effectivePlanSha256: input.verifiedAmendment.effectivePlanSha256, replayed: true };
          }
          throw new Error("AMD-0001 ordinal or authority replay conflicts with the immutable ledger");
        }
        if (ledger.events.length !== 4) throw new Error("AMD-0001 acceptance sequence conflicts with the ledger");
        claim = this.#claimAmendment(input.verifiedAmendment, ledger.events);
        this.#appendVerifiedEvent(ledger, {
          event: acceptance, eventJson: canonicalJson(acceptance), eventSha256: String(acceptance.eventSha256),
        });
        this.#faultInjector?.("after_amendment_acceptance_event");
        const afterAcceptance = this.#verifiedRows();
        this.#appendVerifiedEvent(afterAcceptance, {
          event: eligibility, eventJson: canonicalJson(eligibility), eventSha256: String(eligibility.eventSha256),
        });
        this.#faultInjector?.("after_step_eligible_event");
        this.#assertAccess(access);
        return { effectivePlanSha256: input.verifiedAmendment.effectivePlanSha256, replayed: false };
      });
      claim?.complete();
      return result;
    } catch (error) {
      claim?.abort();
      throw error;
    }
  }

  snapshotProjection(): ProgressProjectionSnapshot {
    this.#assertOpen();
    const ledger = this.#verifiedRows();
    const last = ledger.rows.at(-1);
    if (!last) throw new Error("progress projection requires a nonempty SQLite ledger");
    return Object.freeze({
      watermarkSequence: last.sequence_no,
      watermarkEventSha256: last.event_sha256,
      events: Object.freeze(ledger.events.map((event) => structuredClone(event))),
    });
  }

  markProjectionPublished(input: {
    readonly watermarkSequence: number;
    readonly watermarkEventSha256: string;
    readonly publishedAt: number;
  }): number {
    return this.withImmediateTransaction(() => {
      const ledger = this.#verifiedRows();
      const row = ledger.rows[input.watermarkSequence - 1];
      if (!row || row.sequence_no !== input.watermarkSequence || row.event_sha256 !== input.watermarkEventSha256) {
        throw new Error("progress projection watermark is stale or has an invalid event digest");
      }
      if (!Number.isSafeInteger(input.publishedAt) || input.publishedAt < 0) {
        throw new Error("progress projection publishedAt is invalid");
      }
      const result = this.#database.prepare(`UPDATE plan_progress_outbox SET published_at=?
        WHERE published_at IS NULL AND event_id IN (
          SELECT event_id FROM plan_progress_events WHERE plan_id=? AND sequence_no<=?
        )`).run(input.publishedAt, IMPLEMENTATION_PLAN_ID, input.watermarkSequence);
      return result.changes;
    });
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#closeLease();
  }

  #appendVerifiedEvent(
    ledger: VerifiedRows,
    input: VerifiedProgressEvent,
  ): { eventId: string; sequence: number; replayed: boolean } {
    const event = eventRecord(input.event);
    const eventId = String(event.eventId);
    const sequence = Number(event.sequence);
    const existingById = ledger.rows.find((row) => row.event_id === eventId);
    const existingBySequence = ledger.rows[sequence - 1];
    if (existingById || existingBySequence) {
      const existing = existingById ?? existingBySequence!;
      if (existing.event_id === eventId && existing.sequence_no === sequence &&
          existing.event_json === input.eventJson && existing.event_sha256 === input.eventSha256) {
        return { eventId, sequence, replayed: true };
      }
      throw new Error("progress event replay conflicts with immutable event bytes or sequence");
    }
    const predecessor = ledger.rows.at(-1);
    const expectedSequence = ledger.rows.length + 1;
    const expectedPrevious = predecessor?.event_sha256 ?? event.startSha256;
    const expectedPlan = predecessor?.plan_id ?? event.planId;
    const expectedStart = predecessor?.start_sha256 ?? event.startSha256;
    if (!eventId || !Number.isSafeInteger(sequence) || sequence !== expectedSequence ||
        event.planId !== expectedPlan || event.startSha256 !== expectedStart ||
        event.previousEventSha256 !== expectedPrevious || input.eventJson !== canonicalJson(event) ||
        input.eventSha256 !== event.eventSha256 || !SHA256.test(input.eventSha256)) {
      throw new Error("progress event sequence, predecessor, root, projection or hash is invalid");
    }
    const withoutDigest = structuredClone(event);
    delete withoutDigest.eventSha256;
    if (computeJsonSha256(withoutDigest) !== input.eventSha256) throw new Error("progress event canonical hash mismatch");
    const createdAt = Date.parse(String(event.recordedAt));
    if (!Number.isSafeInteger(createdAt)) throw new Error("progress event recordedAt is invalid");
    this.#database.prepare(`INSERT INTO plan_progress_events
      (plan_id,sequence_no,event_id,start_sha256,previous_event_sha256,effective_plan_sha256,
       event_json,event_sha256,created_at) VALUES (?,?,?,?,?,?,?,?,?)`).run(
      event.planId, sequence, eventId, event.startSha256, event.previousEventSha256,
      event.effectivePlanSha256, input.eventJson, input.eventSha256, createdAt,
    );
    this.#faultInjector?.("after_progress_event_insert");
    this.#database.prepare(`INSERT INTO plan_progress_outbox
      (event_id,projection_payload_json,published_at,terminal_reason) VALUES (?,?,NULL,NULL)`)
      .run(eventId, input.eventJson);
    this.#faultInjector?.("after_progress_outbox_insert");
    return { eventId, sequence, replayed: false };
  }

  #claim(input: AuthorizedProgressEvent, events: readonly JsonObject[]): ProgressEventCommitClaim {
    if (!this.#progressAuthority) {
      throw new Error("progress event has no store-bound verification authority capability");
    }
    return this.#progressAuthority.claim(input, events);
  }

  #claimAmendment(input: AuthorizedAmendment, events: readonly JsonObject[]): AmendmentCommitClaim {
    if (!this.#amendmentAuthority) {
      throw new Error("verified amendment has no store-bound acceptance capability attestation");
    }
    return this.#amendmentAuthority.claim(input, events);
  }

  #exactReplay(
    ledger: VerifiedRows,
    input: AuthorizedProgressEvent,
  ): { eventId: string; sequence: number; replayed: true } | undefined {
    const event = eventRecord(input.event);
    const row = ledger.rows.find((candidate) => candidate.event_id === event.eventId);
    if (!row) return undefined;
    if (row.sequence_no !== event.sequence || row.event_json !== input.eventJson ||
        row.event_sha256 !== input.eventSha256) {
      throw new Error("progress event replay conflicts with immutable event bytes or sequence");
    }
    // Even an exact replay must carry an authentic store-bound attestation. The
    // claim is immediately released because replay consumes no fresh authority.
    const claim = this.#claim(input, ledger.events.slice(0, row.sequence_no - 1));
    claim.abort();
    return { eventId: row.event_id, sequence: row.sequence_no, replayed: true };
  }

  #verifiedRows(): VerifiedRows {
    this.#assertOpen();
    this.#lease.assertUsable();
    assertGraphV4PersistenceSchema(this.#database);
    const rows = this.#database.prepare("SELECT * FROM plan_progress_events ORDER BY sequence_no").all() as EventRow[];
    const outbox = this.#database.prepare("SELECT * FROM plan_progress_outbox ORDER BY rowid").all() as OutboxRow[];
    if (rows.length !== outbox.length) {
      throw new Error("progress predecessor ledger and outbox projection counts differ");
    }
    const events: JsonObject[] = [];
    let previous: string | undefined;
    let planId: string | undefined;
    let startSha256: string | undefined;
    for (const [index, row] of rows.entries()) {
      let parsed: unknown;
      try { parsed = JSON.parse(row.event_json); }
      catch { throw new Error("progress ledger event JSON is corrupt"); }
      const event = eventRecord(parsed);
      const sequence = index + 1;
      if (canonicalJson(event) !== row.event_json || row.sequence_no !== sequence ||
          event.sequence !== sequence || row.plan_id !== event.planId || row.event_id !== event.eventId ||
          row.start_sha256 !== event.startSha256 || row.previous_event_sha256 !== event.previousEventSha256 ||
          row.effective_plan_sha256 !== event.effectivePlanSha256 || row.event_sha256 !== event.eventSha256 ||
          row.created_at !== Date.parse(String(event.recordedAt))) {
        throw new Error("progress ledger SQL projection integrity mismatch");
      }
      const withoutDigest = structuredClone(event);
      delete withoutDigest.eventSha256;
      if (!SHA256.test(row.event_sha256) || computeJsonSha256(withoutDigest) !== row.event_sha256) {
        throw new Error("progress ledger canonical event hash mismatch");
      }
      planId ??= row.plan_id;
      startSha256 ??= row.start_sha256;
      if (row.plan_id !== planId || row.start_sha256 !== startSha256 ||
          row.previous_event_sha256 !== (previous ?? startSha256)) {
        throw new Error("progress ledger root or predecessor chain is poisoned");
      }
      const projected = outbox[index];
      if (!projected || projected.event_id !== row.event_id ||
          projected.projection_payload_json !== row.event_json || projected.terminal_reason !== null) {
        throw new Error("progress outbox projection integrity mismatch");
      }
      previous = row.event_sha256;
      events.push(event);
    }
    return { rows, outbox, events };
  }

  #assertAccess(access: ProgressStoreAccess): void {
    this.#assertOpen();
    if (!this.#issuedAccess.has(access) || !this.#activeAccess.has(access)) {
      throw new Error("progress store access capability is not active for this transaction");
    }
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error("implementation progress store is closed");
  }
}
