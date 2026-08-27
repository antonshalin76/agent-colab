#!/usr/bin/env node
import { resolve } from "node:path";
import {
  projectMapLearning,
  verifyInstalledMapProfile,
} from "./map-admin.js";

const usage = [
  "Usage:",
  "  map-admin verify [project-root]",
  "  map-admin project <codex|grok> [project-root]",
].join("\n");

const command = process.argv[2];

function exactArgs(minimum: number, maximum = minimum): string[] {
  const args = process.argv.slice(3);
  if (args.length < minimum || args.length > maximum) throw new Error(usage);
  return args;
}

function print(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

try {
  if (command === "verify") {
    const [root = process.cwd()] = exactArgs(0, 1);
    print(verifyInstalledMapProfile(resolve(root)));
  } else if (command === "project") {
    const [consumer, root = process.cwd()] = exactArgs(1, 2);
    if (consumer !== "codex" && consumer !== "grok") throw new Error(usage);
    const receipt = projectMapLearning(resolve(root), consumer);
    print({
      profile: receipt.profile,
      projection: {
        consumer,
        digest: receipt.projection.digest,
        bytesBase64: Buffer.from(receipt.projection.bytes).toString("base64"),
      },
    });
  } else {
    throw new Error(usage);
  }
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
