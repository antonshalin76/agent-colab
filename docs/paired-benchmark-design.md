# Grok/Codex paired benchmark

Status: harness certification gate active; no accepted measurement run, 2026-08-24

## Objective

Measure which agent should own each collaboration stage and which complete role
allocation performs better on local coding work. The benchmark compares Grok
4.6 and GPT-5.6 Sol under matched effort, task image, skills, functional tool
surface, limits, and deterministic acceptance checks.

The benchmark does not modify the source checkouts. Every attempt runs in a
fresh, sealed copy created from a pinned Git revision.

## Claims the benchmark may make

The benchmark may conclude only one of:

- `keep_provisional`: no tested alternative beats the current canary policy;
- `candidate_change`: a tested owner or policy is eligible for a controlled
  routing canary;
- `inconclusive`: parity, sample size, availability, oracle, or confidence
  requirements were not met.

It never edits `routing-v3` automatically. Results apply to the tested coding
agents, CLI versions, skill bundle, repositories, tasks, and machine profile;
they are not claims about the base models in every harness.

## Execution gates

The live study is a four-stage chain. A later stage cannot run from a command
flag alone; it must validate the hash-bound receipts from every prior stage.

1. `certify-harness` makes no model requests. It validates corpus and source
   locks, the frozen common skill bundle, exact provider command builders and
   output parsers, containment, cleanup and budget enforcement, C++/ASan and
   Translator Python oracle runtimes, terminal persistence, resume, blind
   mapping, scoring, and failure classification.
2. `certify-providers` requires a passed harness receipt and, once its current
   evidence blockers are resolved, makes exactly one disposable capability
   request to each provider at `medium`. Each agent must read, search, edit, run
   a local test, read the same frozen skill bundle, return the exact model,
   effort, protocol, and telemetry schema, and leave sanitized native
   tool-activity evidence. The probe must also prove that model-invoked
   subprocesses cannot reach arbitrary HTTP or localhost services while the
   provider client is online.
3. `run-canary` requires both certifications and runs one paired cell: two
   provider requests, one hidden oracle per completed arm, and no statistical
   or routing conclusion. Newly generated Git-ignored build outputs are kept
   out of the scored diff; tracked source changes remain visible.
4. `run-measurement` requires a passed canary receipt and a fully runnable
   corpus. It remains blocked if any hidden oracle is missing.

Every receipt binds the harness implementation, corpus and suite, evaluator,
skills, functional tools, environment, provider command profile, source
receipts, and machine profile. Changing any bound input requires certification
from the first stage again. Receipt hashes detect accidental or uncoordinated
drift; they are not signatures against a malicious process with the same OS
account. The former `run-pilot` entry point is disabled.

## Study modes

### Stage pair

`stage_pair` is the primary mode for role assignment. One variable changes per
paired block.

- Planning: both providers receive the same task image and produce a plan. The
  two plans are passed independently to the same fixed downstream executor and
  reviewer profile. Their identities stay blinded.
- Implementation: both providers receive the same frozen task and plan in
  independent copies.
- Review: both providers inspect the same immutable candidate diff. Findings
  are first scored for precision/recall without remediation. When post-review
  quality is measured, one fixed remediation executor applies each blinded
  finding set in a fresh copy; reviewer edits are never compared directly.
- Coordination, architecture, BDD, testing, and infrastructure use the same
  rule: only the stage owner changes; other inputs are fixed or balanced with a
  declared Latin-square schedule.

### Policy crossover

`policy_crossover` compares complete collaboration policies end to end. Arm A
uses the current candidate allocation. Arm B uses the exact inverse. Both arms
start from the same task image and matched limits. A crossover result may rank
whole policies, but it cannot by itself identify the best owner of a specific
stage.

## Corpus

The full v1 corpus is balanced across two repositories and four work types.

| Case | Repository | Category | Primary seam |
|---|---|---|---|
| PUNTO-REF-01 | punto | refactor | duplicate core/tray configuration parsing |
| PUNTO-REL-02 | punto | reliability | slow Unix-socket client and bounded shutdown |
| PUNTO-BUG-03 | punto | bug | strict IPC command grammar |
| PUNTO-OPT-04 | punto | optimization | edit-distance hot path |
| TR-REF-01 | translator | refactor | sync/async source-commit finalization |
| TR-REL-01 | translator | reliability | audio graph self-healing regression |
| TR-BUG-01 | translator | bug | terminal utterance identity cleanup |
| TR-OPT-01 | translator | optimization | deterministic PCM transform |

The canary selects one runnable case at `medium` effort and launches one paired
cell. It validates the live path only and does not estimate a provider effect,
change routing, or claim AB/BA balance.

The full study is specified for all eight cases at `medium`, `high`, and
`xhigh`, with four fresh paired repetitions per cell. Six cases remain
`runnable:false` until their executable hidden oracles are implemented. The
harness therefore refuses a full launch today; task text and rubric metadata
alone are not counted as evidence. The even repetition count gives every case
exact AB/BA balance. The run order is fixed before launch from the suite seed.
Stopping early after a favorable result is forbidden.

Target stage coverage is declared before execution. It becomes actual coverage
only after the corresponding cells and oracles complete:

| Stage family | Full-study target |
|---|---|
| planning and PRD | all eight task packets |
| architecture | refactor and reliability cases |
| BDD and test design | bug and reliability cases |
| TDD coding and unit testing | all eight implementation cases |
| code/test audit, critic, and review | frozen seeded candidates for all cases |
| coordination | policy-crossover traces only; no isolated owner claim |
| UI/UX | not covered |
| e2e scenario and infrastructure | not covered |

The current executable canary can cover only one bug-fix `tdd_coding` path. It
cannot promote a routing assignment. The report must reject owner conclusions
for uncovered stages. UI/UX and e2e roles require a later corpus with
rendered-interface and isolated-system oracles; v1 cannot promote those
assignments.

## Frozen inputs and parity

Each cell records:

```text
suite id and case id
source commit and tree hash
task image, seed patch, prompt, oracle, and artifact hashes
anonymous candidate label
provider, exact model, effort, CLI version, and session id
resolved skill manifest and instruction fingerprints
functional tool profile and native tool manifest
wall timeout, output and diff limits, attempt count
OS, CPU, memory, locale, timezone, toolchains, and lockfile hashes
run seed, launch order, harness version, and sanitized environment hash
```

Both `/home/anton/.grok/skills` and `/home/anton/.codex/skills` must resolve to
the same canonical shared skill tree. The manifest hashes every selected
`SKILL.md` and referenced file. Provider-native and bundled instructions are
fingerprinted separately because they cannot be made identical.

Allowed functional tools are read, search, patch/edit, and bounded local test
execution. Web, MCP, subagents, external communication, system services, live
audio, provider API smoke tests, model downloads, package installation, and
access outside the attempt copy are forbidden. Native tool surfaces are stored
as evidence. Because the outer provider client needs network access, its
capability probe runs a localhost sentinel and fails certification if a
model-invoked subprocess reaches it. The retained receipt records only the
denial result and sanitized tool categories. A material conformance mismatch marks the cell
`harness_confounded` and excludes it from routing decisions.

## Source isolation

The harness creates a sealed snapshot from the pinned Git object database and
removes every remote from the copy. Ignored files, `.env`, build artifacts,
model caches, historical outputs, and the source repository's `.git` metadata
are absent. Each candidate starts from a separate copy of the sealed image.

Before and after a suite, the harness records the source commit, tree, complete
status, tracked diff hashes, submodule state, and required fixture manifest.
The agents receive only opaque workspace paths. Any detected source mutation
invalidates the run and stops further launches.

Hidden tests, seed manifests, golden patches, prior transcripts, anonymous
identity mappings, and previous attempts are outside candidate workspaces.
Every attempt uses a fresh session and memory namespace. Cross-agent history
and memory retrieval are disabled during evaluation.

## BDD acceptance scenarios

### PB-01 Source immutability

Given a pinned source repository with user changes or ignored artifacts, when a
case is prepared and executed, then only tracked files from the selected Git
revision enter the sealed image, both arms share the same image hash, and the
source integrity receipt is unchanged after the run.

### PB-02 Matched cell

Given a paired cell, when preflight compares both providers, then exact model,
task packet, selected skills, functional tools, timeout, output limit, diff
limit, environment contract, and oracle match the sealed pair profile. The
profile requires `(Grok, grok-4.6)` and `(Codex, gpt-5.6-sol)` with the same
effort label; it does not require the two model IDs to be equal. A profile
mismatch prevents launch and records `inconclusive` or `harness_confounded`.

### PB-03 Isolated stage effect

Given a stage-pair block, when Grok and Codex execute it, then only the tested
stage owner changes. Both candidates are scored against the same frozen
downstream input or immutable review artifact.

### PB-04 Policy crossover

Given a policy-crossover block, when both arms run, then their complete role
maps are inverses, the initial image and limits match, and the result is used
only to compare whole policies.

### PB-05 Blind deterministic scoring

Given completed candidates, when scoring starts, then the evaluator sees opaque
labels and receives hidden tests only after the provider process exits. Provider,
session, path, author, and ordering metadata are absent from judge artifacts.

### PB-06 Failure classification

Given auth, quota, model, CLI, skill, or capability failure before a paired
block, then neither half counts and the block is `inconclusive`. A task timeout,
crash, invalid result, or policy violation after launch is an execution outcome
and counts toward reliability. Harness failure cancels both halves and permits
only a fresh full-block retry.

### PB-07 Bounded execution

Given an active attempt, when its wall, output, diff, file-count, or process
budget is exceeded, then the process group is terminated, cleanup is verified,
and the attempt cannot be reported as success.

### PB-08 Reproducible evidence

Given a completed block, when its report is opened, then every immutable input,
order decision, exit state, truncation reason, oracle result, usage provenance,
and candidate diff can be verified from stored hashes without reading hidden
reasoning or raw tool payloads.

### PB-09 No evaluation leakage

Given repeated cells, when a new attempt starts, then it cannot retrieve prior
transcripts, previous patches, hidden tests, identity maps, or results. Leakage
invalidates the complete paired block.

### PB-10 Provider recovery

Given a provider outage before launch, when it later recovers, then the harness
creates a new paired block with fresh images and sessions. Production failover
is never used inside the study.

## Metrics

Mandatory gates are source integrity, policy compliance, build/test oracle, and
forbidden-side-effect checks. Failure of any mandatory gate disqualifies that
attempt.

Primary quality metrics:

- deterministic oracle score and pass rate;
- seeded or known defect recall;
- review finding precision and recall;
- post-review oracle score;
- regression and escaped-defect count.

Secondary metrics:

- lines and files changed outside the expected surface;
- reviewer rework from first submission to accepted result;
- wall time by stage and end to end;
- input, cached input, output, reasoning, and total tokens;
- provider-reported cost when available;
- versioned API-equivalent cost estimate when actual cost is unavailable;
- execution and environment failure rates.

Unavailable usage or cost fields remain `null`; they are never recorded as
zero. Judges do not see latency, tokens, cost, provider, or arm identity until
quality scoring is sealed.

Every case manifest contains an immutable deterministic rubric. Its checks have
integer weights summing to 100, identify hard gates, and specify exact commands
or evaluator functions. Bug cases weight functional and regression checks;
reliability cases weight failure, recovery, and cleanup; refactors weight
characterized behavior, structural reduction, and scope; optimizations weight
semantic equivalence, performance threshold, and scope. The rubric,
normalization, aggregation, and hidden fixtures are included in `oracleHash`.
Blind model scores are reported separately and cannot change deterministic
points. No weights or thresholds may change after the first cell launches.

## Decision rule

Quality is lexicographically primary.

1. A source mutation, safety violation, forbidden side effect, or mandatory
   regression disqualifies the attempt.
2. A stage owner or policy becomes `candidate_change` only when its paired
   median deterministic-quality improvement is at least 5 points on a 100-point
   scale and the predeclared 95% paired bootstrap interval is above zero.
3. For review stages, seeded-defect recall must not decrease and finding
   precision must remain at least 80%.
4. Execution failure rate must not worsen. Environment failures are reported
   separately and do not become model failures.
5. Time, tokens, and cost select between quality-noninferior candidates only.
   Noninferiority requires the lower confidence bound to stay above -2 quality
   points.
6. Missing pairs, missing usage provenance, unresolved blind-judge disagreement,
   or insufficient sample size returns `inconclusive`.

The full report includes every task and failed cell. Aggregation may not hide a
task-class regression behind a better overall mean.

## Runtime boundary

The benchmark is a standalone binary and isolated state root. It does not open
the production collaboration or history databases, does not reuse production
failover, and cannot update routing policy.

The canary persists a hash-locked manifest before its single cell and atomically
writes terminal observations, blind evidence, and a sealed identity mapping.
Measurement remains fail-closed until the complete full-run persistence path
and all hidden oracles are certified.

The repository also contains an isolated SQLite state machine for future
multi-process execution, but the canary does not yet use it. Therefore SQLite
durability is a target capability, not evidence claimed by the canary.
The current terminal states are:

```text
block:   planned -> preflighted -> running -> checked -> completed | inconclusive | failed
         planned | preflighted ------------------------> inconclusive
         running -------------------------------> inconclusive | failed

attempt: planned -> launched -> completed | failed | invalidated
```

Every terminal cell binds the manifest hash, seed, snapshots, frozen skill
bundle, tool/environment profiles, evaluator identity, launch order, and
terminal evidence. A terminal cell is never relaunched. Crash recovery for an
incomplete cell is deliberately fail-closed until the SQLite runner is wired
into the live CLI.

Responsibility boundaries:

| Responsibility | Owner |
|---|---|
| Suite and case validation | eval schema |
| Sealed copies and source integrity | snapshot service |
| Provider and environment parity | preflight service |
| CLI launch profile and normalized attempt result | provider adapter |
| Stage-pair schedule | deterministic scheduler |
| Current terminal persistence and resume | hash-locked files and CLI reconciliation |
| Future multi-process transitions | isolated eval store and experiment runner |
| Hidden checks | oracle boundary |
| Opaque labels, identity map, blinded artifacts | anonymization boundary |
| Metrics and decision rule | scoring service |
| Immutable machine and human reports | report writer |
| Production collaboration DB, UI, broker/proxy | N/A |

The CLI composes these owners but does not duplicate their decisions.
Provider command construction, exact-model parsing, capability probing, and
failure classification reuse the existing runner modules. The benchmark
adapter must not create a second interpretation of provider streams. Production
`STAGE_POLICY` is not consulted when constructing experimental assignments.

## Current evidence boundary

- Grok CLI: `1.0.5`; configured model: `grok-4.6`.
- Codex CLI: `0.147.0`; configured model: `gpt-5.6-sol`.
- The selected Grok and Codex skill manifests are identical; each run mounts a
  frozen read-only bundle rather than the mutable live skill tree.
- Earlier probes and eight-cell runs exposed infrastructure defects but were
  launched before this certification chain existed. They are retained as
  diagnostic negative controls only and provide no routing evidence. See the
  dated results document.
