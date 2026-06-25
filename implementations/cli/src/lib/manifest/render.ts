/**
 * Human-readable rendering of a prepared manifest — the `cotal topology view` output and the shared
 * pieces of `--dry-run`. The native verbs get humane labels here so the field names aren't the only
 * explanation (UX): `subscribe (auto-listens at boot)` etc. No mutation, no live state.
 */
import { c } from "../../ui.js";
import type { PreparedManifest } from "./preflight.js";
import type { AgentWarning } from "./prepare.js";
import type { AgentPlan, ChannelPlan, UnmanagedReport } from "./spawn-plan.js";

const LABEL = {
  subscribe: "subscribe (auto-listens at boot)",
  allowSubscribe: "allowSubscribe (may read/join)",
  allowPublish: "allowPublish (may post)",
};

const list = (xs: string[]): string => (xs.length ? xs.join(", ") : c.dim("(none)"));

/** The full `topology view`: header, channel access, agent access, persona-inherited scopes, warnings. */
export function renderTopology(p: PreparedManifest): string {
  const m = p.manifest;
  const out: string[] = [];

  const broker = m.broker?.servers ?? "fresh local broker";
  out.push(
    c.bold(`Mesh "${m.space}"`) +
      c.dim(`  (broker: ${broker} · runtime ${m.runtime ?? "pty"} · personaPermissions: ${m.personaPermissions})`),
  );

  // Channels — who subscribes / may read / may post (agent names).
  out.push("", c.bold(`Channels (${m.channels.length})`));
  for (const ch of m.channels) {
    out.push(`  ${c.cyan("#" + ch.name)}${ch.description ? c.dim("  " + ch.description) : ""}`);
    out.push(`      ${c.dim(LABEL.subscribe + ":")}      ${list(ch.subscribe)}`);
    out.push(`      ${c.dim(LABEL.allowSubscribe + ":")}    ${list(ch.allowSubscribe)}`);
    out.push(`      ${c.dim(LABEL.allowPublish + ":")}      ${list(ch.allowPublish)}`);
    if (ch.instructions) out.push(`      ${c.dim("instructions: " + ch.instructions)}`);
  }

  // Agents — effective merged access (manifest + any persona-inherited under `include`).
  out.push("", c.bold(`Agents (${p.agents.length})`));
  for (const a of p.agents) {
    const src = a.persona ? `persona ${a.persona}` : "inline";
    const meta = [a.agentType, a.model ? `model ${a.model}` : undefined, a.role ? `role ${a.role}` : undefined]
      .filter(Boolean)
      .join(" · ");
    out.push(`  ${c.bold(a.name)}  ${c.dim(meta + " · " + src)}`);
    out.push(`      ${c.dim(LABEL.subscribe + ":")}      ${list(a.policy.subscribe)}`);
    out.push(`      ${c.dim(LABEL.allowSubscribe + ":")}    ${list(a.policy.allowSubscribe)}`);
    out.push(`      ${c.dim(LABEL.allowPublish + ":")}      ${list(a.policy.allowPublish)}`);
    if (a.capabilities.length)
      out.push(`      ${c.dim("capabilities:")}      ${a.capabilities.join(", ")}${a.capabilitySource === "persona" ? c.dim(" (persona-inherited)") : ""}`);
  }

  const inherited = renderInherited(p);
  if (inherited) out.push("", inherited);

  if (p.warnings.length) out.push("", renderWarnings(p.warnings));
  return out.join("\n");
}

/** The `cotal up -f --dry-run` plan: a fresh mesh creates everything, so the grouping is simply
 *  "will create" — broker + channels + agents — followed by the full access view. Mutates nothing. */
export function renderUpPlan(p: PreparedManifest, server: string): string {
  const m = p.manifest;
  const head = [
    c.bold("Plan — cotal up -f (fresh mesh)"),
    c.bold("Will create:"),
    `  ${c.green("+")} broker + space ${c.cyan(`"${m.space}"`)} at ${server}`,
    `  ${c.green("+")} ${m.channels.length} channel(s): ${m.channels.map((ch) => c.cyan("#" + ch.name)).join(", ")}`,
    `  ${c.green("+")} ${p.agents.length} agent(s): ${p.agents.map((a) => a.name).join(", ")}`,
    "",
  ].join("\n");
  return `${head}${renderTopology(p)}\n\n${c.dim("Dry run — nothing was changed. Re-run without --dry-run to apply.")}`;
}

/** The loud "persona grants outside manifest channels" section — unmanaged credential scopes that
 *  an old persona ref drags in under `personaPermissions: include`. Returns "" when there are none. */
export function renderInherited(p: PreparedManifest): string {
  const rows: string[] = [];
  for (const a of p.agents) {
    const i = a.inherited;
    const hasAcl = i.subscribe.length || i.allowSubscribe.length || i.allowPublish.length;
    if (!hasAcl && !i.capabilities.length) continue;
    // Capabilities first — they are NOT channel-scoped (spawn/tool power), so they're easiest to miss
    // and most security-significant (security review, round-8).
    if (i.capabilities.length)
      rows.push(`  ${c.yellow("‼")} ${c.bold(a.name)} capabilities: ${i.capabilities.join(", ")}  ${c.dim(`(persona ${a.persona} — not channel-scoped)`)}`);
    if (hasAcl) {
      const parts = [
        i.subscribe.length ? `subscribe ${i.subscribe.join(",")}` : "",
        i.allowSubscribe.length ? `read ${i.allowSubscribe.join(",")}` : "",
        i.allowPublish.length ? `post ${i.allowPublish.join(",")}` : "",
      ].filter(Boolean);
      rows.push(`  ${c.bold(a.name)} → ${parts.join(" · ")}  ${c.dim(`(persona ${a.persona} · unmanaged by manifest, no card)`)}`);
    }
  }
  if (!rows.length) return "";
  return [c.yellow(c.bold("⚠ Persona-inherited access + capabilities outside manifest channels")), ...rows].join("\n");
}

/** Render the non-fatal warnings (empty-ACL agents, loud when they carry capabilities). */
export function renderWarnings(warnings: AgentWarning[]): string {
  const rows = warnings.map((w) => `  ${w.loud ? c.yellow("‼") : c.dim("•")} ${c.bold(w.agent)}: ${w.message}`);
  return [c.yellow(c.bold(`⚠ Warnings (${warnings.length})`)), ...rows].join("\n");
}

/** The `cotal spawn -f` plan / `--dry-run`: deploy onto a RUNNING mesh. Groups channels and agents
 *  by disposition (create / exists-unmanaged / owned · will-create / already-owned / stale), then the
 *  SECURITY block + persona-inherited access. Creation-only — an existing unmanaged card is shown
 *  desired-vs-live, never patched. */
export function renderSpawnPlan(
  p: PreparedManifest,
  channels: ChannelPlan,
  agents: AgentPlan,
  unmanaged: UnmanagedReport,
  ctx: { server: string; runId: string; dryRun: boolean },
): string {
  const out: string[] = [c.bold(`Plan — cotal spawn -f (deploy onto running mesh ${ctx.server})`)];

  out.push("", c.bold("Channels:"));
  for (const ch of channels.create) out.push(`  ${c.green("+")} create ${c.cyan("#" + ch.name)} ${c.dim("(seed + own)")}`);
  for (const { channel, live } of channels.existsUnmanaged) {
    out.push(`  ${c.yellow("~")} ${c.cyan("#" + channel.name)} ${c.yellow("exists — unmanaged")} ${c.dim("(card left untouched)")}`);
    if ((channel.description ?? "") !== (live.description ?? ""))
      out.push(`      ${c.dim(`desired: ${channel.description ?? "(none)"}  ·  live: ${live.description ?? "(none)"}`)}`);
    if ((channel.instructions ?? "") !== (live.instructions ?? ""))
      out.push(`      ${c.dim(`desired instructions differ from live — not applied (use a future --patch flag)`)}`);
  }
  for (const ch of channels.owned) out.push(`  ${c.dim("=")} ${c.cyan("#" + ch.name)} ${c.dim("(already owned by this run)")}`);
  if (!channels.create.length && !channels.existsUnmanaged.length && !channels.owned.length) out.push(`  ${c.dim("(none)")}`);

  out.push("", c.bold("Agents:"));
  for (const e of agents.willCreate) out.push(`  ${c.green("+")} ${c.bold(e.agent.name)} ${c.dim(`${e.agent.agentType} — will launch`)}`);
  for (const e of agents.alreadyOwned) out.push(`  ${c.dim("=")} ${c.bold(e.agent.name)} ${c.dim(`(already running as ${e.prior?.name} — no-op)`)}`);
  for (const e of agents.stale)
    out.push(
      `  ${c.yellow("!")} ${c.bold(e.agent.name)} ${c.yellow("stale — restart required")} ` +
        c.dim(`(${e.prior?.name}: hash ${e.prior?.hash.slice(0, 8)} → ${e.hash.slice(0, 8)}${e.running ? "" : ", not running"})`),
    );
  if (!agents.entries.length) out.push(`  ${c.dim("(none)")}`);

  const sec = renderUnmanaged(unmanaged);
  if (sec) out.push("", sec);
  const inherited = renderInherited(p);
  if (inherited) out.push("", inherited);
  if (ctx.dryRun) out.push("", c.dim(`Dry run — nothing was changed. Run ${ctx.runId} not written. Re-run without --dry-run to apply.`));
  return out.join("\n");
}

/** The SECURITY block: unmanaged actors observed with read access to a manifest-declared channel —
 *  an isolation conflict on the shared mesh — phrased as an explicit LOWER BOUND (presence + the
 *  broker membership feed; live-only core subscriptions aren't observable when the feed is absent).
 *  Returns "" only when there's nothing to say AND the feed was readable. */
export function renderUnmanaged(u: UnmanagedReport): string {
  const rows: string[] = [];
  for (const ce of u.perChannel) {
    const who = ce.actors.map((a) => `${a.name ?? a.id.slice(0, 8)} (${a.via})`).join(", ");
    rows.push(`  ${c.red("‼")} ${c.cyan("#" + ce.channel)}: unmanaged ${who}`);
  }
  const caveat = u.feedAvailable
    ? c.dim(`  detected via presence + membership feed (asOf ${new Date(u.asOf as number).toISOString()}); live-only core subscriptions are a lower bound`)
    : c.dim("  membership feed unavailable — detection is PRESENCE-ONLY (a lower bound; channel membership/live subscriptions not observable)");
  // Show the block when there are conflicts, or when the feed was unavailable (so an empty result is
  // never mistaken for "provably isolated").
  if (!rows.length && u.feedAvailable) {
    return u.presentUnowned.length
      ? c.dim(`note: ${u.presentUnowned.length} unmanaged peer(s) present on the mesh; none on a declared channel (${caveat.trim()})`)
      : "";
  }
  const head = c.red(c.bold("⚠ SECURITY — unmanaged actors with access to declared channels"));
  const tail = u.presentUnowned.length ? [c.dim(`  (${u.presentUnowned.length} unmanaged peer(s) present on the mesh in total)`)] : [];
  return [head, ...rows, caveat, ...tail].join("\n");
}

/** Post-apply summary for `cotal spawn -f`: what was created/launched, what was left untouched, the
 *  SECURITY block, and the exact ownership-scoped teardown command + ledger path. */
export function renderSpawnSummary(ctx: {
  space: string;
  server: string;
  runId: string;
  ledgerPath: string;
  manifestPath: string;
  created: string[];
  launched: string[];
  existsUnmanaged: string[];
  unmanaged: UnmanagedReport;
}): string {
  const out: string[] = [c.green(`✓ deployed onto "${ctx.space}" (${ctx.server})`)];
  if (ctx.created.length) out.push(`  ${c.green("+")} created ${ctx.created.length} channel(s): ${ctx.created.map((n) => c.cyan("#" + n)).join(", ")}`);
  if (ctx.launched.length) out.push(`  ${c.green("+")} launched ${ctx.launched.length} agent(s): ${ctx.launched.join(", ")}`);
  if (ctx.existsUnmanaged.length)
    out.push(`  ${c.yellow("~")} left ${ctx.existsUnmanaged.length} existing channel(s) untouched: ${ctx.existsUnmanaged.map((n) => c.cyan("#" + n)).join(", ")}`);
  const sec = renderUnmanaged(ctx.unmanaged);
  if (sec) out.push("", sec);
  out.push("", c.dim(`Run ${ctx.runId} · ledger ${ctx.ledgerPath}`));
  out.push(c.dim(`Tear down ONLY this deploy: `) + `cotal down -f ${ctx.manifestPath} --run ${ctx.runId}`);
  return out.join("\n");
}
