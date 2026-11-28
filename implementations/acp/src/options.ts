/**
 * A session's config options, built from what the managers offer.
 *
 * The model select lists `<agent>/<model>` grouped by agent, with a `<agent>/default` choice for
 * the application's own default. A catalog model whose id is `default` is that choice, with its
 * name and variants, and a spawn names it. Each choice's name starts with its agent, because a
 * client may flatten the groups and drop their names (T3 Code does). A Harness select names the
 * application on its own. The model value names it too, so the two always agree: choosing a model
 * moves the harness to its application, and choosing another harness starts it on that
 * application's default model.
 * A client must be able to select the default again after a named model ran, so it is a real choice
 * rather than an absent value. Applications without an event
 * plane are not offered: the bridge reads a seat's turns from that plane and has nothing to show
 * without it. A model the catalog does not list is accepted as a custom id, as a client's own model
 * field sends it, and the manager validates it at launch.
 *
 * Each model's reasoning variants also ride the session's model state, as per-model `_meta` in the
 * shape T3 Code reads (Grok's): a client can then show a model's effort choices before any session
 * selected that model. The reasoning select is offered whenever some model has variants, so such a
 * client has the option those choices belong to. A client that ignores `_meta` sees the same select,
 * holding the selected model's variants.
 */
import type { SessionConfigOption } from "@agentclientprotocol/sdk";
import type { AgentCatalog, ChannelRow, ManagerChoice, PersonaRow } from "./mesh.js";

/** The value of a model choice that leaves the model to the application. */
export const DEFAULT_MODEL = "default";
/** The value of a variant choice that leaves the variant to the model. */
export const DEFAULT_VARIANT = "default";
/** The reasoning option's id. Not `variant`: T3 Code reads an option of that id as OpenCode's own
 *  and shows its value as "Unknown" until one is chosen. */
export const REASONING = "reasoning";
/** The value of a persona choice that uses the manager's default persona. */
export const DEFAULT_PERSONA = "default";
/** The value of a channel choice that subscribes the new seat to no extra channel. */
export const NO_CHANNEL = "none";
/** The value the Machine option shows while no manager is chosen. */
const NO_MACHINE = "none";
/** A client caps a select at this many choices (T3 Code's limit). A list that does not fit is not
 *  offered rather than cut, except the persona and channel lists, which offer a short select. */
export const MAX_CHOICES = 64;
/** How many named choices a short select offers, besides its default and the current value. */
const SHORT_CHOICES = 16;

export interface Selection {
  /** `<agent>/<model>`, where the model may be {@link DEFAULT_MODEL}. */
  model: string;
  variant: string;
  persona: string;
  /** A channel the new seat subscribes to, or {@link NO_CHANNEL}. */
  channel: string;
  /** A manager instance id, or undefined while none is chosen: the thread then starts no agent. */
  machine?: string;
}

export interface Offer {
  readonly catalogs: readonly AgentCatalog[];
  readonly personas: readonly PersonaRow[];
  readonly channels: readonly ChannelRow[];
  readonly managers: readonly ManagerChoice[];
  readonly defaultAgent?: string;
  /** The thread opened without the launch lists: it drives the agent it loaded, offers only that
   *  agent's model, and cannot start another. */
  readonly seatOnly?: boolean;
}

/** Split a model choice into its application and model, as written. A model {@link DEFAULT_MODEL}
 *  may be the application's default or a catalog model of that id; only the catalog tells
 *  ({@link spawnModel}). */
export function parseModel(value: string): { agent: string; model: string } {
  const slash = value.indexOf("/");
  if (slash <= 0 || slash === value.length - 1) throw new Error(`model "${value}" is not <agent>/<model>`);
  return { agent: value.slice(0, slash), model: value.slice(slash + 1) };
}

/** The model a spawn names for a model choice: the chosen model, or none for `<agent>/default` when
 *  the application's catalog lists no model of that id, which leaves the model to the application. */
export function spawnModel(offer: Offer, value: string): string | undefined {
  const { agent, model } = parseModel(value);
  const listed = offer.catalogs.find((c) => c.agent === agent)?.models.some((m) => m.id === model) === true;
  return model === DEFAULT_MODEL && !listed ? undefined : model;
}

/** A thread can drive a running seat of the application: it is available and has an event plane. */
const drivable = (c: AgentCatalog): boolean => c.available && c.eventPlane;

/** A session can run the application: drivable, and with models read. */
const runnable = (c: AgentCatalog): boolean => drivable(c) && c.modelsUnread === undefined;

/** The applications a session can run. */
export function usable(catalogs: readonly AgentCatalog[]): AgentCatalog[] {
  return catalogs.filter(runnable);
}

/** Why a thread cannot drive a running seat of `agent`, or undefined when it can. Driving a seat
 *  launches nothing, so a failed read of the application's models does not matter. */
export function seatRefusal(catalogs: readonly AgentCatalog[], agent: string): string | undefined {
  const catalog = catalogs.find((c) => c.agent === agent);
  if (!catalog) return `the manager offers no application named "${agent}"`;
  if (!catalog.available) return `${agent} is not available on the manager's host${catalog.reason ? `: ${catalog.reason}` : ""}`;
  if (!catalog.eventPlane) return `${agent} publishes no event plane, so its turns cannot be shown here`;
  return undefined;
}

/** Why `agent` cannot run a session, or undefined when it can. */
export function refusal(catalogs: readonly AgentCatalog[], agent: string): string | undefined {
  const unread = catalogs.find((c) => c.agent === agent)?.modelsUnread;
  return seatRefusal(catalogs, agent) ?? (unread === undefined ? undefined : `the manager could not read ${agent}'s models: ${unread}`);
}

/** The manager a new session starts on: this machine's live one. Another computer's is never the
 *  default, since it cannot use this machine's folder; with none here, a thread starts only on a
 *  manager its Machine option names. */
export function defaultManager(managers: readonly ManagerChoice[]): ManagerChoice | undefined {
  return managers.find((m) => m.local && m.live);
}

/** Why a thread with no manager chosen starts no agent. It never leaves the spawn unpinned, which
 *  would let the space's exchange pick any manager. `unreadable` is why this machine's identity could
 *  not be read, when it could not. */
export function noMachine(space: string, unreadable?: string): string {
  if (unreadable !== undefined) return machineUnknown(unreadable, "", "choose a machine in the Machine option");
  return `No manager of yours runs on this machine. Start one with \`cotal manager start --space ${space}\`, or choose another computer in the Machine option.`;
}

/** Why a new thread starts no manager when this machine's identity could not be read and no manager is
 *  listed. One started here would name no machine either, so it would never read as this machine's
 *  and every thread would start another. */
export function noManagerKnownHere(space: string, unreadable: string): string {
  return machineUnknown(unreadable, " and starts none", `start a manager with \`cotal manager start --space ${space}\` and choose it in the Machine option`);
}

/** That this machine's identity could not be read, so no manager is known to run here, and what to do:
 *  make it readable, where Cotal knows how, or `instead`. */
function machineUnknown(unreadable: string, starts: string, instead: string): string {
  const head = `This machine's identity could not be read (${unreadable}), so Cotal cannot tell which manager runs here${starts}.`;
  if (process.platform === "linux") return `${head} Create /etc/machine-id with \`systemd-machine-id-setup\` and open a new thread, or ${instead}.`;
  return `${head} ${instead.charAt(0).toUpperCase()}${instead.slice(1)}.`;
}

/** The selection a new session starts with. */
export function initialSelection(offer: Offer): Selection {
  const apps = usable(offer.catalogs);
  const agent = apps.find((c) => c.agent === offer.defaultAgent) ?? apps[0];
  if (!agent) {
    const reasons = offer.catalogs.map((c) => `${c.agent}: ${refusal(offer.catalogs, c.agent)}`);
    throw new Error(`no application can run a session${reasons.length ? ` (${reasons.join("; ")})` : ": the manager offers none"}`);
  }
  return selectionOf(offer, `${agent.agent}/${DEFAULT_MODEL}`);
}

/** The selection of a thread that drives a running seat: the seat's model, on the seat's manager. It
 *  needs no application a session can run, since driving the seat launches nothing. */
export function seatSelection(offer: Offer, seat: { agent: string; model?: string; managerInstanceId?: string }): Selection {
  return selectionOf(offer, `${seat.agent}/${seat.model ?? DEFAULT_MODEL}`, seat.managerInstanceId);
}

/** A selection of `model` with every other option at its default, on `machine` or else this
 *  machine's live manager. */
function selectionOf(offer: Offer, model: string, machine = defaultManager(offer.managers)?.instanceId): Selection {
  return { model, variant: DEFAULT_VARIANT, persona: DEFAULT_PERSONA, channel: NO_CHANNEL, ...(machine ? { machine } : {}) };
}

/** The variants of one `<agent>/<model>` choice, as its catalog entry lists them: for an
 *  application's default, the entry whose id is `default`. None for a custom id. */
function variantsOfModel(offer: Offer, value: string): readonly string[] {
  const { agent, model } = parseModel(value);
  return offer.catalogs.find((c) => c.agent === agent)?.models.find((m) => m.id === model)?.variants ?? [];
}

function variantsOf(offer: Offer, selection: Selection): readonly string[] {
  return variantsOfModel(offer, selection.model);
}

/** A variant list a select can hold. */
const offerable = (variants: readonly string[]): boolean => variants.length > 0 && variants.length < MAX_CHOICES;

/** A selection made against one manager, carried to another manager's offer. A choice the new
 *  manager does not offer returns to its default. Throws when the new manager offers no application. */
export function reconcile(offer: Offer, selection: Selection): Selection {
  const { agent } = parseModel(selection.model);
  const next = refusal(offer.catalogs, agent) ? { ...selection, model: initialSelection(offer).model } : selection;
  return {
    ...next,
    variant: next.variant === DEFAULT_VARIANT || variantsOf(offer, next).includes(next.variant) ? next.variant : DEFAULT_VARIANT,
    persona: next.persona === DEFAULT_PERSONA || offer.personas.some((p) => p.name === next.persona) ? next.persona : DEFAULT_PERSONA,
  };
}

/** Apply one `session/set_config_option` to a selection. Throws on a value the offer does not hold. */
export function applyOption(offer: Offer, selection: Selection, configId: string, value: string): Selection {
  switch (configId) {
    case "model": {
      const { agent } = parseModel(value);
      const why = refusal(offer.catalogs, agent);
      if (why) throw new Error(why);
      const next = { ...selection, model: value };
      // A variant belongs to one model; it does not carry to another.
      return variantsOf(offer, next).includes(selection.variant) ? next : { ...next, variant: DEFAULT_VARIANT };
    }
    case "agent": {
      const why = refusal(offer.catalogs, value);
      if (why) throw new Error(why);
      return parseModel(selection.model).agent === value ? selection : { ...selection, model: `${value}/${DEFAULT_MODEL}`, variant: DEFAULT_VARIANT };
    }
    case REASONING:
      if (value !== DEFAULT_VARIANT && !variantsOf(offer, selection).includes(value))
        throw new Error(`the selected model has no variant "${value}"`);
      return { ...selection, variant: value };
    case "persona":
      if (value !== DEFAULT_PERSONA && !offer.personas.some((p) => p.name === value)) throw new Error(`the manager's catalog has no persona "${value}"`);
      return { ...selection, persona: value };
    case "channel":
      if (value !== NO_CHANNEL && !offer.channels.some((c) => c.channel === value)) throw new Error(`the space has no channel "${value}"`);
      return { ...selection, channel: value };
    case "machine":
      if (value === NO_MACHINE && selection.machine === undefined) return selection;
      if (!offer.managers.some((m) => m.instanceId === value)) throw new Error(`no manager "${value}" is live`);
      return { ...selection, machine: value };
    default:
      throw new Error(`unknown config option "${configId}"`);
  }
}

/** Whether a list holds more choices than a client select shows. */
export const cutShort = (list: readonly unknown[]): boolean => list.length >= MAX_CHOICES;

/** The personas the persona select names: the whole catalog when it fits, else the caller's own. A
 *  manager's list carries nothing else that marks a persona as one the caller uses, so `/persona`
 *  reaches the rest. */
function personaChoices(offer: Offer): string[] {
  const named = offer.personas.filter((p) => p.name !== DEFAULT_PERSONA);
  return (cutShort(offer.personas) ? named.filter((p) => p.own).slice(0, SHORT_CHOICES) : named).map((p) => p.name);
}

/** The channels the channel select names: every channel when they fit, else the ones the space
 *  describes and then the rest, each busiest first. `/join` reaches the others. */
function channelChoices(offer: Offer): string[] {
  if (!cutShort(offer.channels)) return offer.channels.map((c) => c.channel);
  const ranked = [...offer.channels].sort((a, b) => Number(b.description !== undefined) - Number(a.description !== undefined) || b.messages - a.messages);
  return ranked.slice(0, SHORT_CHOICES).map((c) => c.channel);
}

/** A select's named choices with the current value among them, which a short select may not list. */
const withCurrent = (choices: string[], current: string, unset: string): string[] =>
  current === unset || choices.includes(current) ? choices : [current, ...choices];

/** The applications the selects list: those a session can run, and the one whose seat the thread
 *  drives, which is listed even when the manager could not read its models. */
function listed(offer: Offer, selection: Selection): AgentCatalog[] {
  const { agent } = parseModel(selection.model);
  return offer.catalogs.filter((c) => runnable(c) || (c.agent === agent && drivable(c)));
}

/** The model select's choices, grouped by application. */
function modelGroups(offer: Offer, selection: Selection): { group: string; name: string; options: { value: string; name: string }[] }[] {
  return listed(offer, selection).map((c) => {
    // A model whose id is the default's is the default choice, since both have the value `<agent>/default`.
    const own = c.models.find((m) => m.id === DEFAULT_MODEL);
    const named = c.models.filter((m) => m !== own);
    // A seat-only thread offers the model its agent runs, and the default only when it names none.
    // A thread on a seat of an application whose models went unread offers only the seat's model.
    const choices = c.modelsUnread !== undefined ? [] : [
      ...(offer.seatOnly && named.length > 0 ? [] : [{ value: `${c.agent}/${DEFAULT_MODEL}`, name: `${c.agent}: ${own?.name ?? DEFAULT_MODEL}` }]),
      ...named.map((m) => ({ value: `${c.agent}/${m.id}`, name: `${c.agent}: ${m.name ?? m.id}` })),
    ];
    // The current value is always a choice, a custom id included.
    if (parseModel(selection.model).agent === c.agent && !choices.some((o) => o.value === selection.model))
      choices.push({ value: selection.model, name: `${c.agent}: ${selection.model.slice(c.agent.length + 1)}` });
    return { group: c.agent, name: c.agent, options: choices };
  });
}

/** One model of the session's model state. */
export interface ModelInfo {
  modelId: string;
  name: string;
  _meta: Record<string, unknown>;
}

/** The session's model state: every model the select offers, each with its reasoning variants. */
export interface ModelState {
  currentModelId: string;
  availableModels: ModelInfo[];
}

/** The model state for a selection: the select's choices, each with the effort choices the reasoning
 *  select would hold for it as `_meta.reasoningEfforts`, or `supportsReasoningEffort: false`. */
export function modelState(offer: Offer, selection: Selection): ModelState {
  const availableModels = modelGroups(offer, selection).flatMap((g) => g.options).map(({ value, name }) => {
    const variants = variantsOfModel(offer, value);
    const _meta = offerable(variants)
      ? {
        reasoningEfforts: [{ value: DEFAULT_VARIANT, label: "Model default" }, ...variants.map((v) => ({ value: v, label: v }))],
        reasoningEffort: value === selection.model ? selection.variant : DEFAULT_VARIANT,
      }
      : { supportsReasoningEffort: false };
    return { modelId: value, name, _meta };
  });
  return { currentModelId: selection.model, availableModels };
}

/** The full option set for a selection. Every reply that changes an option carries all of them. */
export function configOptions(offer: Offer, selection: Selection): SessionConfigOption[] {
  const apps = listed(offer, selection);
  const options: SessionConfigOption[] = [{
    id: "model",
    name: "Model",
    category: "model",
    type: "select",
    currentValue: selection.model,
    options: modelGroups(offer, selection),
  }];
  if (!offer.seatOnly && apps.length > 1 && apps.length < MAX_CHOICES)
    options.push({
      id: "agent",
      name: "Harness",
      description: "The application the new agent runs. Applies at spawn.",
      type: "select",
      currentValue: parseModel(selection.model).agent,
      options: apps.map((c) => ({ value: c.agent, name: c.agent })),
    });
  const variants = variantsOf(offer, selection);
  // Offered while any model has variants, so a model without them shows only the model default.
  const someVariants = usable(offer.catalogs).some((c) => c.models.some((m) => offerable(m.variants)));
  if (someVariants && variants.length < MAX_CHOICES)
    options.push({
      id: REASONING,
      name: "Reasoning",
      category: "thought_level",
      type: "select",
      currentValue: selection.variant,
      options: [{ value: DEFAULT_VARIANT, name: "Model default" }, ...withCurrent([...variants], selection.variant, DEFAULT_VARIANT).map((v) => ({ value: v, name: v }))],
    });
  if (offer.personas.length)
    options.push({
      id: "persona",
      name: "Persona",
      type: "select",
      currentValue: selection.persona,
      options: [{ value: DEFAULT_PERSONA, name: "Default persona" }, ...withCurrent(personaChoices(offer), selection.persona, DEFAULT_PERSONA).map((p) => ({ value: p, name: p }))],
    });
  if (offer.channels.length)
    options.push({
      id: "channel",
      name: "Channel",
      description: "A channel the new agent joins. Applies at spawn.",
      type: "select",
      currentValue: selection.channel,
      options: [{ value: NO_CHANNEL, name: "No channel" }, ...withCurrent(channelChoices(offer), selection.channel, NO_CHANNEL).map((c) => ({ value: c, name: `#${c}` }))],
    });
  // With none of this machine's, the list is the only way to start an agent, so even one is offered.
  const managers = offer.managers.length;
  if (managers > 0 && managers <= MAX_CHOICES && (managers > 1 || !defaultManager(offer.managers)))
    options.push({
      id: "machine",
      name: "Machine",
      type: "select",
      currentValue: selection.machine ?? NO_MACHINE,
      options: [
        ...(selection.machine === undefined ? [{ value: NO_MACHINE, name: "No machine chosen" }] : []),
        ...offer.managers.map((m) => ({ value: m.instanceId, name: m.local ? "This machine" : m.host ?? m.instanceId })),
      ],
    });
  return options;
}
