/**
 * A session's config options, built from what the managers offer.
 *
 * The model select lists `<agent>/<model>` grouped by agent, with a `<agent>/default` choice for
 * the application's own default. A client must be able to select the default again after a named
 * model ran, so it is a real choice rather than an absent value. Applications without an event
 * plane are not offered: the bridge reads a seat's turns from that plane and has nothing to show
 * without it. A model the catalog does not list is accepted as a custom id, as a client's own model
 * field sends it, and the manager validates it at launch.
 */
import type { SessionConfigOption } from "@agentclientprotocol/sdk";
import type { AgentCatalog, ManagerChoice } from "./mesh.js";

/** The value of a model choice that leaves the model to the application. */
export const DEFAULT_MODEL = "default";
/** The value of a variant choice that leaves the variant to the model. */
export const DEFAULT_VARIANT = "default";
/** The value of a persona choice that uses the manager's default persona. */
export const DEFAULT_PERSONA = "default";
/** The value of a channel choice that subscribes the new seat to no extra channel. */
export const NO_CHANNEL = "none";
/** A client caps a select at this many choices (T3 Code's limit). A list that does not fit is not
 *  offered rather than cut. */
export const MAX_CHOICES = 64;

export interface Selection {
  /** `<agent>/<model>`, where the model may be {@link DEFAULT_MODEL}. */
  model: string;
  variant: string;
  persona: string;
  /** A channel the new seat subscribes to, or {@link NO_CHANNEL}. */
  channel: string;
  /** A manager instance id, or undefined for the space's own choice. */
  machine?: string;
}

export interface Offer {
  readonly catalogs: readonly AgentCatalog[];
  readonly personas: readonly string[];
  readonly channels: readonly string[];
  readonly managers: readonly ManagerChoice[];
  readonly defaultAgent?: string;
  /** The thread opened without the launch lists: it drives the agent it loaded, offers only that
   *  agent's model, and cannot start another. */
  readonly seatOnly?: boolean;
}

/** Split a model choice into its application and model. */
export function parseModel(value: string): { agent: string; model?: string } {
  const slash = value.indexOf("/");
  if (slash <= 0 || slash === value.length - 1) throw new Error(`model "${value}" is not <agent>/<model>`);
  const agent = value.slice(0, slash);
  const model = value.slice(slash + 1);
  return { agent, ...(model === DEFAULT_MODEL ? {} : { model }) };
}

/** The applications a session can run: available and with an event plane. */
export function usable(catalogs: readonly AgentCatalog[]): AgentCatalog[] {
  return catalogs.filter((c) => c.available && c.eventPlane);
}

/** Why `agent` cannot run a session, or undefined when it can. */
export function refusal(catalogs: readonly AgentCatalog[], agent: string): string | undefined {
  const catalog = catalogs.find((c) => c.agent === agent);
  if (!catalog) return `the manager offers no application named "${agent}"`;
  if (!catalog.available) return `${agent} is not available on the manager's host${catalog.reason ? `: ${catalog.reason}` : ""}`;
  if (!catalog.eventPlane) return `${agent} publishes no event plane, so its turns cannot be shown here`;
  return undefined;
}

/** The manager a new session starts on: this machine's, else the first listed. Leaving it unpinned
 *  would let the space's exchange choose, and that refuses when several of a person's own managers
 *  are live. */
export function defaultManager(managers: readonly ManagerChoice[]): ManagerChoice | undefined {
  return managers.find((m) => m.local) ?? managers[0];
}

/** The selection a new session starts with. */
export function initialSelection(offer: Offer): Selection {
  const apps = usable(offer.catalogs);
  const agent = apps.find((c) => c.agent === offer.defaultAgent) ?? apps[0];
  if (!agent) {
    const reasons = offer.catalogs.map((c) => `${c.agent}: ${refusal(offer.catalogs, c.agent)}`);
    throw new Error(`no application can run a session${reasons.length ? ` (${reasons.join("; ")})` : ": the manager offers none"}`);
  }
  const machine = defaultManager(offer.managers);
  return { model: `${agent.agent}/${DEFAULT_MODEL}`, variant: DEFAULT_VARIANT, persona: DEFAULT_PERSONA, channel: NO_CHANNEL, ...(machine ? { machine: machine.instanceId } : {}) };
}

function variantsOf(offer: Offer, selection: Selection): readonly string[] {
  const { agent, model } = parseModel(selection.model);
  if (model === undefined) return [];
  return offer.catalogs.find((c) => c.agent === agent)?.models.find((m) => m.id === model)?.variants ?? [];
}

/** A selection made against one manager, carried to another manager's offer. A choice the new
 *  manager does not offer returns to its default. Throws when the new manager offers no application. */
export function reconcile(offer: Offer, selection: Selection): Selection {
  const { agent } = parseModel(selection.model);
  const next = refusal(offer.catalogs, agent) ? { ...selection, model: initialSelection(offer).model } : selection;
  return {
    ...next,
    variant: next.variant === DEFAULT_VARIANT || variantsOf(offer, next).includes(next.variant) ? next.variant : DEFAULT_VARIANT,
    persona: next.persona === DEFAULT_PERSONA || offer.personas.includes(next.persona) ? next.persona : DEFAULT_PERSONA,
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
    case "variant":
      if (value !== DEFAULT_VARIANT && !variantsOf(offer, selection).includes(value))
        throw new Error(`the selected model has no variant "${value}"`);
      return { ...selection, variant: value };
    case "persona":
      if (value !== DEFAULT_PERSONA && !offer.personas.includes(value)) throw new Error(`the manager's catalog has no persona "${value}"`);
      return { ...selection, persona: value };
    case "channel":
      if (value !== NO_CHANNEL && !offer.channels.includes(value)) throw new Error(`the space has no channel "${value}"`);
      return { ...selection, channel: value };
    case "machine":
      if (!offer.managers.some((m) => m.instanceId === value)) throw new Error(`no manager "${value}" is live`);
      return { ...selection, machine: value };
    default:
      throw new Error(`unknown config option "${configId}"`);
  }
}

/** The full option set for a selection. Every reply that changes an option carries all of them. */
export function configOptions(offer: Offer, selection: Selection): SessionConfigOption[] {
  const options: SessionConfigOption[] = [{
    id: "model",
    name: "Model",
    category: "model",
    type: "select",
    currentValue: selection.model,
    options: usable(offer.catalogs).map((c) => {
      // A seat-only thread offers the model its agent runs, and the default only when it names none.
      const choices = [
        ...(offer.seatOnly && c.models.length > 0 ? [] : [{ value: `${c.agent}/${DEFAULT_MODEL}`, name: `${c.agent} default` }]),
        ...c.models.map((m) => ({ value: `${c.agent}/${m.id}`, name: m.name ?? m.id })),
      ];
      // The current value is always a choice, a custom id included.
      if (parseModel(selection.model).agent === c.agent && !choices.some((o) => o.value === selection.model))
        choices.push({ value: selection.model, name: selection.model.slice(c.agent.length + 1) });
      return { group: c.agent, name: c.agent, options: choices };
    }),
  }];
  const variants = variantsOf(offer, selection);
  if (variants.length && variants.length < MAX_CHOICES)
    options.push({
      id: "variant",
      name: "Reasoning",
      category: "thought_level",
      type: "select",
      currentValue: selection.variant,
      options: [{ value: DEFAULT_VARIANT, name: "Model default" }, ...variants.map((v) => ({ value: v, name: v }))],
    });
  if (offer.personas.length && offer.personas.length < MAX_CHOICES)
    options.push({
      id: "persona",
      name: "Persona",
      type: "select",
      currentValue: selection.persona,
      options: [{ value: DEFAULT_PERSONA, name: "Default persona" }, ...offer.personas.filter((p) => p !== DEFAULT_PERSONA).map((p) => ({ value: p, name: p }))],
    });
  if (offer.channels.length && offer.channels.length < MAX_CHOICES)
    options.push({
      id: "channel",
      name: "Channel",
      description: "A channel the new agent joins. Applies at spawn.",
      type: "select",
      currentValue: selection.channel,
      options: [{ value: NO_CHANNEL, name: "No channel" }, ...offer.channels.map((c) => ({ value: c, name: `#${c}` }))],
    });
  if (offer.managers.length > 1 && offer.managers.length <= MAX_CHOICES)
    options.push({
      id: "machine",
      name: "Machine",
      type: "select",
      currentValue: selection.machine ?? defaultManager(offer.managers)!.instanceId,
      options: offer.managers.map((m) => ({ value: m.instanceId, name: `${m.host ?? m.instanceId}${m.local ? " (this machine)" : ""}` })),
    });
  return options;
}
