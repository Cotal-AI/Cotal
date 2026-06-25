/**
 * The pure manifest pipeline (no network, no persona-file reads — those are preflight):
 *
 *   parse (YAML, keep line/col) → schema (strict Zod) → normalize + invert (channel-centric →
 *   per-agent ACLs) → semantic checks (names resolve, allowSubscribe ⊇ subscribe, concrete tokens).
 *
 * Returns a {@link ResolvedManifest}; throws {@link ManifestError} with every problem located by
 * file + line. Stages 1–4 of the plan — deterministic and unit-testable.
 */
import { isAbsolute, resolve as resolvePath, dirname } from "node:path";
import { parseDocument, LineCounter } from "yaml";
import { assertValidChannel, assertValidName, isConcreteChannel } from "@cotal-ai/core";
import { MeshManifestSchema, type RawManifest } from "./schema.js";
import type { AgentPolicy, PersonaPermissions, ResolvedAgent, ResolvedChannel, ResolvedManifest } from "./model.js";
import { ManifestError, type ManifestIssue } from "./errors.js";

/** Parse + validate a manifest source into the resolved model. `sourcePath` anchors relative
 *  persona refs and locates errors. */
export function resolveManifest(src: string, sourcePath: string): ResolvedManifest {
  const lc = new LineCounter();
  const doc = parseDocument(src, { lineCounter: lc });
  // Best-effort location: try the exact node, then walk up the path (union/object-level errors
  // often have no node of their own), finally the document root. Diagnostics only — never on the
  // resolved model (engineer, round-6).
  const locate = (path?: (string | number)[]): { line?: number; col?: number } => {
    if (!path) return {};
    const p = [...path];
    for (;;) {
      const node = doc.getIn(p, true) as { range?: [number, number, number] } | undefined;
      if (node?.range) {
        const { line, col } = lc.linePos(node.range[0]);
        return { line, col };
      }
      if (p.length === 0) return {};
      p.pop();
    }
  };

  // 1. Parse. Syntax errors + duplicate map keys (yaml enforces unique keys) surface here.
  if (doc.errors.length)
    throw new ManifestError(
      sourcePath,
      doc.errors.map((e) => ({ message: e.message.split("\n")[0], line: e.linePos?.[0]?.line, col: e.linePos?.[0]?.col })),
    );

  // Targeted message for the single-space deferral before the strict schema rejects it generically.
  if (doc.has("spaces"))
    throw new ManifestError(sourcePath, [
      { message: "`spaces:` is not supported in v1 (single-space) — use a scalar `space:`", path: ["spaces"], ...locate(["spaces"]) },
    ]);

  // 2. Schema (strict): shape + unknown-key rejection. Map every Zod issue back to a located line.
  const parsed = MeshManifestSchema.safeParse(doc.toJS());
  if (!parsed.success)
    throw new ManifestError(
      sourcePath,
      parsed.error.issues.map((iss) => {
        const path = iss.path.filter((p): p is string | number => typeof p !== "symbol");
        // Point the line at the offending unknown key, not just its containing object.
        const keys = (iss as { keys?: string[] }).keys;
        const locPath = iss.code === "unrecognized_keys" && keys?.length ? [...path, keys[0]] : path;
        return { message: iss.message, path, ...locate(locPath) };
      }),
    );
  const raw = parsed.data;

  // 3 + 4. Normalize/invert and run pure semantic checks, collecting every problem in one pass.
  const issues: ManifestIssue[] = [];
  const add = (message: string, path?: (string | number)[]) => issues.push({ message, path, ...locate(path) });

  const agentNames = new Set(Object.keys(raw.agents ?? {}));
  for (const name of agentNames)
    try {
      assertValidName(name);
    } catch (e) {
      add((e as Error).message, ["agents", name]);
    }

  if (raw.broker) validateBroker(raw.broker, add);
  const channels = normalizeChannels(raw, agentNames, add);
  const agents = resolveAgents(raw, channels, sourcePath, add);

  if (issues.length) throw new ManifestError(sourcePath, issues);

  return {
    space: raw.space,
    broker: raw.broker,
    runtime: raw.runtime,
    personaPermissions: raw.personaPermissions ?? "reject",
    defaults: raw.defaults,
    agents,
    channels,
    sourcePath,
  };
}

/** Normalize each channel (default `allowSubscribe` ⇐ `subscribe`, dedup) and run the channel-level
 *  semantic checks: concrete token, every referenced name resolves, `allowSubscribe ⊇ subscribe`. */
function normalizeChannels(
  raw: RawManifest,
  agentNames: Set<string>,
  add: (message: string, path?: (string | number)[]) => void,
): ResolvedChannel[] {
  const out: ResolvedChannel[] = [];
  for (const [name, entry] of Object.entries(raw.channels)) {
    try {
      assertValidChannel(name);
      if (!isConcreteChannel(name)) throw new Error(`channel "${name}" must be concrete — wildcard channels are not supported in v1`);
    } catch (e) {
      add((e as Error).message, ["channels", name]);
    }
    const subscribe = dedupe(entry.subscribe ?? []);
    const allowSubscribe = entry.allowSubscribe ? dedupe(entry.allowSubscribe) : [...subscribe];
    const allowPublish = dedupe(entry.allowPublish ?? []);

    // Every name listed under a channel must resolve to an `agents:` entry (no silent default).
    for (const [field, names] of [["subscribe", subscribe], ["allowSubscribe", allowSubscribe], ["allowPublish", allowPublish]] as const)
      for (const n of names)
        if (!agentNames.has(n)) add(`"${n}" is not declared in agents:`, ["channels", name, field]);

    // An explicit allowSubscribe must be a superset of subscribe (the read-ACL invariant).
    const missing = subscribe.filter((n) => !allowSubscribe.includes(n));
    if (missing.length)
      add(`subscribe [${missing.join(", ")}] not in allowSubscribe — a subscriber must be allowed to read`, ["channels", name, "allowSubscribe"]);

    out.push({
      name,
      description: entry.description,
      instructions: entry.instructions,
      subscribe,
      allowSubscribe,
      allowPublish,
      replay: entry.replay,
      replayWindow: entry.replayWindow,
      deliveryClass: entry.deliveryClass,
    });
  }
  return out;
}

/** Build each agent's resolved form: its persona source (file/inline) + the per-agent ACLs inverted
 *  from channel membership. Behavior overrides are carried verbatim; the persona default is filled
 *  in during preflight (which reads the file). */
function resolveAgents(
  raw: RawManifest,
  channels: ResolvedChannel[],
  sourcePath: string,
  add: (message: string, path?: (string | number)[]) => void,
): ResolvedAgent[] {
  const topPolicy: PersonaPermissions = raw.personaPermissions ?? "reject";
  const dir = dirname(sourcePath);
  const personaPath = (ref: string) => (isAbsolute(ref) ? ref : resolvePath(dir, ref));
  // No silent default connector (matches roster.yaml): an agent needs its own `agent:` or the
  // top-level default. Fail loud rather than guessing claude/opencode.
  const connector = (name: string, own?: string): string => {
    const t = own ?? raw.agent;
    if (!t) add(`no connector for "${name}" — set \`agent:\` on it or a top-level \`agent:\` default`, ["agents", name]);
    return t ?? "";
  };

  // After schema preprocessing every entry is the object form (a bare string was normalized to
  // `{ persona }`), so there's a single shape to read here.
  return Object.entries(raw.agents ?? {}).map(([name, entry]) => ({
    name,
    agentType: connector(name, entry.agent),
    persona: entry.persona ? personaPath(entry.persona) : undefined,
    model: entry.model,
    role: entry.role,
    description: entry.description,
    instructions: entry.instructions,
    capabilities: entry.capabilities,
    personaPermissions: entry.personaPermissions ?? topPolicy,
    policy: invertPolicy(name, channels),
  }));
}

/** Invert channel-centric membership into one agent's per-channel ACLs (the channels it appears in). */
function invertPolicy(name: string, channels: ResolvedChannel[]): AgentPolicy {
  return {
    subscribe: channels.filter((c) => c.subscribe.includes(name)).map((c) => c.name),
    allowSubscribe: channels.filter((c) => c.allowSubscribe.includes(name)).map((c) => c.name),
    allowPublish: channels.filter((c) => c.allowPublish.includes(name)).map((c) => c.name),
  };
}

/** Reject inline credentials in the broker config: a `nats://user:pass@host` URL must use the
 *  auth creds/profile path, not embedded secrets (critic, round-6); `host` is a bind address, not
 *  a URL. Each server entry must parse as a URL (no silent fallback). */
function validateBroker(broker: NonNullable<RawManifest["broker"]>, add: (m: string, p?: (string | number)[]) => void): void {
  if (broker.host?.includes("://"))
    add(`broker.host is a bind address (e.g. 127.0.0.1), not a URL — drop the scheme`, ["broker", "host"]);
  if (broker.servers)
    for (const s of broker.servers.split(",").map((x) => x.trim()).filter(Boolean)) {
      let u: URL;
      try {
        u = new URL(s);
      } catch {
        add(`broker.servers entry "${s}" is not a valid URL (e.g. nats://127.0.0.1:4222)`, ["broker", "servers"]);
        continue;
      }
      if (u.username || u.password)
        add(`broker.servers must not embed credentials ("${u.username}:***@…") — use auth creds/profile, not inline secrets`, ["broker", "servers"]);
    }
}

function dedupe<T>(xs: T[]): T[] {
  return [...new Set(xs)];
}
