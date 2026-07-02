/**
 * `cotal spawn -f cotal.yaml` — deploy a mesh manifest onto a RUNNING mesh (additive). The only
 * command that touches a mesh it doesn't own, so it is creation-only + ownership-scoped:
 *
 *  - classifies channels (new → seed + own · existing → `exists-unmanaged`, card untouched) and
 *    agents (will-create · already-owned · stale) against the live mesh + any prior ledger;
 *  - boots agents through the workspace-local manager's admin `launch` op (it reads the run spec by
 *    id and mints from the resolved policy — the control wire carries no authority);
 *  - records exactly what it created in a `cotal-ledger/v1` ledger so `down -f` removes only that;
 *  - flags unmanaged actors on declared channels as a SECURITY warning (an explicit lower bound).
 *
 * `--dry-run` prints the plan and mutates nothing; a stale declared agent exits non-zero unless
 * `--allow-stale <names>`.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  DEFAULT_SERVER,
  MANAGER_LEASE_TTL_MS,
  mintCreds,
  newIdentity,
  readChannelRegistry,
  seedChannelRegistry,
  type ControlReply,
  type MembershipSnapshot,
  type Presence,
} from "@cotal-ai/core";
import { c } from "../ui.js";
import { cotalRoot } from "../lib/paths.js";
import { connectOrExit } from "../lib/connect.js";
import { startManagerDetached } from "../lib/manager-proc.js";
import { loadManifest, type PreparedManifest } from "../lib/manifest/index.js";
import { buildLaunchSpec, channelsSeed, genRunId, preflightConnectors, writeLaunchSpec } from "../lib/manifest/apply.js";
import { buildLedger, hashManifestSource, listLedgers, writeLedger, type LedgerAgent } from "../lib/manifest/ledger.js";
import { classifyAgents, classifyChannels, detectUnmanagedActors } from "../lib/manifest/spawn-plan.js";
import { connectProbe, launchAgent, settleRoster, waitLeaseGone, waitManagerReady } from "../lib/manifest/live.js";
import { renderInherited, renderSpawnPlan, renderSpawnSummary, renderWarnings } from "../lib/manifest/render.js";
import { failManifest } from "./topology.js";

export interface SpawnManifestFlags {
  dryRun: boolean;
  server?: string;
  space?: string;
  runtime?: string;
  /** Narrow, named waiver of the stale-agent gate (apply-only; never suppresses security warnings). */
  allowStale?: string[];
}

const RUNTIMES = ["pty", "tmux", "cmux"];

/** Short control-plane probe to tell a LIVE lease-holder from a stale lease a crashed manager left
 *  behind (its key lingers until the bucket TTL). Kept well under {@link MANAGER_LEASE_TTL_MS}. */
const MANAGER_PROBE_MS = 3_000;

export async function spawnManifest(file: string, flags: SpawnManifestFlags): Promise<void> {
  const abs = resolve(file);
  let prepared: PreparedManifest;
  try {
    prepared = loadManifest(abs);
  } catch (e) {
    failManifest(e);
  }
  if (flags.runtime && !RUNTIMES.includes(flags.runtime)) {
    console.error(c.red(`✗ unknown --runtime "${flags.runtime}" — expected ${RUNTIMES.join(", ")}`));
    process.exit(1);
  }
  const eff = applyOverrides(prepared, flags);
  const m = eff.manifest;
  const space = m.space;
  const runtime = m.runtime ?? "pty";

  // Connectors + their binaries must exist before any mutation (no fallback).
  const connErr = preflightConnectors(eff);
  if (connErr) {
    console.error(c.red(`✗ connector preflight failed: ${connErr}`));
    process.exit(1);
  }

  // spawn -f deploys onto a RUNNING mesh — the broker MUST be reachable (opposite of up -f). Resolve
  // the mesh + mint a scoped `deployer` cred from the local registry/auth (same-checkout): the one
  // connectProbe endpoint below reads live state (roster/registry/membership/lease) AND admin-control
  // calls the manager's `launch`/`ps` — no `$JS.>`, no STREAM.DELETE, no DM read, no self-post. The
  // channel SEED rides a separate `channel-writer` cred (below), so the deploy cred writes no KV.
  const connection = await connectOrExit({ server: m.broker?.servers ?? flags.server, space }, "deployer");

  const root = cotalRoot();
  // Same-checkout invariant (security/UX): the launch spec, the ledger, and the manager `spawn -f`
  // drives all live under THIS checkout's `.cotal`. Deploying onto a mesh recorded by a different
  // checkout would decouple those local artifacts from that mesh's root/manager. Refuse unless the
  // resolved mesh is registered to this root; a raw off-registry target (no recorded root) isn't
  // supported for a manifest deploy.
  if (!connection.root) {
    console.error(c.red(`✗ spawn -f needs a mesh registered to this checkout — a raw off-registry target (--server/--space) isn't supported for a manifest deploy`));
    process.exit(1);
  }
  if (resolve(connection.root) !== resolve(root)) {
    console.error(c.red(`✗ mesh "${space}" belongs to a different checkout (${connection.root}) — \`spawn -f\` / \`down -f\` are same-checkout; run them from ${connection.root}`));
    process.exit(1);
  }
  const manifestHash = hashManifestSource(readFileSync(abs, "utf8"));

  // A prior ledger for this manifest content ⇒ a re-apply (reuse its runId, classify against it).
  // listLedgers fails closed (throws) on a symlinked `.cotal/manifests` — surface it cleanly.
  let priors: ReturnType<typeof listLedgers>;
  try {
    priors = listLedgers(root).filter((l) => l.ledger.manifestHash === manifestHash && l.ledger.space === space);
  } catch (e) {
    console.error(c.red(`✗ ${(e as Error).message}`));
    process.exit(1);
  }
  if (priors.length > 1) {
    console.error(c.red(`✗ ${priors.length} runs already deployed this manifest (${priors.map((p) => p.ledger.runId).join(", ")}) — tear one down first: \`cotal down -f ${file} --run <id>\``));
    process.exit(1);
  }
  const prior = priors[0]?.ledger;
  const runId = prior?.runId ?? genRunId();
  const ownedKeys = new Set(prior?.created.channels ?? []);
  const ownedIds = new Set((prior?.created.agents ?? []).map((a) => a.id));
  const ownedNames = new Set((prior?.created.agents ?? []).map((a) => a.name));

  const liveRegistry = await readChannelRegistry({ servers: connection.server, space, creds: connection.creds });
  const ep = await connectProbe({ space, server: connection.server, creds: connection.creds });
  try {
    const roster: Presence[] = await settleRoster(ep);
    const membership: MembershipSnapshot | null = await ep.readMembership().catch((e: Error) => {
      // An open mesh (or a space with no membership feed yet) has no bucket to read → degrade to null.
      // But an AUTHORIZATION rejection means this cred should hold the membership-feed read and doesn't
      // (a grant regression) — surface it rather than silently drop detectUnmanagedActors' safety check.
      if (/authoriz|permission|not authorized/i.test(e?.message ?? "")) throw e;
      return null;
    });

    const channelPlan = classifyChannels(m.channels, liveRegistry, ownedKeys);
    const agentPlan = classifyAgents(eff.agents, roster, prior);
    const unmanaged = detectUnmanagedActors(
      m.channels.map((ch) => ch.name),
      membership,
      roster,
      { ids: ownedIds, names: ownedNames },
    );

    if (flags.dryRun) {
      console.log(renderSpawnPlan(eff, channelPlan, agentPlan, unmanaged, { server: connection.server, runId, dryRun: true }));
      return;
    }

    // Stale gate (apply-only): a re-declared owned agent whose resolved policy changed must restart —
    // never silently keep running the old policy. Exit non-zero unless explicitly waived by name.
    const allow = new Set(flags.allowStale ?? []);
    const unwaived = agentPlan.stale.filter((e) => !allow.has(e.agent.name));
    if (unwaived.length) {
      console.error(c.red(`✗ ${unwaived.length} declared agent(s) are stale (policy changed) — restart required:`));
      for (const e of unwaived) console.error(c.red(`    ${e.agent.name}: ${e.prior?.name} hash ${e.prior?.hash.slice(0, 8)} → ${e.hash.slice(0, 8)}`));
      console.error(c.dim(`  Waive (they keep running the OLD policy until restarted): --allow-stale ${unwaived.map((e) => e.agent.name).join(",")}`));
      process.exit(1);
    }

    console.log(renderSpawnPlan(eff, channelPlan, agentPlan, unmanaged, { server: connection.server, runId, dryRun: false }), "\n");

    // 1) Seed ONLY brand-new channel keys — no defaults, no pre-existing/unmanaged card mutation. The
    //    write rides a SEPARATE, narrow `channel-writer` cred (the `deployer` cred writes no KV); open/raw
    //    meshes have no signing seed → fall back to the connection creds.
    if (channelPlan.create.length) {
      const seedCreds = connection.auth
        ? await mintCreds(connection.auth, newIdentity(), "channel-writer")
        : connection.creds;
      await seedChannelRegistry({ servers: connection.server, space, creds: seedCreds, file: channelsSeed(channelPlan.create) });
    }

    // 2-4) Boot the will-create agents through the workspace-local manager's admin `launch` op,
    //      capturing the SPAWNED name + id the ledger keys on (creds are filed under the
    //      collision-numbered spawned name, not the manifest key). Skipped entirely for a
    //      channels-only deploy — no need to stand up a manager.
    const agents: LedgerAgent[] = [...(prior?.created.agents ?? [])];
    const launchedNow: string[] = [];
    if (agentPlan.willCreate.length) {
      // The manager reads the run spec by runId on each `launch`.
      writeLaunchSpec(root, buildLaunchSpec(eff, runId), { update: Boolean(prior) });
      // Ensure a manager is SERVING this space, then validate it's ours — the lease is the authoritative
      // owner record. A held lease alone is not proof a manager is alive (a crashed holder's key lingers
      // until the bucket TTL, MANAGER_LEASE_TTL_MS), so read it (fast) and, when one exists, PROBE control to tell
      // a LIVE holder from a stale key. Never trust `.cotal/manager.pid` (blind to a manager started
      // another way — two managers queue-split every control op).
      const held = await ep.readManagerLease();
      if (!held) {
        // Nobody owns the space — stand up a manager (it acquires the lease on boot).
        startManagerDetached({ space, server: connection.server, runtime });
      } else if (!(await waitManagerReady(ep, MANAGER_PROBE_MS))) {
        // A lease exists but its holder doesn't answer control — a STALE key a crashed manager left. It
        // blocks a replacement's acquire until the bucket TTL expires; wait it out, then stand one up.
        console.log(c.dim(`  ~ a manager lease for "${space}" is present but unanswered (holder pid ${held.pid}); waiting up to ${Math.ceil(MANAGER_LEASE_TTL_MS / 1000)}s for it to expire…`));
        if (!(await waitLeaseGone(ep, MANAGER_LEASE_TTL_MS + 5_000))) {
          console.error(c.red(`✗ a manager lease for "${space}" is still held by an unresponsive holder (pid ${held.pid}) after its TTL — stop it or check .cotal/manager.log`));
          process.exit(1);
        }
        startManagerDetached({ space, server: connection.server, runtime });
      }
      // else: a live manager already answered — reuse it. All paths converge here: confirm a manager is
      // serving, then validate THE HOLDER THAT ACTUALLY ANSWERED by re-reading the CURRENT lease (not the
      // `held` snapshot, which can turn over during the probe / a concurrent start — TOCTOU). Fail LOUD if
      // a foreign-checkout or wrong-runtime manager won the space before we launch into it.
      if (!(await waitManagerReady(ep))) {
        console.error(c.red("✗ manager did not become ready for control — see .cotal/manager.log"));
        process.exit(1);
      }
      const live = await ep.readManagerLease();
      if (!live) {
        console.error(c.red(`✗ "${space}" has no manager lease after the manager became ready — re-run \`cotal spawn -f\``));
        process.exit(1);
      }
      if (resolve(live.root) !== resolve(root)) {
        console.error(c.red(`✗ a manager from a different checkout serves "${space}" (root ${live.root}) — stop it, or run spawn -f from there`));
        process.exit(1);
      }
      if (live.runtime !== runtime) {
        console.error(c.red(`✗ a ${live.runtime} manager already serves "${space}" but runtime ${runtime} was requested — stop it, or match it with --runtime ${live.runtime}`));
        process.exit(1);
      }
      for (const e of agentPlan.willCreate) {
        const reply: ControlReply = await launchAgent(ep, runId, e.agent.name);
        if (!reply.ok) {
          console.error(c.red(`✗ ${e.agent.name}: ${reply.error ?? "launch failed"}`));
          continue;
        }
        const d = reply.data as { name: string; id: string; requested: string; hash: string };
        agents.push({ requested: d.requested, name: d.name, id: d.id, hash: d.hash });
        launchedNow.push(d.name);
        console.log(c.green(`✓ launched ${d.name}`) + c.dim(` (${e.agent.agentType})`));
      }
    }

    // 5) Write/update the creation-only ownership ledger (prior owned ∪ this run's new).
    const createdChannels = dedupe([...(prior?.created.channels ?? []), ...channelPlan.create.map((ch) => ch.name)]);
    const ledger = buildLedger({ runId, space, server: connection.server, manifestHash, manifestPath: abs, channels: createdChannels, agents: dedupeAgents(agents) });
    const ledgerPath = writeLedger(root, ledger, { update: Boolean(prior) });

    // 6) Summary + the exact ownership-scoped teardown command.
    console.log("\n" + renderSpawnSummary({
      space,
      server: connection.server,
      runId,
      ledgerPath,
      manifestPath: abs,
      created: channelPlan.create.map((ch) => ch.name),
      launched: launchedNow,
      existsUnmanaged: channelPlan.existsUnmanaged.map((x) => x.channel.name),
      unmanaged,
    }));
    const inh = renderInherited(eff);
    if (inh) console.log("\n" + inh);
    if (eff.warnings.length) console.log("\n" + renderWarnings(eff.warnings));
  } finally {
    await ep.stop();
  }
}

/** CLI overrides for `spawn -f` (flag > manifest > default): the connect target + runtime. No
 *  host/open — we connect to an existing broker, not bind one. */
function applyOverrides(prepared: PreparedManifest, o: SpawnManifestFlags): PreparedManifest {
  const m = prepared.manifest;
  const broker = { ...m.broker };
  if (o.server) broker.servers = o.server;
  if (!broker.servers) broker.servers = DEFAULT_SERVER;
  return {
    ...prepared,
    manifest: {
      ...m,
      broker,
      space: o.space ?? m.space,
      runtime: (o.runtime as typeof m.runtime) ?? m.runtime,
    },
  };
}

const dedupe = (xs: string[]): string[] => [...new Set(xs)];

/** Keep one entry per nkey id (defensive — `willCreate` excludes prior-owned, so no dup in practice). */
function dedupeAgents(agents: LedgerAgent[]): LedgerAgent[] {
  const byId = new Map<string, LedgerAgent>();
  for (const a of agents) byId.set(a.id, a);
  return [...byId.values()];
}
