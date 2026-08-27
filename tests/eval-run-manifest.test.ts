import { describe, expect, it } from "vitest";
import {
  compareRunManifestArmParity,
  computeFrozenSkillBundleHash,
  createEvalRunManifest,
  createRunManifestArtifactBindings,
  hashCanonicalJson,
  validatePersistedEvalRunManifest,
  type EvalRunManifestBody,
} from "../src/eval/run-manifest.js";

const sha = (character: string): string => character.repeat(64);

function contentProfile(
  payload: EvalRunManifestBody["functionalToolProfile"]["payload"],
) {
  return { payload, hash: hashCanonicalJson(payload) };
}

function policy(value: Record<string, "grok" | "codex">) {
  return { value, hash: hashCanonicalJson(value) };
}

function manifestBody(): EvalRunManifestBody {
  const skillFiles = [
    { path: "karpathy-guidelines/SKILL.md", sha256: sha("2") },
    { path: "agent-collaboration/SKILL.md", sha256: sha("1") },
  ];
  const baselinePolicy = policy({ tdd_coding: "codex", architecture: "codex" });
  const armAPolicy = policy({ architecture: "codex", tdd_coding: "codex" });
  const armBPolicy = policy({ architecture: "codex", tdd_coding: "grok" });
  const limits = {
    wallTimeoutMs: 600_000,
    outputLimitBytes: 1_000_000,
    diffLimitBytes: 500_000,
    maxFiles: 20,
    maxProcesses: 8,
    maxAttempts: 1 as const,
  };
  const artifacts = {
    corpusImageHash: sha("a"),
    suiteImageHash: sha("b"),
    case: {
      promptHash: sha("c"),
      taskImageHash: sha("d"),
      oracleImageHash: sha("e"),
      caseImageHash: hashCanonicalJson({
        promptHash: sha("c"),
        taskImageHash: sha("d"),
        oracleImageHash: sha("e"),
      }),
    },
    source: {
      revision: "1".repeat(40),
      treeHash: "2".repeat(40),
      seedPatchHash: sha("f"),
      seededImageHash: sha("0"),
    },
  };
  const skillBundle = {
    files: skillFiles,
    hash: computeFrozenSkillBundleHash(skillFiles),
  };
  const functionalToolProfile = contentProfile({
    version: "functional-tools-v1",
    capabilities: ["read", "search", "edit", "test"],
  });
  const environmentContract = contentProfile({
    network: "provider-api-only",
    workspace: "sealed-copy",
    locale: "C.UTF-8",
  });
  const machineToolchainProfile = contentProfile({
    architecture: "x86_64",
    node: "24.10.0",
    git: "2.51.0",
  });
  const evaluator = {
    version: "blind-evaluator-v1",
    implementationHash: sha("8"),
  };
  const binding = {
    corpusImageHash: artifacts.corpusImageHash,
    suiteImageHash: artifacts.suiteImageHash,
    caseImageHash: artifacts.case.caseImageHash,
    promptHash: artifacts.case.promptHash,
    taskImageHash: artifacts.case.taskImageHash,
    oracleImageHash: artifacts.case.oracleImageHash,
    sourceRevision: artifacts.source.revision,
    sourceTreeHash: artifacts.source.treeHash,
    seedPatchHash: artifacts.source.seedPatchHash,
    seededImageHash: artifacts.source.seededImageHash,
    baselinePolicyHash: baselinePolicy.hash,
    effort: "high" as const,
    limitsHash: hashCanonicalJson(limits),
    skillBundleHash: skillBundle.hash,
    functionalToolProfileHash: functionalToolProfile.hash,
    environmentContractHash: environmentContract.hash,
    machineToolchainProfileHash: machineToolchainProfile.hash,
    evaluatorImplementationHash: evaluator.implementationHash,
    harnessVersion: "agent-collab-eval@0.1.0+abc123",
  };

  return {
    version: "agent-collab-eval-run-manifest-v1",
    harnessVersion: binding.harnessVersion,
    cell: {
      blockId: sha("9"),
      suiteId: "punto-translator-v1",
      caseId: "PUNTO-BUG-03",
      stage: "tdd_coding",
      repetition: 0,
      effort: "high",
      launchOrder: ["grok", "codex"],
    },
    artifacts,
    baselinePolicy,
    skillBundle,
    functionalToolProfile,
    environmentContract,
    machineToolchainProfile,
    limits,
    evaluator,
    arms: [
      {
        armId: "armA",
        provider: "codex",
        policy: armAPolicy,
        identity: {
          requested: {
            providerId: "openai",
            modelId: "gpt-5.6-sol",
            cliVersion: "codex-cli 0.147.0",
          },
          reported: {
            providerId: "openai",
            modelId: "gpt-5.6-sol",
            cliVersion: "codex-cli 0.147.0",
            provenance: "provider_reported",
          },
        },
        nativeInstructionHash: sha("6"),
        nativeToolProfile: contentProfile({
          toolIds: ["shell", "apply_patch"],
          protocol: "codex-exec",
        }),
        parityBinding: binding,
      },
      {
        armId: "armB",
        provider: "grok",
        policy: armBPolicy,
        identity: {
          requested: {
            providerId: "xai",
            modelId: "grok-4.6",
            cliVersion: "grok 1.0.5",
          },
          reported: {
            providerId: "xai-edge",
            modelId: "grok-4.6-202608",
            cliVersion: "grok 1.0.5+5115b46",
            provenance: "provider_reported",
          },
        },
        nativeInstructionHash: sha("7"),
        nativeToolProfile: contentProfile({
          toolIds: ["read_file", "run_terminal_cmd", "search_replace"],
          protocol: "grok-single",
        }),
        parityBinding: { ...binding },
      },
    ],
  };
}

describe("immutable paired eval run manifest", () => {
  it("canonicalizes policy and skill ordering into a deterministic hash-locked cell manifest", () => {
    const input = manifestBody();
    const manifest = createEvalRunManifest(input);
    const reordered = structuredClone(input);
    reordered.baselinePolicy.value = {
      architecture: "codex",
      tdd_coding: "codex",
    };
    reordered.skillBundle.files.reverse();

    expect(createEvalRunManifest(reordered)).toEqual(manifest);
    expect(manifest.manifestHash).toMatch(/^[a-f0-9]{64}$/);
    expect(manifest.skillBundle.files.map((file) => file.path)).toEqual([
      "agent-collaboration/SKILL.md",
      "karpathy-guidelines/SKILL.md",
    ]);
    expect(Object.keys(manifest.baselinePolicy.value)).toEqual([
      "architecture",
      "tdd_coding",
    ]);
    expect(Object.isFrozen(manifest.arms[0].parityBinding)).toBe(true);
  });

  it("allows provider-native identity, instructions, and tools to differ while functional parity matches", () => {
    const manifest = createEvalRunManifest(manifestBody());
    const receipt = compareRunManifestArmParity(manifest.arms);

    expect(manifest.arms[0].identity).not.toEqual(manifest.arms[1].identity);
    expect(manifest.arms[0].nativeInstructionHash)
      .not.toBe(manifest.arms[1].nativeInstructionHash);
    expect(manifest.arms[0].nativeToolProfile.hash)
      .not.toBe(manifest.arms[1].nativeToolProfile.hash);
    expect(receipt).toMatchObject({
      matched: true,
      launchAllowed: true,
      classification: null,
      mismatches: [],
    });
  });

  it.each([
    ["taskImageHash", sha("9")],
    ["effort", "xhigh"],
    ["limitsHash", sha("9")],
    ["skillBundleHash", sha("9")],
    ["functionalToolProfileHash", sha("9")],
    ["environmentContractHash", sha("9")],
    ["machineToolchainProfileHash", sha("9")],
    ["evaluatorImplementationHash", sha("9")],
  ] as const)("rejects a %s parity mismatch", (field, replacement) => {
    const input = manifestBody();
    input.arms[1].parityBinding[field] = replacement as never;

    expect(compareRunManifestArmParity(input.arms)).toMatchObject({
      matched: false,
      launchAllowed: false,
      classification: "harness_confounded",
      mismatches: [field],
    });
    expect(() => createEvalRunManifest(input)).toThrow(/harness confounded/i);
  });

  it("validates the persisted manifest and all independently recaptured resume bindings", () => {
    const manifest = createEvalRunManifest(manifestBody());
    const bindings = createRunManifestArtifactBindings(manifest);

    expect(validatePersistedEvalRunManifest(
      JSON.parse(JSON.stringify(manifest)),
      bindings,
    )).toEqual(manifest);

    expect(() => validatePersistedEvalRunManifest(manifest, {
      ...bindings,
      seededImageHash: sha("9"),
    })).toThrow(/seededImageHash.*resume binding mismatch/i);

    const tampered = structuredClone(manifest);
    tampered.artifacts.case.oracleImageHash = sha("9");
    expect(() => validatePersistedEvalRunManifest(tampered, bindings))
      .toThrow(/manifest hash mismatch|case image hash mismatch/i);
  });

  it("rejects drift in nested hash-bound artifacts even if the outer manifest is rebuilt", () => {
    const skillsDrifted = manifestBody();
    skillsDrifted.skillBundle.files[0]!.sha256 = sha("9");
    expect(() => createEvalRunManifest(skillsDrifted)).toThrow(/skill bundle hash mismatch/i);

    const policyDrifted = manifestBody();
    policyDrifted.baselinePolicy.value.tdd_coding = "grok";
    expect(() => createEvalRunManifest(policyDrifted)).toThrow(/baseline policy hash mismatch/i);

    const profileDrifted = manifestBody();
    profileDrifted.environmentContract.payload.network = "unrestricted";
    expect(() => createEvalRunManifest(profileDrifted))
      .toThrow(/environment contract hash mismatch/i);
  });

  it("requires exactly one Grok and one Codex arm and a matching launch order", () => {
    const duplicate = manifestBody();
    duplicate.arms[1].provider = "codex";
    expect(() => createEvalRunManifest(duplicate)).toThrow(/providers.*distinct/i);

    const badOrder = manifestBody();
    badOrder.cell.launchOrder = ["grok", "grok"];
    expect(() => createEvalRunManifest(badOrder)).toThrow(/launch order/i);
  });
});
