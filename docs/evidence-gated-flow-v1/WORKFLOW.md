# Agent delivery workflow

Status: local working contract, 2026-08-27. This replaces the retrospective
PRD/design/task chain and its runtime policy JSON.

## Outcome

Ship coherent changes with Codex as coordinator and sole writer, Grok as an
additional read-only reviewer, MAP as the maintained planning/review method,
and deterministic code as the authority for state changes.

The workflow optimizes for a correct small system. A review finding should
remove a defect class or expose a missing invariant. It must not start an
unbounded patch-and-review loop.

## Fixed boundaries

- Codex owns planning, architecture, implementation, verification, workflow
  state, and the task-worktree mutation lease.
- Grok receives immutable `workspace-read` packets only. It can audit or
  criticize; it cannot write, approve a transition, or replace Codex during an
  outage.
- Provider text is an observation. Typed validators, durable state, exact
  source identity, and human authority decide transitions.
- Live provider probes, paid runs, publication, push, PR, deployment, and
  credential changes need their own explicit human approval.
- Permission or safety denial never fails over. Provider outage may defer a
  review lane; it does not transfer writer authority.

## Four runtime primitives

| Primitive | Owns | Must not own |
|---|---|---|
| `Snapshot` | repository, branch, base, HEAD, diff, source and MAP identity | stage policy |
| `Gate` | one typed transition decision from current evidence | work execution |
| `Run` | durable attempt, lease, result, recovery and audit row | policy duplication |
| `Adapter` | Codex, Grok and MAP transport formatting | approval or domain decisions |

Functionality, persistence, state transitions, audit evidence, and broker
decisions stay with their owning service. An adapter may project a decision but
cannot make the same decision again.

`ExecutionSnapshot` is the canonical immutable packet. It binds workflow and
stage identity, complete workspace evidence, the verified MAP profile, promoted
learning, routing and the exact authority consumer. `ExecutionAdmission` is the
only gate that reconstructs and compares that packet. Service code prepares a
candidate, runtime dispatch delegates to the gate, and the CLI runner performs
the same durable comparison immediately before process launch.

For a new mutable workflow, exact review barriers, single-use authority
consumption and creation of workflow plus dispatch outbox commit in one SQLite
`BEGIN IMMEDIATE` transaction. Any failure rolls the whole admission back. A
retry must present the same canonical snapshot; a conflicting replay, changed
source, changed MAP profile or changed learning binding is rejected before a
provider starts.

## Main flow

```text
Snapshot -> MAP plan -> architecture gate -> Codex run -> deterministic check
   ^                                                       |
   |                                                       v
learned class guard <- bounded review <- exact review packet
```

Every arrow is conditional. Downstream evidence becomes stale when the bound
snapshot or an owning decision changes.

## Stages

| Stage | MAP use | Required output | Gate |
|---|---|---|---|
| Intake | `/map-understand` when discovery is needed | objective, boundaries, alternatives | exact target is known |
| Plan | `/map-plan` | one selected design, risks, acceptance cases | architecture owner accepts the packet |
| Simplify | `/map-efficient` | deletion/reuse plan and code budget | no parallel owner or fallback |
| Implement | MAP actor path, Codex only | coherent diff plus characterization | changed behavior has a real test seam |
| Verify | `/map-check` | focused tests, typecheck/build, relevant integration evidence | deterministic gates pass |
| Review | `/map-review` | bounded Codex/Grok auditor and critic verdicts | exact packet has no blocking finding |
| Learn | `/map-learn` plus local registry | class guard, regression and sibling scan | code-owned executor evidence passes |

Use MAP end to end, but keep its role explicit: MAP structures work and review;
project code owns authority, persistence, recovery, and provider restrictions.

## Entry packet

A stage starts from a compact packet, not accumulated chat history:

- objective and non-goals;
- repository, branch, base, HEAD, diff and worktree identity;
- accepted decisions and their consumers;
- observable Given/When/Then cases;
- owner map for functionality, persistence, transitions, evidence, UI and
  broker/proxy behavior;
- validation budget and forbidden side effects;
- current MAP profile and learned-rule identity.

Missing identity or authority blocks before provider launch. The raw approval
reference is exchanged for an exact single-use receipt and is not propagated as
general permission.

## Branches and recovery

| Condition | Result |
|---|---|
| target identity differs from the packet | invalidate downstream work and re-plan |
| architecture or owner is ambiguous | stop before implementation |
| Codex unavailable | durable bounded retry; no Grok writer fallback |
| Grok unavailable during review | keep its lane deferred and artifact-bound |
| safety or permission denial | terminal blocked state; no retry or transfer |
| compiler, test, typecheck or build fails | return to the owning design/code surface |
| review is failed, stale, inconclusive or requests changes | gate stays closed |
| process dies after durable claim | recover the same run with lease fencing |
| outcome is ambiguous after launch | require reconciliation; never synthesize PASS |
| one defect class repeats twice | reset the owning design, do not add another patch |
| two review cycles do not close the stage | gate remains blocked with open risks |

Recovery reuses immutable attempt identity where safe. Changed request bytes,
source, policy, lease, or authority fail closed and require a new authorized
snapshot.

Outcome classes have one source in `domain/outcomes.ts`. A generic queue `Run`
may retry delivery only before a domain effect owns the result. A Codex workflow
outage closes the old run, then the workflow reducer schedules one bounded new
Codex dispatch. A Grok outage is recovered only as a new attempt in the same
immutable read-only review lane. Provider output cannot create a replay run,
and the writer lease has no transfer operation.

## Review contract

Review the whole affected invariant, not only changed lines. The packet carries
the exact artifact bytes, prompt, snapshot, launch identity and coverage target.
Four lanes may be used when risk warrants them:

- Codex architecture/maintainability auditor;
- Codex corrective critic;
- Grok architecture/maintainability auditor;
- Grok corrective critic.

One bounded audit and one correction pass are the default. A repeated comment
must become a deterministic validator, mutation, or documented design change.
It must not produce another receipt layer.

## Learning contract

Only classes in `src/flow/learning-policy.ts` can close automatically. Each
class binds one scenario, stage, owner, oracle, control, behavior guard,
root-cause class and old-code mutation.

Closure needs three current-code results: the fix, a regression that catches
the old-code mutation, and a sibling-surface scan. All bind the same source and
candidate. Four durable read-only review lanes bind the same task packet.
Unsupported or mismatched findings remain open.

Promoted rules are provider-neutral and project-scoped. They are revalidated at
dispatch and immediately before Codex or Grok starts.

## MAP lifecycle

The installed profile is `full`/`lite`, version `3.28.1`, revision
`1ba52a77b8228a509f3ef08c4fb1f89465699a73`; automatic updates and `/map-auto`
remain disabled. `map-profile-lock.json` is the checked-in identity.

`npm run map:update` builds an isolated candidate with pinned `uv` and
Bubblewrap, verifies the candidate offline, and never mutates the active
profile. Promotion requires a separate reviewed decision. Routine profile
checks use `npm run map:verify`.

## Stage close

A refactor-only stage closes when:

- focused post-refactor tests, typecheck/build, and relevant broader gates pass;
- the final owner scan finds no duplicate decision or obsolete fallback;
- maintained runtime code decreases; report files and lines added/removed;
- open risks and skipped checks are named;
- no commit, push, PR or external run occurred without its explicit authority.

Canonical local commands:

```bash
npm run test:flow
npm run typecheck
npm run build
npm run map:verify
```
