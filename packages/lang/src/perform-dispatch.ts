/** Per-primitive dispatch: from evaluated argument VALUES to the handler, with the crossability
 *  refusals, the freeze on share and each effect's hashed projection, ending in `performEffect`, plus
 *  the `waitUntil` observation loop. Both engines reach it through `perform.ts`. */
import { InterpreterDefect, RuntimeFault } from "./errors.js";
import { atMostOnce, requestId, stepKeyString } from "./keys.js";
import { type EntryError } from "./journal.js";
import { NotCrossable, assertCrossable, deepFreeze } from "./values.js";
import { HOLDABLE_KINDS, PRIMITIVES } from "./primitives.js";
import { parseDuration } from "./duration.js";
import { notifyFactViolation } from "./notify-fact.js";
import {
  EffectError,
  applyCheckpointPolicy,
  type AgentHandleValue,
  type ChannelHandleValue,
  type CheckpointRaw,
  type EventDescriptor,
  type InlineSpawnDefinition,
  type ParticipantRequest,
} from "./effects.js";
import {
  agentHandle,
  agentHandles,
  type EffectFrame,
  type EffectHost,
  enterStep,
  type Frame,
  type LiveStep,
  notHoldable,
  option,
  performEffect,
  settleDispatchThrown,
} from "./perform.js";

/**
 * Is this value a `spawn` placement: an `{ endpoint, instanceId }` pair of non-empty strings?
 *
 * THE VALUE, NOT THE BAG. {@link option} answers `undefined` when the BAG is null or is not an
 * object, which is the right guard for a missing option bag and no guard at all on what the bag
 * holds: `{ placement: null }` is a perfectly good object whose `placement` is `null`, and it
 * came back as `null`, passed a `!== undefined` test, and was dereferenced.
 *
 * An array is refused along with every other non-record: `typeof [] === "object"`, so an array
 * reaches `.endpoint` as `undefined` rather than as an error, and `["manager", "i1"]` is exactly
 * the shape an author writes when they have guessed the pair is positional.
 *
 * Emptiness is part of the shape rather than a separate rule, and it matches what the runtime
 * already refuses at mesh-handler (L4000, "must name both an endpoint and an instanceId"): an
 * empty string names no instance, and a placement that names no instance cannot pin a seat.
 */
function isPlacementPair(v: unknown): v is { endpoint: string; instanceId: string } {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return false;
  const r = v as Record<string, unknown>;
  return typeof r.endpoint === "string" && r.endpoint.length > 0
    && typeof r.instanceId === "string" && r.instanceId.length > 0;
}

/**
 * How a malformed placement is named back to its author.
 *
 * `JSON.stringify` alone is not enough: it answers `undefined` for `undefined` and for a function,
 * so the message would read "it was given undefined" for three different mistakes and would
 * interpolate the literal word into the sentence. Each wrong shape is named as what it IS, and a
 * record is shown with the keys it actually carried, because the commonest case is a pair with one
 * half missing and the author needs to see which half.
 */
const INLINE_STRINGS = ["role", "model", "variant", "description"] as const;

const INLINE_LISTS = ["subscribe", "allowSubscribe", "allowPublish", "capabilities"] as const;

const INLINE_KEYS: readonly string[] = ["name", "prompt", ...INLINE_STRINGS, ...INLINE_LISTS, "endpoints", "save"];

const ENDPOINT_KEYS: readonly string[] = ["endpoint", "commands", "instanceId"];

/**
 * The inline persona a `spawn`'s first argument carries, or `undefined` for a catalog spawn (§6.1).
 * A record with `prompt` is inline; a record with `persona` names the catalog. The record is closed
 * and checked here, before the step key is minted, so a malformed definition is never hashed or
 * journalled. The copy holds only the keys the program wrote, so omitting a list and writing `[]`
 * stay different definitions, as they are to the manager.
 */
function inlineDefinition(subject: unknown): InlineSpawnDefinition | undefined {
  if (subject === null || typeof subject !== "object" || Array.isArray(subject) || !("prompt" in subject)) return undefined;
  const r = subject as Record<string, unknown>;
  const refuse = (why: string): never => {
    throw new RuntimeFault("L3049", `spawn's inline persona ${why}`);
  };
  if ("persona" in r) refuse("also names a catalog persona: a record with `prompt` defines the helper and a record with `persona` names a saved one, so pass one or the other");
  const unknown = Object.keys(r).filter((k) => !INLINE_KEYS.includes(k));
  if (unknown.length) refuse(`carries ${unknown.map((k) => `\`${k}\``).join(", ")}, which an inline persona has no field for; its fields are ${INLINE_KEYS.join(", ")}`);
  const nonBlank = (v: unknown): boolean => typeof v === "string" && v.trim() !== "";
  if (!nonBlank(r.name)) refuse("names no helper: `name` must be a non-empty string");
  if (!nonBlank(r.prompt)) refuse("has no prompt: `prompt` must be a non-empty string, the helper's persona body");
  const out: Record<string, unknown> = { name: r.name, prompt: r.prompt };
  for (const k of INLINE_STRINGS) {
    if (r[k] === undefined) continue;
    if (!nonBlank(r[k])) refuse(`\`${k}\` must be a non-empty string when present`);
    out[k] = r[k];
  }
  for (const k of INLINE_LISTS) {
    if (r[k] === undefined) continue;
    if (!Array.isArray(r[k]) || !(r[k] as unknown[]).every((c) => typeof c === "string"))
      refuse(`\`${k}\` must be a list of strings when present`);
    out[k] = [...(r[k] as string[])];
  }
  // The shape only: the manager reads the names (reserved commands, single-label endpoints) and
  // bounds each command against the run, as it does for a persona file.
  if (r.endpoints !== undefined) {
    if (!Array.isArray(r.endpoints)) refuse("`endpoints` must be a list of { endpoint, commands, instanceId? } entries when present");
    out.endpoints = (r.endpoints as unknown[]).map((e) => {
      if (e === null || typeof e !== "object" || Array.isArray(e)) refuse("`endpoints` entries must be records of endpoint, commands and an optional instanceId");
      const entry = e as Record<string, unknown>;
      const extra = Object.keys(entry).filter((k) => !ENDPOINT_KEYS.includes(k));
      if (extra.length) refuse(`\`endpoints\` entry carries ${extra.map((k) => `\`${k}\``).join(", ")}; an entry takes ${ENDPOINT_KEYS.join(", ")}`);
      if (!nonBlank(entry.endpoint)) refuse("`endpoints` entry needs a non-empty `endpoint` string");
      if (!Array.isArray(entry.commands) || entry.commands.length === 0 || !(entry.commands as unknown[]).every(nonBlank))
        refuse(`\`endpoints\` entry for ${entry.endpoint as string} needs a non-empty \`commands\` list of strings`);
      if (entry.instanceId !== undefined && !nonBlank(entry.instanceId)) refuse(`\`endpoints\` entry for ${entry.endpoint as string}: \`instanceId\` must be a non-empty string when present`);
      return { endpoint: entry.endpoint, commands: [...(entry.commands as string[])], ...(entry.instanceId !== undefined ? { instanceId: entry.instanceId } : {}) };
    });
  }
  if (r.save !== undefined) {
    if (typeof r.save !== "boolean") refuse("`save` must be true or false when present");
    out.save = r.save;
  }
  return deepFreeze(out) as unknown as InlineSpawnDefinition;
}

function describePlacement(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return `an array (${JSON.stringify(v)}); placement is a record, not a positional pair`;
  if (typeof v === "function") return "a function";
  if (typeof v !== "object") return `the ${typeof v} ${JSON.stringify(v) ?? String(v)}`;
  const r = v as Record<string, unknown>;
  const names = Object.keys(r);
  const missing = ["endpoint", "instanceId"].filter((k) => typeof r[k] !== "string" || (r[k] as string).length === 0);
  return names.length === 0
    ? "an empty record, which names neither an endpoint nor an instanceId"
    : `${JSON.stringify(r)}, which is missing ${missing.join(" and ")}`;
}

/**
 * The per-run turn queues, keyed by agent identity (§6.5: one agent, one turn at a time).
 *
 * A WeakMap off the host rather than a field on it, so neither engine's host construction
 * changes. The map holds only a settled-swallowed tail per agent; each caller still observes its
 * own dispatch's outcome, and a failed turn does not dam the queue behind it.
 *
 * BOTH DISPATCH SITES SHARE IT. `ask` is relayed to the seat as a turn, so an ask queued
 * separately from `turn` would still be a second concurrent turn on the same agent.
 */
const TURN_QUEUES = new WeakMap<EffectHost, Map<string, Promise<unknown>>>();

/** Serialize live `turn` and `ask` dispatches per agent handle: the next begins when the previous
 *  settled. */
function serializeTurn(host: EffectHost, agent: string, dispatch: () => Promise<unknown>): Promise<unknown> {
  let queues = TURN_QUEUES.get(host);
  if (queues === undefined) {
    queues = new Map();
    TURN_QUEUES.set(host, queues);
  }
  const prev = queues.get(agent) ?? Promise.resolve();
  const next = prev.then(dispatch, dispatch);
  queues.set(
    agent,
    next.then(
      () => undefined,
      () => undefined,
    ),
  );
  return next;
}

/**
 * `waitUntil`: the durable wait on something that is not a mesh event.
 *
 * IT DOES NOT GO THROUGH {@link performEffect}, and that is the whole point rather than an
 * exemption. `performEffect` is built around a single dispatch whose outcome SETTLES the entry, and
 * `lookup` serves a settled entry by handing `result` back with no handler call at all. Run a
 * poll through that and the first observation becomes the step's answer forever: measured on this
 * exact shape before this function existed, a run that observed `"pending"` once replayed
 * `"pending"` on every later activation, for a resource that had since completed, and the handler
 * was never called again. That is #1459's sharp half, and no amount of care inside a handler can
 * reach it, because the handler is not invited.
 *
 * So the durable shape is different in one specific way: a NON-TERMINAL observation is appended to
 * the entry with {@link Journal.observe} and the entry STAYS PENDING. `lookup` answers `pending`
 * for it, which routes to the live path, so a resumed run OBSERVES AGAIN. Only the terminal
 * observation settles, because only that one is an answer. Everything else about the entry is the
 * ordinary contract, entered through {@link enterStep} like every other effect: it begins before
 * the first observation, it carries the request id a handler waits under, and the two failure
 * domains stay separate.
 *
 * WHO OWNS WHAT. The program owns the probe and the predicate; the runtime owns the cadence and
 * the deadline. A program that hand-rolled this with `sleep` in a loop owns all four, which is the
 * duplication §6 complains about, and it still could not re-observe: its `sleep` and its poll are
 * two settled steps, so the poll's recorded answer is replayed exactly as before.
 */
async function performWaitUntil(
  host: EffectHost,
  name: string,
  hashedInput: unknown,
  probe: (frame: EffectFrame) => Promise<unknown>,
  terminal: ((frame: EffectFrame, observation: unknown) => Promise<unknown>) | undefined,
  every: string,
  deadline: string,
  frame: Frame,
): Promise<unknown> {
  // A SETTLED `waitUntil` replays like any other step, and it must: what settled it was the
  // TERMINAL observation, which IS an answer, and re-observing a wait that already finished
  // would re-ask a question the run has answered. Only the unfinished ones re-observe.
  return await enterStep(host, "waitUntil", name, hashedInput, frame, (step) =>
    observeUntil(host, step, name, probe, terminal, every, deadline, frame));
}

/**
 * Observe a live `waitUntil` until a terminal observation or the deadline settles its entry.
 */
async function observeUntil(
  host: EffectHost,
  { key, pending, ctx }: LiveStep,
  name: string,
  probe: (frame: EffectFrame) => Promise<unknown>,
  terminal: ((frame: EffectFrame, observation: unknown) => Promise<unknown>) | undefined,
  every: string,
  deadline: string,
  frame: Frame,
): Promise<unknown> {
  // THE DEADLINE IS ABSOLUTE AND IT IS READ BACK, never recomputed from a clock that has moved.
  // Recomputing `now + deadline` on every activation is how an hour-long wait becomes immortal:
  // each crash would hand it a fresh hour, and a run that should have given up at 11:00 goes on
  // waiting forever, which is the same class of defect as the one this primitive fixes. The
  // entry's own `startedAt` is the epoch, and it survives because the entry does.
  const startedAt = host.journal.get(key)?.startedAt ?? host.options.handler.now();
  const deadlineAt = startedAt + parseDuration(deadline);

  // Which observation this is, carried on the request. It is not `ctx.attempt`, the attempt the
  // request id names, which every observation shares.
  let attempt = (pending?.observations ?? []).length;
  for (;;) {
    // EACH OBSERVATION GETS ITS OWN KEY NAMESPACE, and this is the half of the fix that is easy
    // to miss. The probe reaches the world by performing effects, and those effects allocate keys
    // in the frame it runs in. Share one namespace across observations and observation 2's probe
    // allocates the key observation 1's probe already settled: the journal answers `replay`, the
    // probe is handed back the FIRST look's result, and the wait re-observes while its probe does
    // not. The re-observation would be a ritual. A per-observation branch makes each look a
    // namespace nothing has written to, so a resumed wait's next look runs live.
    const observing = frame.branch("waitUntil", name, key.occurrence, String(attempt));

    // THE CADENCE IS THE HANDLER'S, and the first observation skips it: a wait that sleeps before
    // it has ever looked is a wait that cannot notice a predicate which already holds, and the
    // canonical use ("are the checks done") is very often already true by the time the run asks.
    // The request carries the cadence either way and `attempt` is what says to skip it, so the
    // fact never has to go missing to be communicated.
    let inTime: boolean;
    try {
      inTime = await host.options.handler.observe({ name, every, deadlineAt, deadline, attempt }, ctx);
    } catch (e) {
      return await settleDispatchThrown(host, key, frame, e, host.options.handler.now());
    }

    if (!inTime) {
      // THE DEADLINE, and it is CATCHABLE with its own code, exactly as `turn`'s L4003 is. A wait
      // that gave up is a fact about the world the program asked about, so the program decides
      // what to do next; it is not a fault of the run's. The failure settles the entry, carrying
      // how many times it looked, because "I observed 60 times over an hour and it never held" is
      // the sentence whoever reads this needs.
      const endedAt = host.options.handler.now();
      const looked = (host.journal.get(key)?.observations ?? []).length;
      const error: EntryError = {
        code: "L4023",
        kind: "wait-until-deadline",
        message:
          `L4023 \`waitUntil\` deadline elapsed\n\n  step  ${stepKeyString(key)}   ${looked} observation${looked === 1 ? "" : "s"} over ${deadline}\n\n`
          + `The predicate never held: every observation this wait made was non-terminal, and the deadline passed.\n\n`
          + `Options\n  catch it: \`e.code === "L4023"\` and chase, escalate, or proceed degraded\n  raise \`deadline\`, or widen \`terminal\` if a state you meant to accept is being read as still-pending`,
        detail: { observations: looked, deadline, every },
      };
      await host.journal.settle(key, { status: "failed", error }, endedAt);
      frame.clock.advance(endedAt);
      throw new EffectError(error.code, error.kind, error.message, error.detail);
    }

    // THE PROBE IS THE PROGRAM'S OWN CODE, called by the runtime. Its answer is refused here if it
    // has no canonical form, with its own code: it is about to be journalled AND handed back to
    // the program, so the two things a recorded value must be able to do are exactly what it
    // cannot do. Blamed as L4024 rather than L3041 because nothing crossed a boundary at a CALL —
    // a function the runtime invoked answered the wrong shape, and the repair differs.
    const observation = await probe(observing);
    try {
      assertCrossable(observation, `the observation of ${stepKeyString(key)}`);
    } catch (e) {
      if (!(e instanceof NotCrossable)) throw e;
      throw new RuntimeFault(
        "L4024",
        `this \`waitUntil\`'s probe answered with a value that cannot be recorded: ${e.message}. Every observation is journalled as history and handed to \`terminal\`, so it has to be data. Return what you read (a status string, a record of counts), not the object you read it from.`,
      );
    }

    // THE PREDICATE IS THE PROGRAM'S TOO, and it decides the ONE thing the runtime cannot: whether
    // this observation is an answer. Absent, any observation that is not `null` is terminal, which
    // makes the no-predicate form mean "wait until there is something", and a probe that answers
    // null while it waits is the idiom that shape serves.
    const decided = terminal === undefined ? observation !== null : await terminal(observing, observation);
    if (typeof decided !== "boolean") {
      throw new RuntimeFault(
        "L4024",
        `this \`waitUntil\`'s \`terminal\` answered ${JSON.stringify(decided) ?? "undefined"} rather than true or false. It decides whether an observation ENDS the wait, so a value that is merely truthy is not enough: a predicate that accidentally returns a record would end every wait on its first look. Return a comparison.`,
      );
    }

    const at = host.options.handler.now();
    // The wait's own clock carries what its observations awaited: an observation is an effect this
    // step performed, so the time it consumed is time this step consumed.
    frame.clock.join([observing.clock]);
    if (decided) {
      // THE TERMINAL OBSERVATION IS THE ANSWER, so it settles, and it is recorded in BOTH places
      // on purpose. `result` is what a later activation replays, which is correct now that the
      // wait is over; `observations` keeps the whole history, so the record says how long the
      // world took to get there rather than only where it ended up.
      await host.journal.observe(key, observation, at);
      await host.journal.settle(key, { status: "ok", result: deepFreeze(observation) }, at);
      frame.clock.advance(at);
      return observation;
    }

    // NOT AN ANSWER: recorded as HISTORY, and the entry stays PENDING. This single line is what
    // #1459 asks for. A resume finds a pending entry, `lookup` answers `pending`, the live path
    // runs, and the world is observed again — instead of the recorded "pending" being handed back
    // as though it were still true.
    await host.journal.observe(key, observation, at);
    frame.clock.advance(at);
    attempt += 1;
  }
}

/**
 * Dispatch one non-scope primitive from evaluated argument VALUES: the crossability refusals, the
 * freeze on share, and the per-primitive hashed projection, ending in {@link performEffect}. The
 * scope-openers never come here: their branches must stay unevaluated.
 *
 * It takes a full {@link Frame} rather than an {@link EffectFrame} because `waitUntil` gives each
 * observation its own key namespace, which needs `branch`. Both engines already pass a real frame;
 * declaring what is actually required is what keeps that a checked fact rather than a cast.
 */
export async function dispatchPrimitive(host: EffectHost, name: string, args: unknown[], frame: Frame): Promise<unknown> {
  const spec = PRIMITIVES[name];
  if (spec === undefined) throw new RuntimeFault("L2001", `${name} is not a primitive`);
  if (name === "ask" || name === "turn" || name === "monitor") agentHandle(args[0], `argument 1 of \`${name}\``);
  if (name === "notify") agentHandles(args[0], "argument 1 of `notify`");
  // Every argument crosses the effect boundary: it is hashed, recorded, or handed to the handler,
  // and a value with no canonical form can be none of those. Refused HERE, before any entry is
  // written, with the argument named: `undefined`, a non-finite number and an opaque object are
  // L3041, a function is L3042. The result of the effect is held to the same rule in
  // {@link Interpreter.performEffect}.
  //
  // THE PROBE IS THE ONE EXEMPTION, and it is an exemption from the RULE'S PREMISE rather than a
  // hole in the rule. The premise is "this value crosses to a handler or a journal", and a probe
  // does neither: it is program code the INTERPRETER calls, in the program's own compartment, and
  // what crosses is the observation it returns, which is held to the full rule at every
  // observation. A `fanOut`'s branch function is the same shape and avoids this loop only because
  // a scope-opener never reaches it. Driven by `probeAt` from the table, so a second primitive
  // taking a probe cannot arrive with the exemption silently missing or silently wrong.
  args.forEach((arg, i) => {
    if (spec.probeAt === i) return;
    try {
      // A bag holding a declared function option is checked KEY BY KEY, so every other key in it
      // still answers to the rule whole: exempting the bag wholesale would let a stray function
      // anywhere inside it through, which is the loophole rather than the exemption.
      if (i === spec.optionsAt && spec.functionOptions !== undefined && arg !== null && typeof arg === "object") {
        for (const [k, v] of Object.entries(arg as Record<string, unknown>)) {
          if (spec.functionOptions.includes(k)) continue;
          assertCrossable(v, `\`${k}\` of \`${name}\``);
        }
        return;
      }
      assertCrossable(arg, `argument ${i + 1} of \`${name}\``);
    } catch (e) {
      if (e instanceof NotCrossable) throw new RuntimeFault(e.why === "function" ? "L3042" : "L3041", e.message);
      throw e;
    }
  });
  // FREEZE ON SHARE, at the share. What crossed is what was hashed and recorded, so the program
  // mutating it afterwards, or the HANDLER mutating it on its side, would make the run's own
  // value disagree with its recorded form (measured before this line: `schema.deep.x = 2` after
  // an `ask` succeeded, no L2031, and a handler's write to `req.schema` reached the program).
  for (const arg of args) deepFreeze(arg);
  const bag = args[spec.optionsAt];
  const stepName = (name === "checkpoint" ? args[0] : option(bag, "name")) as string | undefined;
  const handler = host.options.handler;
  if (spec.kind !== null && !HOLDABLE_KINDS.has(spec.kind) && atMostOnce(frame.keys.path)) throw notHoldable(spec.kind, frame.keys.path);

  switch (name) {
    case "participant": {
      const named = option(bag, "name");
      const req: ParticipantRequest = named === undefined ? {} : { name: named as string };
      return await performEffect(
        host,
        "participant",
        req.name ?? "participant",
        {},
        async (ctx) => ({ ...await handler.participant(req, ctx), kind: "participant" as const }),
        frame,
      );
    }
    case "spawn": {
      // The first argument is a persona name, or a record carrying the persona WITH its model
      // and variant. Only the persona was ever read, so the object form silently dropped model
      // and variant from both the request and the hash: editing a model did not diverge, and the
      // handler was never told which model to run. This was missed by an audit that exercised
      // only the string form, which is the same defect one level up.
      const spawnSubject = args[0];
      const inline = inlineDefinition(spawnSubject);
      const named = typeof spawnSubject === "string" ? spawnSubject : inline?.name ?? option(spawnSubject, "persona");
      // `String(undefined)` is the literal persona "undefined", and it was reaching the input hash,
      // the step name and the handler. A missing persona is `undefined` crossing an effect
      // boundary, which is what L3041 names.
      if (typeof named !== "string" || named === "")
        throw new RuntimeFault(
          "L3041",
          `spawn names no persona: its first argument is ${JSON.stringify(spawnSubject) ?? "undefined"}, and a spawn takes a persona name or a record carrying one`,
        );
      const persona = named;
      // PLACEMENT IS VALIDATED HERE, BEFORE ANYTHING READS INTO IT.
      //
      // `option()` guards the BAG being null, not the VALUE, so `option(bag, "placement")` answers
      // `null` for `placement: null` and the `!== undefined` test below FORWARDS it. The identity
      // projection further down then reads `req.placement.endpoint`, and that is a raw `TypeError`
      // out of the interpreter: no code, no effect kind, no journal entry, and a stack trace handed
      // to an author where the runtime's own named refusal (mesh-handler's L4000 "placement must
      // name both an endpoint and an instanceId") was written to speak. The runtime's refusal is
      // correct and stays; it simply never ran, because the value died one layer earlier.
      //
      // ALL FOUR MALFORMED SHAPES ARE REFUSED, not just the one that crashed. A primitive, an empty
      // record and a half-filled record did NOT throw: they projected `endpoint: undefined,
      // instanceId: undefined` into the step identity and travelled on. That is the worse half of
      // the defect — `undefined` has no canonical form (§4.4), so what got hashed was a placement
      // the program never named, and the crash at least stopped. Refusing the shape rather than the
      // null is what makes the hash mean the target again.
      //
      // It is a call-shape refusal (L3xxx) and it is raised BEFORE the step key is minted, so a
      // malformed placement writes nothing to the journal: there is no entry to replay, and the
      // fix is an edit to the program rather than a migration.
      const placementValue = option(bag, "placement");
      if (placementValue !== undefined && !isPlacementPair(placementValue))
        throw new RuntimeFault(
          "L3048",
          `spawn(${persona}) placement must name BOTH an endpoint and an instanceId, each a non-empty string: it was given ${describePlacement(placementValue)}. A host-local seat is pinned to one manager instance, and the target is hashed into this step's identity, so a half-named target would record a placement the program never asked for. Pass placement: { endpoint: "manager", instanceId: "<the instance's id>" }.`,
        );
      const model = typeof spawnSubject === "string" ? undefined : (option(spawnSubject, "model") as string | undefined);
      const variant = typeof spawnSubject === "string" ? undefined : (option(spawnSubject, "variant") as string | undefined);
      // `inline` already holds the definition's model and variant, so `req.model` and `req.variant`
      // stay what a catalog spawn's overrides are: absent for an inline one.
      // Every accepted option is forwarded, including the four that are policy rather than
      // identity. Dropping them here would be silent: the validator accepts `permits`, so an
      // author who writes a budget gets no error and no budget. They are deliberately absent
      // from `hashedOptions` (§5.12) because they decide the INTERPRETATION of a result, not the
      // recorded fact, so they are reapplied from current source on resume rather than hashed.
      const req = {
        persona,
        ...(inline !== undefined ? { inline } : {}),
        ...(inline === undefined && model !== undefined ? { model } : {}),
        ...(inline === undefined && variant !== undefined ? { variant } : {}),
        ...(option(bag, "cwd") !== undefined ? { cwd: option(bag, "cwd") as string } : {}),
        // The VALIDATED value, not a second `option()` read cast into the pair type. The cast was
        // the whole defect: it asserted the shape the projection then relied on, and TypeScript
        // erases at run time, so the assertion was a comment that looked like a check.
        ...(placementValue !== undefined ? { placement: placementValue } : {}),
        ...(option(bag, "worktree") !== undefined ? { worktree: option(bag, "worktree") as string } : {}),
        ...(option(bag, "role") !== undefined ? { role: option(bag, "role") as string } : {}),
        ...(option(bag, "join") !== undefined ? { join: option(bag, "join") as ChannelHandleValue[] } : {}),
        ...(option(bag, "permits") !== undefined
          ? { permits: option(bag, "permits") as Record<string, unknown> }
          : {}),
        ...(option(bag, "supervise") !== undefined
          ? { supervise: option(bag, "supervise") as Record<string, unknown> }
          : {}),
        ...(option(bag, "onFork") !== undefined ? { onFork: option(bag, "onFork") as "respawn" | "adopt" } : {}),
        ...(option(bag, "events") !== undefined ? { events: option(bag, "events") as boolean } : {}),
        ...(option(bag, "runtime") !== undefined ? { runtime: option(bag, "runtime") as string } : {}),
      };
      return await performEffect(host,
        "spawn",
        stepName ?? persona,
        // Model and variant are part of the IDENTITY being spawned, so they are hashed with the
        // persona (design 5.12). A run that swapped the model under a recorded agent would be
        // replaying a fact about a different agent.
        {
          persona,
          model: model ?? null,
          variant: variant ?? null,
          // #1616 item 3, identity half: placement and `cwd` are hashed WHEN PRESENT and contribute
          // NO KEY AT ALL when omitted, which is the same rule `req` above already follows. The
          // first cut of this wrote `cwd: req.cwd ?? null` and `placement: ... ?? null`
          // unconditionally, and that is a REPLAY COMPATIBILITY BREAK, not a cosmetic difference: a
          // legacy spawn that never mentioned either option hashed a six-key object, and hashing an
          // eight-key object carrying two nulls it never had changes its `inputHash` — so every
          // recorded pre-#1616 spawn step diverges on resume. `digest` canonicalizes (RFC 8785), so
          // the key SET is what the hash is over and a present-but-null key is a different set.
          //
          // Absent contributes nothing; PRESENT IS HASHED. Not hashing placement at all would also
          // restore the legacy hash, and would be wrong for the other direction: replaying a step
          // against a different manager instance must DIVERGE as a migration rather than silently
          // reuse the resolution that was taken against the old instance.
          ...(req.cwd !== undefined ? { cwd: req.cwd } : {}),
          ...(req.placement !== undefined
            ? { placement: { endpoint: req.placement.endpoint, instanceId: req.placement.instanceId } }
            : {}),
          worktree: req.worktree ?? null,
          role: req.role ?? null,
          join: (req.join ?? []).map((c) => c.channel),
          // An inline persona IS the identity, so the whole definition is hashed. A catalog spawn
          // adds no key, so its recorded hash is unchanged.
          ...(inline !== undefined ? { inline } : {}),
        },
        async (ctx) => ({ ...await handler.spawn(req, ctx), kind: "spawned" as const }),
        frame,
      );
    }
    case "turn": {
      const agent = deepFreeze(args[0]) as AgentHandleValue;
      // The deadline STOPS OBSERVATION (design 5.12), so it belongs in the projection: a turn
      // recorded under a 1m deadline cannot answer what a 10m turn would have produced, and a
      // resumed run under the edited deadline replaying the old result is the silent-wrong-path
      // class. Closing that for `checkpoint` and leaving it open on the siblings closed nothing.
      const deadline = option(bag, "deadline") as string | undefined;
      return await performEffect(host,
        "turn",
        stepName as string,
        { agent: agent.agent, deadline: deadline ?? null },
        // ONE AGENT, ONE TURN AT A TIME (§6.5). Two branches turning the same handle used to
        // dispatch concurrently, with nothing anywhere serializing them; the queue sits at the
        // seam both engines share, so every handler benefits and the order is dispatch order.
        // Replays never reach this callback, so a recorded turn waits on nothing.
        (ctx) => serializeTurn(host, agent.agent, () => handler.turn({ agent, ...(deadline !== undefined ? { deadline } : {}) }, ctx)),
        frame,
      );
    }
    case "ask": {
      const agent = deepFreeze(args[0]) as AgentHandleValue;
      const schema = option(bag, "schema");
      // Both of these END THE ASKING: `deadline` is the cutoff and `attempts` is how many
      // schema-failed replies are tolerated before it gives up. A record made under one attempt
      // is not an answer to what five attempts would have produced.
      const deadline = option(bag, "deadline") as string | undefined;
      const attempts = option(bag, "attempts") as number | undefined;
      return await performEffect(host,
        "ask",
        stepName as string,
        { agent: agent.agent, schema: schema ?? null, deadline: deadline ?? null, attempts: attempts ?? null },
        (ctx) =>
          // THE SAME QUEUE AS `turn`. A host relays an ask to the seat as a turn, so an unqueued
          // ask beside a queued turn on one handle hands that agent two turns at once, which 6.5
          // forbids by name. One queue per agent covers both dispatch sites.
          serializeTurn(host, agent.agent, () =>
            handler.ask(
              {
                agent,
                schema,
                ...(deadline !== undefined ? { deadline } : {}),
                ...(attempts !== undefined ? { attempts } : {}),
              },
              ctx,
            )),
        frame,
      );
    }
    case "checkpoint": {
      const prompt = args[1] as string;
      // The disposition is computed from TODAY's source, after the journal is consulted, on the
      // live path and the replay path alike. performEffect returns the RAW outcome, which is
      // what the journal holds; the policy sandwich closes here so a resumed run under an edited
      // onExpiry throws even though nothing about the recorded expiry changed.
      const onExpiry = option(bag, "onExpiry") as "fail" | "proceed" | "escalate" | undefined;
      const schema = option(bag, "schema");
      // The SAME projection the entry is keyed by, so an attempt's identity is a function of the
      // step it belongs to rather than of anything the escalation invents.
      // Design 5.12, and every field here earns its place. `timeout` STOPS OBSERVATION, so a
      // record made under 1m cannot answer what a 3m wait would have seen. `escalate` and its
      // `to` CREATE AN EFFECT rather than choosing a disposition, so editing them must diverge
      // rather than be reapplied. `fail` versus `proceed` is the one genuine reapply and stays
      // out. Hashing only prompt and schema left a timeout edit replaying clean, which is the
      // silent-wrong-path class this projection exists to close.
      const cpTimeout = option(bag, "timeout") as string | undefined;
      const cpTo = option(bag, "to") as string | undefined;
      const cpInput = {
        prompt,
        schema: schema ?? null,
        timeout: cpTimeout ?? null,
        ...(onExpiry === "escalate" ? { onExpiry, to: cpTo ?? null } : {}),
      };
      return applyCheckpointPolicy(
        (await performEffect(host,
        "checkpoint",
        stepName as string,
        cpInput,
        async (ctx, inputHash) => {
          // ONE hash value, threaded from what the entry is actually keyed by rather than
          // re-digested from the projection here. The two agreed, which is exactly the problem:
          // a second derivation that happens to match is a coincidence maintained by hand, and
          // the first edit to the projection would desync attempt 1's identity from its own
          // step with no type error and no failing test.
          const attemptId = (n: number) => requestId(host.options.runId, ctx.key, inputHash, n);
          const req = {
            prompt,
            ...(schema !== undefined ? { schema } : {}),
            ...(cpTimeout !== undefined ? { timeout: cpTimeout } : {}),
            ...(onExpiry !== undefined ? { onExpiry } : {}),
            ...(cpTo !== undefined ? { to: cpTo } : {}),
          };
          // THE FINAL MINT DOES NOT ASK FOR AN ESCALATION. The interpreter owns the one-hop stop
          // rule, and it can only own it if the far side is not simultaneously told to hop: a
          // handler that honours `onExpiry` on the wire would mint a third attempt under an
          // identity this journal never allocated, and nothing here would ever learn of it.
          const finalReq = onExpiry === "escalate" ? { ...req, onExpiry: "proceed" as const } : req;

          // RECOVERY COMPLETES THE OPEN ATTEMPT. IT DOES NOT REPLAY THE CHAIN.
          //
          // Arriving here with a non-zero attempt means the hop was issued before the crash, so
          // the far side is already holding work under this very id. Re-running the live body
          // from the top would call the handler again under it and take that call's cached
          // expiry for a second observation: the stop rule would be satisfied on paper while the
          // run had in fact observed one attempt twice. The chain's shape is recoverable without
          // re-running it, because attempt 0's identity is derivable and its outcome is implied:
          // the only path that opens attempt 1 is attempt 0 expiring.
          if (ctx.attempt > 0) {
            const raw = await handler.checkpoint(finalReq, ctx);
            return {
              ...raw,
              attempts: [
                { attempt: 0, requestId: attemptId(0), settled: "expired" },
                { attempt: ctx.attempt, requestId: ctx.requestId, to: cpTo ?? null, settled: raw.outcome },
              ],
            };
          }

          const first = await handler.checkpoint(req, ctx);
          if (first.outcome !== "expired" || onExpiry !== "escalate") {
            // `ctx.attempt`, not a literal 0. Writing the literal made every recovery relabel the
            // open attempt as the first one, which erased the hop from the journal and left the
            // record claiming the escalated mint was the original.
            return { ...first, attempts: [{ attempt: ctx.attempt, requestId: ctx.requestId, settled: first.outcome }] };
          }
          // ESCALATION STAYS INSIDE THIS ENTRY. The program made one call, and the interpreter
          // owns key allocation, so a second mint must not become a second occurrence. What it
          // does need is a second IDENTITY, derived from attempt 1 before the mint happens, or a
          // crash between minting and recording leaves live work nothing in the journal names.
          //
          // Name the open attempt on the pending row BEFORE issuing it, index and all.
          const nextId = attemptId(1);
          await host.journal.reissueAs(ctx.key, nextId, 1);
          const second = await handler.checkpoint(finalReq, { ...ctx, requestId: nextId, attempt: 1 });
          // ONE HOP. An escalation that can escalate again never terminates, so a second expiry
          // settles as expired and the program decides, exactly as `proceed` would.
          return {
            ...second,
            attempts: [
              { attempt: 0, requestId: ctx.requestId, settled: "expired" },
              { attempt: 1, requestId: nextId, to: cpTo ?? null, settled: second.outcome },
            ],
          };
        },
        frame,
        )) as CheckpointRaw,
        onExpiry,
        cpTimeout,
      );
    }
    case "sleep": {
      const duration = args[0] as string;
      parseDuration(duration); // fail at the call, not inside the handler
      // The duration IS hashed (design 5.12). It determines the recorded fact: a resumed run
      // reads the elapsed time back through the run clock, so editing 1h to 1m must diverge
      // rather than silently keep the path the old duration chose. This hashed `null` until
      // a reviewer executed it, and the rule it violates is one written here and then only
      // ever applied to the document.
      return await performEffect(host,
        "sleep",
        stepName ?? "",
        { duration },
        (ctx) => handler.sleep({ duration }, ctx),
        frame,
      );
    }
    case "wait": {
      const event = deepFreeze(args[0]) as EventDescriptor;
      const timeout = option(bag, "timeout") as string | undefined;
      // A `wait` that resolved null did not observe "the event never happens": it observed "the
      // event did not happen WITHIN THIS TIMEOUT". Editing the timeout therefore asks a different
      // question, and replaying the recorded null answers the old one. This is the same hole the
      // checkpoint projection closed, and leaving it open here left `?? recovery` steering off a
      // stale cutoff.
      return await performEffect(host,
        "wait",
        stepName ?? "",
        { event, timeout: timeout ?? null },
        (ctx) => handler.wait({ event, ...(timeout !== undefined ? { timeout } : {}) }, ctx),
        frame,
      );
    }
    case "waitUntil": {
      // THE PROBE IS A FUNCTION, so it is the one primitive argument that does NOT cross the
      // effect boundary as data: it is program code the runtime calls, repeatedly, and the
      // crossability loop above has already refused every other argument. It is validated
      // statically (L3045) and again here, because a computed callee is only knowable now.
      const probeArg = args[0];
      if (typeof probeArg !== "function") {
        throw new RuntimeFault(
          "L3045",
          `\`waitUntil\` takes a PROBE as its first argument: a function the runtime calls on its own cadence to observe something outside the run. It was given ${JSON.stringify(probeArg) ?? "undefined"}. Pass a function: waitUntil(() => checks(sha), { name: "checks", every: "1m", deadline: "1h" }).`,
        );
      }
      const every = option(bag, "every") as string | undefined;
      const deadline = option(bag, "deadline") as string | undefined;
      // BOTH ARE REQUIRED, and neither gets a default. A default cadence is a guess about how
      // expensive someone else's resource is to poll, and a default deadline is a wait that hangs
      // a run forever on a resource that never arrives. The validator refuses this statically too;
      // this is the computed-bag case it cannot see.
      if (every === undefined || deadline === undefined) {
        throw new RuntimeFault(
          "L3046",
          `\`waitUntil\` needs both \`every\` (how often to observe) and \`deadline\` (when to give up)${every === undefined ? ", and \`every\` is missing" : ""}${deadline === undefined ? ", and \`deadline\` is missing" : ""}. Neither has a default: a default cadence guesses how expensive someone else's resource is to poll, and a default deadline is a run that waits forever.`,
        );
      }
      // Fail at the CALL rather than inside the wait, exactly as `sleep` does with its duration:
      // a malformed cadence discovered an hour in is a wait that was never going to work.
      const everyMs = parseDuration(every);
      const deadlineMs = parseDuration(deadline);
      // ZERO IS REFUSED BEFORE THE COMPARISON, because `0 > deadline` is false and a bare ordering
      // test therefore ACCEPTS the one cadence that is not a cadence at all. A wait that pauses for
      // nothing between looks is a busy loop against a resource the run does not own, and every
      // turn of it appends to a journal that is rewritten whole. This is the computed-bag case the
      // validator cannot see.
      if (everyMs <= 0) {
        throw new RuntimeFault(
          "L3047",
          `this \`waitUntil\` observes every ${every}, which is no pause at all: it would poll the resource as fast as the run can turn and journal an observation each time. Give \`every\` a real interval, the slowest one that still notices in time.`,
        );
      }
      if (everyMs > deadlineMs) {
        throw new RuntimeFault(
          "L3047",
          `this \`waitUntil\` observes every ${every} but gives up after ${deadline}, so it would make its first observation and then fail without ever looking again. Either shorten \`every\` below \`deadline\`, or use \`sleep\` then a single check if one look is what you meant.`,
        );
      }
      const terminalArg = option(bag, "terminal");
      if (terminalArg !== undefined && typeof terminalArg !== "function") {
        throw new RuntimeFault(
          "L3045",
          `\`waitUntil\`'s \`terminal\` decides whether an observation ENDS the wait, so it must be a function; it was given ${JSON.stringify(terminalArg)}. Pass a predicate: terminal: (o) => o.state !== "pending".`,
        );
      }
      // BOTH are called in the WALKER's convention, `(frame, args)`, which is what the engine
      // adapts its own closures into as well. Calling them any other way would hand a program
      // function the frame as its first real argument. The frame handed over is the OBSERVATION's,
      // not this call's: the probe's own effects belong to the look that made them.
      const call = (fn: unknown, f: EffectFrame, xs: unknown[]) =>
        (fn as (f: EffectFrame, a: unknown[]) => Promise<unknown>)(f, xs);
      return await performWaitUntil(
        host,
        stepName as string,
        // The probe is a function and cannot be hashed, so what identifies this step is its name
        // and the two durations that STOP OBSERVATION. See the table's note.
        { every, deadline },
        async (f) => await call(probeArg, f, []),
        terminalArg === undefined ? undefined : async (f, o: unknown) => await call(terminalArg, f, [o]),
        every,
        deadline,
        frame,
      );
    }
    case "notify": {
      const agents = deepFreeze(args[0]) as AgentHandleValue[];
      const fact = deepFreeze(args[1]) as { decision: string; outcome: string };
      // THE BOUND, WHERE THE VALUE EXISTS. The validator checks a literal fact exactly and says
      // so about the computed one; this is the computed one. It is checked BEFORE the entry is
      // written, so a fact that breaks the bound never reaches a journal, a record, or a
      // handler: an out-of-bound notice recorded as performed would be laundered bytes with a
      // durable receipt. An error, never a truncation: a shortened notice still delivers.
      const violation = notifyFactViolation(fact);
      if (violation !== null) throw new RuntimeFault("L3043", violation);
      return await performEffect(host,
        "notify",
        stepName ?? "",
        { agents: agents.map((a) => a.agent), fact },
        (ctx) => handler.notify({ agents, fact }, ctx),
        frame,
      );
    }
    case "monitor": {
      const agent = deepFreeze(args[0]) as AgentHandleValue;
      return await performEffect(host,
        "monitor",
        stepName ?? "",
        { agent: agent.agent },
        (ctx) => handler.monitor({ agent }, ctx),
        frame,
      );
    }
    default:
      throw new InterpreterDefect(`the primitive ${name}`);
  }
}
