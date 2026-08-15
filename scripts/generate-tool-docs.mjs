// Generate docs/mcp-tools.md from the live cotal_* tool specs (run: pnpm gen:tooldocs,
// which invokes this through tsx so the TS import below resolves).
//
// The names, titles, descriptions, and argument schemas come straight from
// `extensions/connector-core/src/tool-specs.ts` — the single source every connector
// renders — so the catalog cannot drift from the shipped surface. Side-effect labels and
// failure notes are not modelled on the specs, so they live in the ANNOTATIONS table
// below; the script FAILS LOUD when a tool is missing an annotation (or an annotation is
// orphaned), so adding or removing a tool forces the catalog to keep up.
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { cotalToolSpecs } from "../extensions/connector-core/src/tool-specs.ts";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "..", "docs", "mcp-tools.md");

// A representative config. This page documents EVERY tool and marks each one's availability in its
// annotation, so the config has to be the one that sees them all — it is a documentation fixture,
// not a deployment.
//
// ⚠️ IT DECLARES THE GATING CAPABILITIES EXPLICITLY, AND IT DID NOT USED TO. The old comment here
// read "open-mode-ish (no creds ⇒ the capability-gated tools are included)" — i.e. this generator
// was relying on the open-mode arm of the capability gate to hand it tools it had not asked for.
// When that arm was removed (`connection` is now required in every mode), the verbs vanished from
// the spec list while their annotations remained, and the generator died on `orphaned annotation
// cotal_disconnect` — taking `check:docsbundle` and `ci:version` with it.
//
// Found by review, in the gap between two suites: one measured the tool surface, the other the
// broker, and neither executed this script. Naming it here because it is the SECOND consumer of
// that bypass to surface — the first was a smoke fixture — and a third is more likely than not.
const config = {
  space: "main",
  name: "you",
  servers: "nats://127.0.0.1:4222",
  subscribe: ["general"],
  allowSubscribe: ["general"],
  allowPublish: ["general"],
  kind: "agent",
  // ⚠️ `connection` is load-bearing here; `spawn` is NOT, and that is recorded so nobody mistakes it
  // for a control. Measured by review across six configs: open-none and open-spawn expose 18 tools
  // with no connect/disconnect, open-connection and open-all expose all 20, auth-none exposes 16,
  // auth-all exposes 20. Open-mode spawn is still permissive under its own separate, documented
  // policy, so this fixture would receive the spawn tools with or without the word. It is kept
  // because it states what a real caller must hold — but delete it and nothing moves, and a reader
  // who mutated it and saw no change would wrongly conclude this fixture proves spawn gating.
  capabilities: ["connection", "spawn"],
};

/** Side-effect + availability annotations, keyed by tool name. Every spec MUST have one. */
const ANNOTATIONS = {
  cotal_orientation: {
    effect: "read-only",
    availability: "always",
    notes: "Call it first; safe to re-check anytime.",
  },
  cotal_roster: { effect: "read-only", availability: "always" },
  cotal_docs: {
    effect: "read-only",
    availability: "always",
    notes:
      "Serves the version-exact docs bundled with this release (offline); `refresh: true` adds an opt-in pull from docs.cotal.ai that is version-gated, so it can never return docs for a different version.",
  },
  cotal_inbox: {
    effect: "Claude: drains all (or peeks); driven connectors: clears pull-only quiet traffic",
    availability: "always",
    notes:
      "OpenCode, Codex, Hermes, and Pi expose no arguments: automatic traffic remains connector-owned, while buffered quiet ambient is cleared. In focus mode, normal channel recall is also shown read-only (replay-gated).",
  },
  cotal_send: {
    effect: "publishes to a channel",
    availability: "always (the broker enforces your post ACL)",
    notes:
      "Fails loud when the channel is outside your `allowPublish`. An unknown name in `mentions` aborts the whole broadcast.",
  },
  cotal_dm: { effect: "sends a private message to one peer", availability: "always" },
  cotal_anycast: {
    effect: "queues a request for one holder of a role",
    availability: "always",
    notes: "A request with no holder online waits on the role's queue.",
  },
  cotal_status: {
    effect: "updates your own presence / attention",
    availability: "always",
    notes: "With no arguments it just reports the current values.",
  },
  cotal_channel_info: { effect: "read-only", availability: "always" },
  cotal_channels: { effect: "read-only", availability: "always" },
  cotal_channel_mode: {
    effect: "sets your own per-channel receive preference (quiet / muted / normal)",
    availability: "always",
    notes: "Local preference, not access control; resets on restart.",
  },
  cotal_join: {
    effect: "subscribes you to a channel",
    availability: "always, within your read ACL (`allowSubscribe`); outside it the join is refused",
    notes: "If the channel replays, recent history lands in your inbox marked as catch-up.",
  },
  cotal_leave: { effect: "unsubscribes you from a channel", availability: "always" },
  cotal_spawn: {
    effect: "starts a new agent process via the manager",
    availability:
      "capability-gated: injected only for personas declaring `capabilities: [spawn]` (auth mode); open mode is permissive",
    notes:
      "Failure modes are distinct: a permission denial names the missing capability; an unreachable manager is reported as such.",
  },
  cotal_feedback: {
    effect: "sends data to an external HTTPS intake (network egress)",
    availability: "always",
    notes: "Keyless submissions need a contact email; never include secrets.",
  },
  cotal_despawn: {
    effect: "stops a teammate (or yourself)",
    availability:
      "self-despawn (no name) is granted to all; stopping a *named* peer rides the spawn capability's owner-mode reach (your own owner's agents only)",
  },
  cotal_persona: {
    effect: "writes a persona file via the manager (becomes spawnable); posts one message ONLY if you pass `announce`",
    availability: "capability-gated like cotal_spawn",
    notes:
      "Content only (`prompt`, `model`): role, ACLs, capabilities, and ownership have no slot here; they are policy. " +
      "Defining is silent by default — `announce` is the only way it emits, and then only to the channel you name.",
  },
  cotal_reconnect: {
    effect: "tears down and rebuilds your own mesh connection",
    availability: "always",
    notes: "The tool result is authoritative over any prose about the outcome. Refuses while you are deliberately disconnected — use `cotal_connect` for that, so the recovery path cannot quietly reverse a state you chose.",
  },
  cotal_disconnect: {
    effect: "takes you off the mesh; peers see you offline",
    availability: "only with `capabilities: [connection]`",
    notes:
      "Not the same as leaving every channel: DMs still reach you there, and not here. Durable channel membership is KEPT, so the backstop replays what you missed when you return — an indefinite disconnect keeps accruing messages owed to you. Reversible by YOU and only by you: no mesh peer can pull you back, so your cause line is the last thing a mesh supervisor hears from you (whoever controls your process still does). **That line is display text, not proof:** a heartbeat-stale-but-still-routing endpoint and a genuinely disconnected one render the SAME roster line, so a supervisor cannot distinguish them — measured live, and the reason is that presence carries no transition/cause/source field. Refuses rather than going dark quietly if the departure cannot be confirmed at the broker, if requests are awaiting a reply, or if a transition is already running.",
  },
  cotal_connect: {
    effect: "puts you back on the mesh; peers see you online again",
    availability: "only with `capabilities: [connection]`",
    notes:
      "Takes no target: it returns to the mesh this session was launched against, with the credential source it was launched with, so it asks for no access you did not already have and can reach no mesh you were not already on. It re-reads that credential only when the cached one is STALE — measured: a disconnect/connect pair re-presented the cached credential without fetching a new one. So do not assume a credential revoked while you were away is re-checked on return; whether a revocation is caught is **not measured**. If the broker accepts the connection but refuses part of your channel read set, the result says PARTIAL and names what you are NOT receiving — a grant problem, not a connection problem.",
  },
};

/** Unwrap a zod type to { type, optional, description } without depending on private API names. */
function describeArg(name, schema) {
  let s = schema;
  let optional = false;
  const description = s.description ?? s.meta?.()?.description;
  // Walk wrapper types (optional/default/nullable) down to the base.
  for (let i = 0; i < 6; i++) {
    const def = s._zod?.def ?? s._def ?? s.def;
    if (!def) break;
    const t = def.type ?? def.typeName;
    if (t === "optional" || t === "ZodOptional" || t === "default" || t === "ZodDefault") {
      optional = true;
      s = def.innerType;
      continue;
    }
    if (t === "nullable" || t === "ZodNullable") {
      s = def.innerType;
      continue;
    }
    break;
  }
  const def = s._zod?.def ?? s._def ?? s.def;
  let type = def?.type ?? def?.typeName;
  if (!type) throw new Error(`cannot derive type for arg "${name}"`);
  type = String(type).replace(/^Zod/, "").toLowerCase();
  if (type === "enum") {
    const values = def.entries ? Object.keys(def.entries) : (def.values ?? []);
    type = values.map((v) => `\`${v}\``).join(" \\| ");
  } else if (type === "array") {
    const el = def.element ?? def.valueType;
    const elDef = el?._zod?.def ?? el?._def;
    type = `${String(elDef?.type ?? elDef?.typeName ?? "any").replace(/^Zod/, "").toLowerCase()}[]`;
  } else {
    type = `${type}`;
  }
  const desc = description ?? schema.description;
  if (!desc) throw new Error(`arg "${name}" has no .describe() text`);
  return { type, optional, description: desc };
}

const specs = cotalToolSpecs(config);
const specNames = new Set(specs.map((s) => s.name));
for (const s of specs) if (!ANNOTATIONS[s.name]) throw new Error(`missing annotation for ${s.name} — add it to scripts/generate-tool-docs.mjs`);
for (const n of Object.keys(ANNOTATIONS)) if (!specNames.has(n)) throw new Error(`orphaned annotation ${n} — the tool no longer exists`);

const lines = [];
lines.push("# MCP tool catalog");
lines.push("");
lines.push(
  "> **Reference**: the `cotal_*` tool surface every connected agent gets. · **For:** agents and operators · **Generated** from [`tool-specs.ts`](../extensions/connector-core/src/tool-specs.ts) by `pnpm gen:tooldocs`; do not edit by hand.",
);
lines.push("");
lines.push(
  "The tools are defined once, platform-neutrally, in `@cotal-ai/connector-core` and rendered onto each host's native tool API (an MCP server for [Claude Code](connect-claude.md) and [Codex](connect-codex.md), native plugin tools for [OpenCode](connect-opencode.md), [Hermes](connect-hermes.md), and [pi](connect-pi.md)), so the surface cannot drift across connectors. Argument defaults shown below assume the standard `general` setup; channel-scoped calls are bounded by your ACLs ([channels & permissions](channels-and-permissions.md)).",
);
lines.push("");
lines.push(
  "`cotal_orientation` is the entry point. The card it returns reflects the same gated tool list the connector exposes; it never claims a tool the agent can't call. In auth mode the manager-op tools (`cotal_spawn`, `cotal_persona`) are injected only for personas declaring `capabilities: [spawn]` ([identity & auth](identity-and-auth.md)).",
);
lines.push("");
lines.push("| Tool | Does | Side-effect |");
lines.push("|---|---|---|");
for (const s of specs) {
  const a = ANNOTATIONS[s.name];
  const short = s.title.replace(/^Cotal: /, "");
  lines.push(`| [\`${s.name}\`](#${s.name.replace(/_/g, "")}) | ${short} | ${a.effect} |`);
}
lines.push("");

for (const s of specs) {
  const a = ANNOTATIONS[s.name];
  lines.push(`## \`${s.name}\``);
  lines.push("");
  lines.push(`*${s.title.replace(/^Cotal: /, "")}*`);
  lines.push("");
  lines.push(s.description);
  lines.push("");
  if (s.name === "cotal_inbox") {
    lines.push(
      "**Connector variants:** Claude Code exposes the `peek` argument and otherwise drains the full local inbox. OpenCode, Codex, Hermes, and Pi expose no arguments: the call destructively pulls only buffered quiet ambient, leaving automatic traffic to the connector; normal focus recall shown with it remains read-only.",
    );
    lines.push("");
  }
  lines.push(`- **Side-effect:** ${a.effect}.`);
  lines.push(`- **Available:** ${a.availability}.`);
  if (a.notes) lines.push(`- ${a.notes}`);
  lines.push("");
  if (s.schema && Object.keys(s.schema).length) {
    lines.push("| Argument | Type | Required | Meaning |");
    lines.push("|---|---|---|---|");
    for (const [arg, zodType] of Object.entries(s.schema)) {
      const d = describeArg(arg, zodType);
      lines.push(`| \`${arg}\` | ${d.type} | ${d.optional ? "no" : "yes"} | ${d.description.replace(/\n/g, " ")} |`);
    }
    lines.push("");
  } else {
    lines.push("No arguments.");
    lines.push("");
  }
}

lines.push("---");
lines.push("");
lines.push(
  "Messages arrive in an agent's context as `<channel source=\"cotal\" from=\"<name>\" role=\"<role>\" kind=\"dm|channel|anycast\" channel=\"<name>\">…</channel>`; each meta key is a tag attribute usable for routing. How and when they interrupt a session is the connector's delivery policy ([Connect Claude](connect-claude.md#how-messages-reach-the-session)).",
);
lines.push("");

writeFileSync(out, lines.join("\n"));
console.log(`gen:tooldocs — wrote ${out} (${specs.length} tools)`);
