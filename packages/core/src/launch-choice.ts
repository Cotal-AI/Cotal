import { rejectionText } from "./cleanup.js";
import type { Connector, LaunchModes, ModelCatalog, ModelCatalogOpts, ModelInfo } from "./connector.js";

/** What a launch chose besides the model, checked against the connector's catalog. */
export interface LaunchChoice {
  model?: string;
  variant?: string;
  modes?: LaunchModes;
}

const quoted = (values: readonly string[]): string => values.map((v) => JSON.stringify(v)).join(", ");

/** Read the connector's catalog and refuse one that contradicts itself: two default models, a default
 *  variant that is not one of the model's variants, or a mode whose kind, options or default do not
 *  fit or that is unavailable without a reason. Every catalog a launch is checked against is read
 *  through this, so a connector's mistake surfaces as an unreadable catalog rather than as a default
 *  no launch can choose. */
export async function readModelCatalog(connector: Pick<Connector, "name" | "listModels">, opts: ModelCatalogOpts): Promise<ModelCatalog> {
  if (!connector.listModels) throw new Error(`${connector.name} connector lists no model catalog`);
  const catalog = await connector.listModels(opts);
  checkModelCatalog(catalog);
  return catalog;
}

/** Why a launch on `connector` cannot run the variant or modes it chose: the connector lists no
 *  catalog, `read` failed, or the catalog does not list them for the model. Undefined when it chose
 *  neither, or the catalog lists both. `read` supplies the catalog, kept or read now. */
export async function catalogChoiceRefusal(connector: Pick<Connector, "name" | "listModels">, choice: LaunchChoice, read: () => Promise<ModelCatalog>): Promise<string | undefined> {
  if (choice.variant === undefined && choice.modes === undefined) return undefined;
  if (!connector.listModels) return `${connector.name} connector lists no model catalog, so a launch cannot choose a variant or modes on it`;
  let catalog: ModelCatalog;
  try {
    catalog = await read();
  } catch (e) {
    return `${connector.name} model catalog could not be read, so the launch's choice cannot be checked: ${rejectionText(e)}`;
  }
  return launchChoiceRefusal(connector.name, catalog, choice);
}

function checkModelCatalog(catalog: ModelCatalog): void {
  const defaults = catalog.models.filter((m) => m.isDefault === true).map((m) => m.id);
  if (defaults.length > 1) throw new Error(`the catalog marks ${defaults.length} default models (${quoted(defaults)}); at most one model is the harness default`);
  for (const model of catalog.models) {
    const at = `model ${JSON.stringify(model.id)}`;
    if (model.defaultVariant !== undefined && !model.variants?.some((v) => v.name === model.defaultVariant))
      throw new Error(`${at} names default variant ${JSON.stringify(model.defaultVariant)}, which is not one of its variants`);
    const ids = new Set<string>();
    for (const mode of model.modes ?? []) {
      // A connector may be plain JavaScript, so the kind and default are read as the values they are.
      const { id, kind, default: fallback, unavailable } = mode as { id: string; kind: unknown; default: unknown; unavailable: unknown };
      const named = `${at} mode ${JSON.stringify(id)}`;
      if (ids.has(id)) throw new Error(`${at} lists mode ${JSON.stringify(id)} twice`);
      ids.add(id);
      if (unavailable !== undefined && (typeof unavailable !== "string" || !unavailable.trim()))
        throw new Error(`${named} is marked unavailable with no reason`);
      if (kind === "toggle" && typeof fallback !== "boolean") throw new Error(`${named} is a toggle whose default is not true or false`);
      if (kind === "choice") {
        const options = (mode as { options: { id: string }[] }).options.map((o) => o.id);
        if (!options.length || new Set(options).size !== options.length) throw new Error(`${named} is a choice without distinct options`);
        if (!options.includes(fallback as string)) throw new Error(`${named} defaults to ${JSON.stringify(fallback)}, which is not one of its options`);
      }
      if (kind !== "toggle" && kind !== "choice") throw new Error(`${named} has kind ${JSON.stringify(kind)}; a mode is a toggle or a choice`);
    }
  }
}

/** With no model named, the choice is checked against the row the catalog marks as the default. */
function launchChoiceRefusal(agent: string, catalog: ModelCatalog, choice: LaunchChoice): string | undefined {
  const field = [choice.variant !== undefined && "variant", choice.modes !== undefined && "modes"].filter(Boolean).join(" and ");
  if (catalog.unavailable !== undefined)
    return `${agent} has no model catalog on this host (${catalog.unavailable}), so a launch's ${field} cannot be checked (${field})`;
  const model = choice.model === undefined ? catalog.models.find((m) => m.isDefault === true) : catalog.models.find((m) => m.id === choice.model);
  if (!model)
    return choice.model === undefined
      ? `${agent}'s catalog marks no default model, so name the model to choose its ${field} (model)`
      : `${agent}'s catalog does not list model ${JSON.stringify(choice.model)}, so its ${field} cannot be checked; \`cotal models -H ${agent}\` lists the models (model)`;
  return variantRefusal(agent, model, choice.variant) ?? modesRefusal(agent, model, choice.modes);
}

function variantRefusal(agent: string, model: ModelInfo, variant: string | undefined): string | undefined {
  if (variant === undefined || model.variants?.some((v) => v.name === variant)) return undefined;
  const listed = model.variants?.map((v) => v.name) ?? [];
  return `${agent} lists ${listed.length ? `variants ${quoted(listed)}` : "no variants"} for model ${JSON.stringify(model.id)}, not ${JSON.stringify(variant)} (variant)`;
}

function modesRefusal(agent: string, model: ModelInfo, modes: LaunchModes | undefined): string | undefined {
  for (const [id, value] of Object.entries(modes ?? {})) {
    const mode = model.modes?.find((m) => m.id === id);
    if (!mode) {
      const listed = model.modes?.map((m) => m.id) ?? [];
      return `${agent} lists ${listed.length ? `modes ${quoted(listed)}` : "no modes"} for model ${JSON.stringify(model.id)}, not ${JSON.stringify(id)} (modes)`;
    }
    if (mode.kind === "toggle" && typeof value !== "boolean")
      return `mode ${JSON.stringify(id)} of model ${JSON.stringify(model.id)} is a toggle, so it takes true or false, not ${JSON.stringify(value)} (modes)`;
    if (mode.kind === "choice" && !mode.options.some((o) => o.id === value))
      return `mode ${JSON.stringify(id)} of model ${JSON.stringify(model.id)} takes one of ${quoted(mode.options.map((o) => o.id))}, not ${JSON.stringify(value)} (modes)`;
    // An unavailable mode can still be set off: a toggle to false, a choice to its default.
    const turnsOn = mode.kind === "toggle" ? value === true : value !== mode.default;
    if (mode.unavailable !== undefined && turnsOn)
      return `mode ${JSON.stringify(id)} of model ${JSON.stringify(model.id)} is unavailable: ${mode.unavailable} (modes)`;
  }
  return undefined;
}
