/**
 * Human-readable rendering of a prepared manifest — the `cotal topology view` output and the shared
 * pieces of `--dry-run`. The native verbs get humane labels here so the field names aren't the only
 * explanation (UX): `subscribe (auto-listens at boot)` etc. No mutation, no live state.
 */
import { c } from "../../ui.js";
import type { PreparedManifest } from "./preflight.js";
import type { AgentWarning } from "./prepare.js";

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
    const meta = [a.agentType, a.model ? `model ${a.model}` : undefined, a.role ? `role ${a.role}` : undefined, a.prompt ? "kickoff prompt" : undefined]
      .filter(Boolean)
      .join(" · ");
    out.push(`  ${c.bold(a.name)}  ${c.dim(meta + " · " + src)}`);
    if (a.cwd !== undefined) out.push(`      ${c.dim("cwd (manager host):")} ${JSON.stringify(a.cwd)}`);
    if (a.continuity === "exact") out.push(`      ${c.dim("continuity:")} exact (reopens its last session)`);
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
  const auth = m.broker?.auth === false ? "open" : m.broker?.auth === "user" ? `user auth${m.broker?.idp ? ` (idp ${m.broker.idp})` : ""}` : "static auth";
  const head = [
    c.bold("Plan - cotal up -f (fresh mesh)"),
    c.bold("Will create:"),
    `  ${c.green("+")} broker + space ${c.cyan(`"${m.space}"`)} at ${server} ${c.dim(`(${auth})`)}`,
    `  ${c.green("+")} ${m.channels.length} channel(s): ${m.channels.map((ch) => c.cyan("#" + ch.name)).join(", ")}`,
    `  ${c.green("+")} ${p.agents.length} agent(s): ${p.agents.map((a) => a.name).join(", ")}`,
    "",
  ].join("\n");
  return `${head}${renderTopology(p)}\n\n${c.dim("Dry run - nothing was changed. Re-run without --dry-run to apply.")}`;
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
      rows.push(`  ${c.yellow("‼")} ${c.bold(a.name)} capabilities: ${i.capabilities.join(", ")}  ${c.dim(`(persona ${a.persona} - not channel-scoped)`)}`);
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
