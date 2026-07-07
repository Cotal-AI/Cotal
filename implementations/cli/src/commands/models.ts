import { CONTROL_PRIVILEGED, registry, type CompletionResult, type Connector, type ConnectorModelCatalog, type FlagSpec, type FlagValues, type ModelInfo, type ParsedArgs } from "@cotal-ai/core";
import { loadMeshes, targetFlags } from "@cotal-ai/workspace";
import { c } from "../ui.js";
import { askManager, failIfNotOk, resolveControlTarget } from "../lib/control.js";
import { completingFlagValue } from "../lib/completion.js";

export const modelsFlags = [
  ...targetFlags,
  { name: "agent", type: "string", value: "<connector>", description: "connector to inspect (default: all registered connectors)" },
  { name: "refresh", type: "boolean", description: "ask the connector to refresh its provider cache" },
] as const satisfies readonly FlagSpec[];

export function modelsComplete(argv: string[]): CompletionResult {
  const flag = completingFlagValue(argv, modelsFlags);
  if (flag?.name === "space") return { items: loadMeshes().map((m) => ({ value: m.space })), directive: "nofiles" };
  if (flag?.name === "agent") return { items: registry.all<Connector>("connector").map((c) => ({ value: c.name })), directive: "nofiles" };
  if (flag?.name === "creds") return { items: [], directive: "default" };
  return { items: [], directive: "nofiles" };
}

export async function models(args: ParsedArgs): Promise<void> {
  const v = args.values as FlagValues<typeof modelsFlags>;
  const t = await resolveControlTarget(v, "control-caller-privileged");
  const reply = await askManager(t.space, t.server, "models", { agent: v.agent, refresh: v.refresh === true }, t.creds, CONTROL_PRIVILEGED);
  failIfNotOk(reply);
  const rows = Array.isArray(reply.data) ? reply.data as ConnectorModelCatalog[] : [reply.data as ConnectorModelCatalog];
  for (const row of rows) renderCatalog(row);
}

function renderCatalog(row: ConnectorModelCatalog): void {
  if (!row.supported) {
    console.log(`${c.bold(row.agent)}  ${c.dim("no model catalog exposed")}`);
    return;
  }
  if (row.error) {
    console.log(`${c.bold(row.agent)}  ${c.red(row.error)}`);
    return;
  }
  console.log(c.bold(row.agent) + (row.source ? c.dim(`  ${row.source}`) : ""));
  if (!row.models.length) {
    console.log(c.dim("  (no models reported)"));
    return;
  }
  const pad = Math.max(...row.models.map((m) => m.id.length));
  for (const model of row.models) renderModel(model, pad);
}

function renderModel(model: ModelInfo, pad: number): void {
  const name = model.name && model.name !== model.id ? c.dim(`  ${model.name}`) : "";
  console.log(`  ${model.id.padEnd(pad)}${name}`);
  if (model.variants?.length) console.log(c.dim(`  ${"".padEnd(pad)}  variants: ${model.variants.map((v) => v.name).join(", ")}`));
}
