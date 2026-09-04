import { canonicalJson } from "../domain/canonical-json.js";
import {
  StateFileDurability,
  type PinnedStateFile,
  type StateFileFaultInjector,
} from "./state-file-durability.js";

const JSONL_PATH = "IMPLEMENTATION_PROGRESS.jsonl";
const MARKDOWN_PATH = "IMPLEMENTATION_PROGRESS.md";
const SHA256 = /^[a-f0-9]{64}$/;

interface ProjectionPins {
  readonly jsonl: PinnedStateFile;
  readonly markdown: PinnedStateFile;
}

function parseJsonl(bytes: Buffer): Array<Record<string, unknown>> {
  const text = bytes.toString("utf8");
  if (text.length === 0 || !text.endsWith("\n")) {
    throw new Error("progress projection reread is corrupt: JSONL must be nonempty and newline-terminated");
  }
  return text.slice(0, -1).split("\n").map((line, index) => {
    let value: unknown;
    try { value = JSON.parse(line); }
    catch (error) {
      throw new Error(`progress projection reread JSONL is corrupt at line ${index + 1}`, { cause: error });
    }
    if (value === null || typeof value !== "object" || Array.isArray(value) || canonicalJson(value) !== line) {
      throw new Error(`progress projection reread JSONL is noncanonical at line ${index + 1}`);
    }
    return value as Record<string, unknown>;
  });
}

export class ImplementationProgressProjectionFiles {
  readonly #durability: StateFileDurability;
  readonly #faultInjector: StateFileFaultInjector | undefined;
  #pins: ProjectionPins | undefined;

  constructor(input: {
    readonly packageRoot: string;
    readonly stateRoot: string;
    readonly faultInjector?: (point: string) => void;
  }) {
    this.#faultInjector = input.faultInjector;
    this.#durability = new StateFileDurability({
      stateRoot: input.packageRoot,
      ...(input.faultInjector ? { faultInjector: input.faultInjector } : {}),
    });
    if (typeof input.stateRoot !== "string" || input.stateRoot.length === 0) {
      throw new Error("progress projection state root is required");
    }
  }

  publish(input: {
    readonly jsonlBytes: Buffer;
    readonly markdownBytes: Buffer;
    readonly watermarkSequence: number;
    readonly watermarkEventSha256: string;
  }): { jsonlPath: string; markdownPath: string } {
    this.#assertWatermark(input);
    if (!Buffer.isBuffer(input.jsonlBytes) || !Buffer.isBuffer(input.markdownBytes)) {
      throw new Error("progress projection publication requires Buffer bytes");
    }
    this.#closePins();
    let jsonl: PinnedStateFile | undefined;
    let markdown: PinnedStateFile | undefined;
    try {
      jsonl = this.#durability.atomicReplace({
        relativePath: JSONL_PATH,
        bytes: input.jsonlBytes,
        faultPointPrefix: "jsonl",
      });
      markdown = this.#durability.atomicReplace({
        relativePath: MARKDOWN_PATH,
        bytes: input.markdownBytes,
        faultPointPrefix: "markdown",
      });
      this.#pins = { jsonl, markdown };
      return { jsonlPath: jsonl.absolutePath, markdownPath: markdown.absolutePath };
    } catch (error) {
      jsonl?.close();
      markdown?.close();
      if (error instanceof Error && /regular no-follow file|identity changed|symbolic/i.test(error.message)) {
        throw new Error("progress projection symlink path or regular file nofollow validation failed", { cause: error });
      }
      throw error;
    }
  }

  verify(input: { readonly watermarkSequence: number; readonly watermarkEventSha256: string }): void {
    this.#assertWatermark(input);
    this.#faultInjector?.("before_projection_reread");
    const temporary = this.#pins === undefined;
    let openedJsonl: PinnedStateFile | undefined;
    let pins: ProjectionPins;
    if (this.#pins) {
      pins = this.#pins;
    } else {
      openedJsonl = this.#durability.openPinned(JSONL_PATH);
      try {
        pins = { jsonl: openedJsonl, markdown: this.#durability.openPinned(MARKDOWN_PATH) };
      } catch (error) {
        openedJsonl.close();
        throw error;
      }
    }
    try {
      pins.jsonl.assertCurrent();
      pins.markdown.assertCurrent();
      const events = parseJsonl(pins.jsonl.read());
      if (events.length !== input.watermarkSequence ||
          events.some((event, index) => event.sequence !== index + 1)) {
        throw new Error("progress projection reread sequence watermark is corrupt");
      }
      const last = events.at(-1);
      if (!last || last.eventSha256 !== input.watermarkEventSha256) {
        throw new Error("progress projection reread event digest watermark mismatch");
      }
      const markdown = pins.markdown.read().toString("utf8");
      const watermarkMatches = [...markdown.matchAll(/Verified events:\s*(\d+)/gi)];
      if (watermarkMatches.length !== 1 || Number(watermarkMatches[0]![1]) !== input.watermarkSequence) {
        throw new Error("progress projection reread Markdown watermark is corrupt");
      }
      pins.jsonl.assertCurrent();
      pins.markdown.assertCurrent();
    } finally {
      if (temporary) {
        pins.jsonl.close();
        pins.markdown.close();
      }
    }
  }

  assertCurrent(): void {
    if (!this.#pins) throw new Error("progress projection files have no pinned publication to revalidate");
    try {
      this.#pins.jsonl.assertCurrent();
      this.#pins.markdown.assertCurrent();
    } catch (error) {
      throw new Error("progress projection path revalidation detected a symlink, identity change or TOCTOU", {
        cause: error,
      });
    }
  }

  #assertWatermark(input: { readonly watermarkSequence: number; readonly watermarkEventSha256: string }): void {
    if (!Number.isSafeInteger(input.watermarkSequence) || input.watermarkSequence < 1 ||
        !SHA256.test(input.watermarkEventSha256)) {
      throw new Error("progress projection watermark or digest is invalid");
    }
  }

  #closePins(): void {
    if (!this.#pins) return;
    this.#pins.jsonl.close();
    this.#pins.markdown.close();
    this.#pins = undefined;
  }
}
