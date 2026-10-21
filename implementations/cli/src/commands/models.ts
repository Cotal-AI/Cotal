import { type CompletionResult, type ConnectorModelCatalog, type FlagSpec, type FlagValues, type ModelInfo, type ParsedArgs } from "@cotal-ai/core";
import { jsonFlag, loadMeshes, plainFlag, presentationOf, targetFlags, writeResult, type Block, type Report, type Section } from "@cotal-ai/workspace";
import { extensionNames } from "../ext-loader.js";
import { askManager, onFlag, onInstance, readFailure, resolveControlTarget } from "../lib/control.js";
import { completingFlagValue } from "../lib/completion.js";

export const modelsFlags = [
  ...targetFlags,
  { name: "harness", short: "H", type: "string", value: "<connector>", description: "application to inspect (default: all registered applications)" },
  { name: "refresh", type: "boolean", description: "ask the connector to refresh its provider cache" },
  onFlag,
  jsonFlag,
  plainFlag,
] as const satisfies readonly FlagSpec[];

export function modelsComplete(argv: string[]): CompletionResult {
  const flag = completingFlagValue(argv, modelsFlags);
  if (flag?.name === "space") return { items: loadMeshes().map((m) => ({ value: m.space })), directive: "nofiles" };
  if (flag?.name === "harness") return { items: extensionNames("connector").map((name) => ({ value: name })), directive: "nofiles" };
  if (flag?.name === "creds") return { items: [], directive: "default" };
  return { items: [], directive: "nofiles" };
}

/** What `cotal models` read: each connector's catalog exactly as the manager returned it. A
 *  connector that exposes no catalog says so (`supported: false`, with the reason in `unavailable`
 *  when it implements a catalog this install cannot list); one whose catalog could not be
 *  read, or that the manager could not load, carries its `error` and makes the read partial. */
export interface ModelsResult {
  readonly space: string;
  readonly requestedManagerInstanceId: string | null;
  readonly answeringManagerInstanceId: string | null;
  readonly answeringManagerEpoch: number | null;
  readonly items: readonly ConnectorModelCatalog[];
}

export async function models(args: ParsedArgs): Promise<void> {
  const v = args.values as FlagValues<typeof modelsFlags>;
  const presentation = presentationOf(v);
  const on = onInstance(v.on, "cotal models");
  const t = await resolveControlTarget(v, "control-caller-privileged", on, { onRefusal: "throw" });
  const target = { space: t.space, harness: v.harness ?? null, requestedInstanceId: on ?? null };
  const reply = await askManager(t.space, t.server, "models", { agent: v.harness, refresh: v.refresh === true }, t.auth, "owner", undefined, on === undefined ? {} : { instanceId: on });
  if (!reply.ok) throw readFailure(reply, { ...target, managerInstanceId: reply.managerInstanceId ?? null });
  const items = Array.isArray(reply.data) ? reply.data as ConnectorModelCatalog[] : [reply.data as ConnectorModelCatalog];
  const failed = items.filter((row) => row.error);
  writeResult(
    presentation,
    {
      command: "models",
      target,
      result: { space: t.space, requestedManagerInstanceId: on ?? null, answeringManagerInstanceId: reply.managerInstanceId ?? null, answeringManagerEpoch: reply.managerEpoch ?? null, items },
      completeness: failed.length ? "partial" : "complete",
      warnings: failed.map((row) => ({ code: "MODEL_CATALOG_UNREADABLE", target: { space: t.space, agent: row.agent }, message: `${row.agent}: ${row.error}` })),
      ...(failed.length
        ? { partial: { message: `${failed.length} of ${items.length} model catalogs could not be read`, remedy: "inspect the named application's warning and correct its stated cause before retrying" } }
        : {}),
    },
    modelsView,
  );
}

function modelsView(result: ModelsResult): Report {
  const instance = result.requestedManagerInstanceId ?? result.answeringManagerInstanceId;
  const selected = result.space && instance && [result.space, instance].every((value) => /^[A-Za-z0-9_-]+$/.test(value))
    ? ` --space ${result.space} --on ${instance}`
    : " --space <space> --on <manager-instance>";
  return { sections: [
    { title: "Model catalogs", blocks: [{ kind: "fields", rows: [["Space", result.space], ["Requested manager", result.requestedManagerInstanceId ?? "selected by native authority"], ["Answering manager", result.answeringManagerInstanceId ?? "not reported"], ["Manager epoch", result.answeringManagerEpoch === null ? "not reported" : String(result.answeringManagerEpoch)]] }, { kind: "lines", lines: [{ text: "The manager returned these catalogs. A listed model or variant is not proof the provider accepted a launch.", tone: "hint" }] }] },
    ...(result.items.length ? result.items.map(catalogSection) : [{ title: "Models", blocks: [{ kind: "lines" as const, lines: ["No model catalogs were returned."] }] }]),
    { title: "Next", blocks: [{ kind: "commands", items: [
      { command: `cotal models -H <application> --refresh${selected}`, description: "Refresh one application's catalog on the selected manager" },
      { command: "cotal cfg", description: "See your launch defaults" },
    ] }] },
  ] };
}

function catalogSection(row: ConnectorModelCatalog): Section {
  const blocks: Block[] = [];
  if (row.source) blocks.push({ kind: "lines", lines: [{ text: row.source, tone: "hint" }] });
  if (row.error) blocks.push({ kind: "lines", lines: [{ text: "Catalog unreadable; the warning below names the cause.", tone: "waiting" }] });
  else if (!row.supported) blocks.push({ kind: "lines", lines: [{ text: row.unavailable ?? "no model catalog exposed", tone: "hint" }] });
  else if (!row.models.length) blocks.push({ kind: "lines", lines: [{ text: "(no models reported)", tone: "hint" }] });
  else {
    const named = row.models.some((m) => m.name && m.name !== m.id);
    const variants = row.models.some((m) => m.variants?.length);
    blocks.push({
      kind: "table",
      columns: [
        { key: "id", label: "Model" },
        ...(named ? [{ key: "name", label: "Name" }] : []),
        ...(variants ? [{ key: "variants", label: "Variants" }] : []),
      ],
      rows: row.models.map((m) => ({
        id: m.id,
        name: m.name && m.name !== m.id ? { text: m.name, tone: "hint" } : "",
        variants: modelVariants(m) ?? "",
      })),
    });
  }
  return { title: row.agent, blocks };
}

const JCODE_DECLARED_WARNING = "declared by Jcode config; provider acceptance is validated only at launch";

/** A model's variants, named where an operator reads them. Core keeps `options` opaque; the CLI
 *  consumes Jcode's three markers together so a partial or third-party lookalike cannot earn the
 *  non-authoritative label accidentally. */
export function modelVariants(model: ModelInfo): string | undefined {
  if (!model.variants?.length) return undefined;
  const declared = model.variants.every((variant) =>
    variant.options?.provenance === "declared-config" &&
    variant.options.authoritative === false &&
    variant.options.warning === JCODE_DECLARED_WARNING);
  const names = model.variants.map((variant) => variant.name).join(", ");
  return declared ? `${names} (declared, not provider-verified)` : names;
}
