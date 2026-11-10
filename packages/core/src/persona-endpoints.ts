/**
 * The `endpoints` persona field: the endpoint commands a persona hands the agent it starts, as
 * `[{ endpoint, commands, instanceId? }]`. One parser serves every door that carries the field (an
 * agent file, the inline persona on `spawn`, `define-persona`, a Lang inline spawn), and one lowering
 * turns it into the caller capabilities a mint takes, so the spawn bound measures the same rows the
 * mint grants.
 *
 * The shape names no target and no journal, so it lowers only to untargeted request rows. Three
 * names are refused whatever the caller's standing, an operator instrument included: a single-label
 * endpoint (single-label names belong to the reference endpoints, whose access rides the baseline
 * and the `spawn`, `run` and `admin` capabilities, SPEC 13.2), the reserved commands `describe` and
 * `cancel`, and anything that is not a command token.
 */
import { endpointToken, assertCommandToken, assertLifecycleToken, RESERVED_COMMANDS } from "./endpoint-subjects.js";
import type { EpCapability } from "./endpoint-grants.js";

/** One entry of the field. `commands` is never empty. */
export interface PersonaEndpoint {
  endpoint: string;
  commands: string[];
  instanceId?: string;
}

/** The most commands the field may name across all entries. A mint still refuses a credential over
 *  its size gate; this bound keeps a malformed persona from reaching it. */
export const PERSONA_ENDPOINT_MAX_COMMANDS = 256;

const ENTRY_KEYS = ["endpoint", "commands", "instanceId"];

/**
 * Read the field from untrusted input into a fresh, canonical list: entries sorted by endpoint then
 * instance, one entry per (endpoint, instance), commands deduplicated and sorted. `undefined` and
 * `null` read as absent. Throws, naming `where`, on any other shape or on a refused name. The result
 * shares no object with the input, so a caller that changes its input afterwards changes nothing.
 */
export function parsePersonaEndpoints(raw: unknown, where: string): PersonaEndpoint[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  const fail = (detail: string): never => {
    throw new Error(`${where}: "endpoints" ${detail}`);
  };
  if (!Array.isArray(raw)) fail("must be a list of { endpoint, commands, instanceId? } entries");
  const merged = new Map<string, PersonaEndpoint>();
  let total = 0;
  for (const item of raw as unknown[]) {
    if (item === null || typeof item !== "object" || Array.isArray(item)) fail("entries must be mappings of endpoint, commands and an optional instanceId");
    const proto = Object.getPrototypeOf(item);
    if (proto !== Object.prototype && proto !== null) fail("entries must be plain mappings");
    const rec = item as Record<string, unknown>;
    const extra = Reflect.ownKeys(rec).find((k) => typeof k !== "string" || !ENTRY_KEYS.includes(k));
    if (extra !== undefined) fail(`entry has unknown key ${String(extra)}; an entry takes endpoint, commands and instanceId`);
    const endpoint = rec.endpoint;
    if (typeof endpoint !== "string") fail("entry needs an endpoint name");
    try {
      endpointToken(endpoint as string);
    } catch (e) {
      fail(`entry: ${(e as Error).message}`);
    }
    if (!(endpoint as string).includes("."))
      fail(`entry names "${endpoint as string}", a single-label endpoint; those are the reference endpoints, reached through the baseline and the spawn, run and admin capabilities. A persona hands on a reverse-DNS endpoint such as com.example.orders`);
    let instanceId: string | undefined;
    if (rec.instanceId !== undefined) {
      if (typeof rec.instanceId !== "string") fail(`entry for ${endpoint as string}: instanceId must be a string`);
      try {
        instanceId = assertLifecycleToken(rec.instanceId as string, "instanceId");
      } catch (e) {
        fail(`entry for ${endpoint as string}: ${(e as Error).message}`);
      }
    }
    const commands = rec.commands;
    if (!Array.isArray(commands) || commands.length === 0) fail(`entry for ${endpoint as string} needs a non-empty commands list`);
    const key = `${endpoint as string}\u0000${instanceId ?? ""}`;
    const into = merged.get(key) ?? { endpoint: endpoint as string, commands: [], ...(instanceId !== undefined ? { instanceId } : {}) };
    for (const c of commands as unknown[]) {
      if (typeof c !== "string") fail(`entry for ${endpoint as string}: commands must be strings`);
      try {
        assertCommandToken(c as string);
      } catch (e) {
        fail(`entry for ${endpoint as string}: ${(e as Error).message}`);
      }
      if ((RESERVED_COMMANDS as readonly string[]).includes(c as string))
        fail(`entry for ${endpoint as string} names the reserved command "${c as string}"; describe is granted on every endpoint and cancel is not handed on`);
      if (!into.commands.includes(c as string)) {
        into.commands.push(c as string);
        total++;
      }
    }
    merged.set(key, into);
  }
  if (total > PERSONA_ENDPOINT_MAX_COMMANDS) fail(`names ${total} commands; a persona may name at most ${PERSONA_ENDPOINT_MAX_COMMANDS}`);
  return [...merged.values()]
    .map((e) => ({ ...e, commands: [...e.commands].sort() }))
    .sort((a, b) => (a.endpoint < b.endpoint ? -1 : a.endpoint > b.endpoint ? 1 : (a.instanceId ?? "") < (b.instanceId ?? "") ? -1 : 1));
}

/** A fresh copy of an already parsed list, so a holder of the original cannot change the copy. */
export function copyPersonaEndpoints(entries: readonly PersonaEndpoint[] | undefined): PersonaEndpoint[] | undefined {
  return entries?.map((e) => ({ endpoint: e.endpoint, commands: [...e.commands], ...(e.instanceId !== undefined ? { instanceId: e.instanceId } : {}) }));
}

/** The name a refusal gives one lowered capability: `<endpoint> <command>`. */
export function personaEndpointPartName(cap: Pick<EpCapability, "endpoint" | "command" | "instanceId">): string {
  return `${cap.endpoint} ${cap.command}${cap.instanceId !== undefined ? ` on instance ${cap.instanceId}` : ""}`;
}

/**
 * The caller capabilities a parsed list grants, each untargeted and unjournaled. A class entry
 * grants one capability per command on the endpoint's class rail. An entry with `instanceId` grants
 * each command on that instance's rail only, never the class rail, plus that instance's `describe`,
 * which a pinned call resolves through and the class baseline does not cover. User-auth issuance
 * appends the same describe row to an instance grant.
 */
export function lowerPersonaEndpoints(entries: readonly PersonaEndpoint[] | undefined): EpCapability[] {
  const out: EpCapability[] = [];
  for (const e of entries ?? []) {
    if (e.instanceId === undefined) {
      for (const command of e.commands) out.push({ endpoint: e.endpoint, command });
      continue;
    }
    const pin = { instanceId: e.instanceId, instanceOnly: true };
    for (const command of e.commands) out.push({ endpoint: e.endpoint, command, ...pin });
    out.push({ endpoint: e.endpoint, command: "describe", ...pin });
  }
  return out;
}
