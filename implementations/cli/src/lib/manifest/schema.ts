/**
 * The mesh-manifest schema (`cotal.yaml`, `kind: Mesh`) — the strict Zod shape the parser
 * validates before any normalization. Strict objects reject unknown keys (no silent ignore —
 * matches the repo's "no fallbacks" rule); the resolved/inverted model lives in {@link ./model.js}.
 *
 * This is shape-only: cross-field rules (names resolve to an agent, `allowSubscribe ⊇ subscribe`,
 * concrete channel tokens) are pure semantic checks in {@link ./resolve.js}, where they can report
 * the offending file + line.
 */
import { z } from "zod";

const DeliveryClass = z.enum(["live", "durable"]);
const PersonaPermissions = z.enum(["reject", "include"]);

/** An `agents:` value is a string (a bare persona path) OR an object — either an override on a
 *  persona file (`persona:` present) or a fully inline agent (no `persona:`). One object schema
 *  covers both; {@link ./resolve.js} splits them on the presence of `persona`. */
const AgentEntryObject = z
  .strictObject({
    persona: z.string().min(1).optional(),
    /** Connector type to spawn this agent with (claude / opencode / hermes / …). Overrides the
     *  top-level `agent:` default; one of the two must be set (no silent default — matches roster). */
    agent: z.string().min(1).optional(),
    model: z.string().min(1).optional(),
    role: z.string().min(1).optional(),
    description: z.string().optional(),
    instructions: z.string().optional(),
    capabilities: z.array(z.string().min(1)).optional(),
    /** Per-agent override of the top-level `personaPermissions` policy. */
    personaPermissions: PersonaPermissions.optional(),
  })
  .refine((v) => v.persona !== undefined || v.model !== undefined || v.instructions !== undefined, {
    message:
      "inline agent (no `persona:`) needs at least `model` or `instructions` — otherwise reference a persona file",
  });

/** An `agents:` value is a string (bare persona path) OR the object above. A plain `z.union`
 *  collapses an object with a bad key to a useless "Invalid input", so normalize the string form to
 *  `{ persona }` first and validate the one strict object — its real errors (unrecognized key, …)
 *  then surface with their path. */
const AgentEntry = z.preprocess((v) => (typeof v === "string" ? { persona: v } : v), AgentEntryObject);

/** A channel carries its registry card (description/instructions + replay knobs — the existing
 *  ChannelConfig fields) plus the three native access verbs listed per-channel (agents under it). */
const ChannelEntry = z.strictObject({
  description: z.string().optional(),
  instructions: z.string().optional(),
  subscribe: z.array(z.string().min(1)).optional(),
  allowSubscribe: z.array(z.string().min(1)).optional(),
  allowPublish: z.array(z.string().min(1)).optional(),
  replay: z.boolean().optional(),
  replayWindow: z.string().optional(),
  deliveryClass: DeliveryClass.optional(),
});

const Defaults = z.strictObject({
  replay: z.boolean().optional(),
  replayWindow: z.string().optional(),
  deliveryClass: DeliveryClass.optional(),
});

const Broker = z.strictObject({
  servers: z.string().min(1).optional(),
  host: z.string().min(1).optional(),
  auth: z.boolean().optional(),
});

/** The whole manifest. `apiVersion`/`kind` are literals so a foreign YAML doc is rejected up front;
 *  `agents` and `channels` are required maps. */
export const MeshManifestSchema = z.strictObject({
  apiVersion: z.literal("cotal/v1"),
  kind: z.literal("Mesh"),
  space: z.string().min(1),
  broker: Broker.optional(),
  runtime: z.enum(["pty", "tmux", "cmux"]).optional(),
  /** Default connector for agents that don't set their own `agent:`. */
  agent: z.string().min(1).optional(),
  personaPermissions: PersonaPermissions.optional(),
  // `agents` is optional — a channels-first manifest can seed the rooms now and add agents later.
  // A channel that references an undeclared name is still a hard error (in resolve.ts).
  agents: z.record(z.string().min(1), AgentEntry).optional(),
  defaults: Defaults.optional(),
  channels: z.record(z.string().min(1), ChannelEntry),
});

export type RawManifest = z.infer<typeof MeshManifestSchema>;
export type RawAgentEntry = z.infer<typeof AgentEntry>;
export type RawChannelEntry = z.infer<typeof ChannelEntry>;
