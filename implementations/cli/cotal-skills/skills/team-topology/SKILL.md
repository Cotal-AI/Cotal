---
name: team-topology
description: Define a multi-agent team for ANY task on ANY system as an explicit deployment topology - pick the shape from the task's dominant risk, specify the runtime/communication/trust layers, place model capability by lane, present it as a diagram + table + trust-boundary note + open choices, and deploy ONLY after the user agrees to the proposed shape. Use when the user asks to "define/design/lay out the team", "what topology are we deploying", "how should the agents be arranged", "design the team for <task>", "what formation for <task>", or wants a team expressed as a topology (nodes, edges, models, trust boundaries) rather than spawned ad hoc. Substrate-agnostic - Cotal mesh, harness subagents, Workflow stages, containers, or any orchestration system.
---

# Team topology

A method for defining a multi-agent team for a task as an explicit topology: not "spawn some agents" but a legible deployment you can draw, hand off, and reason about. Who runs where, who talks to whom, what each node can touch, which model sits in which seat. Substrate-agnostic: the same method applies to a Cotal mesh, harness subagents, workflow stages, or plain processes.

## When to use

- The user asks to **define / design / lay out** a team or formation, or asks **"what topology?"**.
- You are about to stand up more than one or two agents and want them arranged deliberately.
- You need to communicate a running deployment in a scannable form.

## Step 1: pick the shape from the dominant risk

A topology is a defense against the way the task fails by default. Name the task's **dominant risk**, then pick the shape that structurally prevents it:

| Task type | Dominant risk | Shape |
|---|---|---|
| audit / review / research | missed findings, groupthink | **hub-and-spoke fan-out**: independent finder lanes, an adversarial verify tier, coordinator synthesizes |
| fix / implementation | write races, unverified changes | **writer lanes + merge authority**: 1-2 writers in isolated workspaces, everyone else fenced read-only, a proof gate before merge |
| staged transform (migration, ETL, generation) | loss at handoffs | **pipeline**: stages connected by explicit artifacts, each stage validates its input |
| open design question | anchoring on the first idea | **panel + judge**: N proposals produced blind, then scored and synthesized |
| long-running ops / monitoring | drift, silent death | **operator + watchdog**: one active node, one that only checks liveness and invariants |

This catalog is a starting set, **not a menu**. Hybrids are normal (an audit's repro tier is a small pipeline), and inventing a shape for the task at hand is expected. The **number of channels, tiers, and agents is a free parameter**: derive it from the task's size, risk, and budget (a quick check might be 1 channel / 2 agents; a deep audit 4 channels / 10). Never copy a previous deployment's headcount out of habit.

Every shape keeps **one coordinator**: the single node that spans the whole topology, holds the consolidated state, and owns final decisions. Usually that is you, the main session.

## Step 2: specify three layers

**Survey the live substrate state first - topologies rarely deploy onto a blank slate:**

- **Who is already up.** Roster / process list / task list: live peers from earlier generations, stale managers or supervisors, orphaned nodes. Decide per node: reuse, stop, or ignore - never assume greenfield, and never let a stale sibling silently share a channel with the new team.
- **Channel/stream state.** Does each channel already exist, and what do its history/replay semantics do to a NEW joiner - does joining backfill old traffic into their context? Replay into a fresh blind reviewer contaminates the lane; replay into a resuming coordinator may be exactly right. Choose fresh vs reused channels deliberately and set the replay/backfill mode per channel as part of the design, not as a discovered surprise.
- **Names.** Check for collisions against live AND dead/retired nodes. On substrates where teardown races or stale state can bleed onto a same-name successor, a dead name is not reusable - mint fresh generation-suffixed names.

Then specify the three layers:

1. **Runtime**: what actually executes each node (mesh peers as OS processes, harness subagents, workflow stages, containers) and the facts someone would otherwise assume wrong: shared vs isolated filesystem, one broker or many, per-node credentials or shared, where each node is rooted.
2. **Communication**: the edges. One channel/stream per team; point-to-point for private lanes; files/artifacts for pipeline handoffs. Name channels `<purpose>.<task>` (`review.control-surface`, `fix.billing`). State which nodes sit on which edge, and that no one else does.
3. **Trust**: what each node can read and write, enforced **by mechanism, not by request**: ACL-scoped credentials, read-only roles, isolated worktrees/sandboxes, a single merge authority. If a node must not edit, fence it so it *cannot*, and name the fence.

## Step 3: place capability by lane

**First, enumerate what actually exists - never fill a seat from memory.** Before naming any model, look up the harnesses, providers, model IDs, and variant/effort levels available in the current environment, and cite where each came from. A seat naming a model that does not exist (a misremembered ID, a variant the provider doesn't offer, a "default" left unspecified) invalidates the proposal. Sources to check, in order:

- **Existing persona/agent definitions** that have actually run (e.g. `.cotal/agents/*.md` `model:`/`variant:` frontmatter, `.claude/agents/*.md`) - ground truth for IDs that work on this machine.
- **Harness/provider config** (e.g. `~/.config/opencode/opencode.json` provider blocks with model IDs, limits, and their exact `variants`; connector configs) for what is wired up.
- **The harness's own listing** when one exists (e.g. `opencode models`).

Every seat gets an **explicit** model + variant; "default" is not a placement. If the user names a preference pool or per-provider caps (e.g. "at most N of provider X"), treat those as hard constraints and show the resulting counts.

Models are not uniform, and no vendor is assumed. Fill each seat by **strength class**, with whatever vendor/model best provides it in the current environment: adversarial-strong on attack/verify lanes, code-strong on implementation and deep review, research-capable on spec/fidelity lanes, fast-and-cheap on mechanical or high-fan-out runs. Two deliberate reasons to **mix vendors** across lanes: independent lanes on different vendors have less-correlated blind spots (a diversity mechanism, especially for verify tiers), and no single provider outage or rate limit stalls the whole team. Present placement as a table so it is auditable, and note any per-node override of a persona/stage default:

| Node | Edge | Model | Lane |
|---|---|---|---|
| (name) | (channel/stage) | (vendor/model, by strength class) | one line: what this node does and does not do |

## Step 4: present it (the deliverable is a PROPOSAL)

Every definition or status report produces all four:

1. the **ASCII diagram** of the shape (runtime spine, edges, coordinator at the hub),
2. the **node/model/lane table**,
3. a one-paragraph **trust-boundary note**: who the sole cross-edge node is, what confines everyone else, who may write,
4. the **open topology choices** as a short list (merge lanes? swap a model? add/drop a node?) so the user can steer the shape.

## Step 5: agree, then execute

The lifecycle is **design → present → agree → deploy**, and agreement is a hard gate:

- What you presented in Step 4 is a proposal, **not a launch order**. Do not spawn anything yet.
- Iterate with the user on the open choices; re-present the affected parts after each change (a changed row, not the whole document).
- Deploy only on the user's explicit go. When they say "go" with no edits, deploy exactly as drawn; any deviation forced during deployment (a model unavailable, a channel name taken) is reported back as a changed table row, not silently absorbed.
- After deploying, verify the topology is what was agreed (nodes up, confinement in force, coordinator subscribed to every edge), then report the **as-deployed** state in the same diagram + table format so drift from the agreed shape is visible.

## Hard rules (any substrate)

- **One coordinator.** Exactly one node spans edges; every other node lives on its one edge.
- **One node per role.** Never fan out siblings of the same lens; extras are noise, not coverage.
- **Writers are few and fenced.** Default to one writer per workspace; a second writer gets its own isolated workspace and goes through the merge authority. Everyone else is read-only, or read+run-only for testers.
- **Independent lanes stay blind until synthesis.** Findings and proposals meet at the coordinator or a verify tier, not in each other's context.
- **Cold third opinions are point-to-point.** A tie-breaker node is reached directly (DM, separate session), never seated on a team channel.
- **State every bound.** Node count, scope, and anything intentionally excluded are written down, so absence reads as a decision, not an oversight.

## Substrate notes

- **Cotal mesh**: each peer is its own process + minted credential under a manager (name the runtime: pty/orca/tmux/cmux). Confine via persona `allowSubscribe`/`allowPublish` frontmatter; author the `.cotal/agents/<name>.md` first, then (re)spawn so the credential is minted with the ACL. Spawn with an explicit `cwd` (the default roots peers in the manager's workspace). Verify your own subscriptions after joining every channel. Survey before spawning: roster + manager liveness (a dead manager inside `up` needs `supervise`; a stale long-lived manager pins pre-merge code and split-brains spawns), never reuse a dead agent's name, set channel replay deliberately (a joiner with replay ON back-reads history; a channel's durable backstop only activates on leave+rejoin, a bare re-join no-ops). Never disturb a live shared broker: kill by PID, no broad pkill. `mesh-teams` runs the review/implement/test loop; this skill specifies the shape it runs in.
- **Harness subagents / workflows**: the coordinator is the main session; prefer a streaming pipeline over barrier-synchronized stages; give parallel writers isolated workspaces; and use structured, schema-validated returns where the harness supports them.

## Worked example (one instantiation, not the template)

An audit of a security-critical feature, run hub-and-spoke on a Cotal mesh: three channels (`review.*` finders, `audit.*` verifiers, `test.*` testers); four finder lanes split by lens (security, distributed-systems, architecture, fact/spec), each on a different vendor's strongest fitting model; two adversarial verifiers on two further vendors, prompted to refute, not confirm; two read+run-only testers reproducing the HIGHs live; the coordinator subscribed to all three channels, reconciling severities across tiers. Sized at 3 channels / 8 agents because the surface was large and the risk was missed findings. The same method on a small fix task might instead produce 1 channel, 1 writer, 1 reviewer; on a migration, a 3-stage pipeline with no channels at all. The shape, the headcount, and the vendor mix are all outputs of Steps 1-3, never constants.
