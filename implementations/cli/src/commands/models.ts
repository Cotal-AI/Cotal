import { type CompletionResult, type ConnectorModelCatalog, type FlagSpec, type FlagValues, type ModeInfo, type ModelInfo, type ParsedArgs } from "@cotal-ai/core";
import { brokerAddressForDisplay, CommandFailure, jsonFlag, plainFlag, presentationOf, targetFlags, writeResult, type Block, type Report, type Section, resolveControlTarget } from "@cotal-ai/workspace";
import { extensionNames } from "../ext-loader.js";
import { cliControl, onFlag, onRerun, refuseControlCreds } from "../lib/control.js";
import { managerPin } from "../lib/manager-choice.js";
import { completingFlagValue } from "../lib/completion.js";
import { askManager, readFailure, refuseUnregisteredManager, refuseWithoutLiveManager } from "@cotal-ai/workspace/control";

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
  if (flag?.name === "harness") return { items: extensionNames("connector").map((name) => ({ value: name })), directive: "nofiles" };
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
  /** The live managers an unpinned operator read did not ask, from the registry it read first.
   *  Null when no registry was read, as for a pinned or user-auth read. */
  readonly notAskedManagerInstanceIds: readonly string[] | null;
  readonly items: readonly ConnectorModelCatalog[];
}

export function validateModelsArguments(args: ParsedArgs): void {
  const values = args.values as FlagValues<typeof modelsFlags>;
  presentationOf(values);
  if (values.harness !== undefined && !values.harness.trim())
    throw new CommandFailure("refused", "USAGE_INVALID", "--harness cannot be empty", { remedy: "name an application with --harness <connector>, or omit it to list all applications" });
}

export async function models(args: ParsedArgs): Promise<void> {
  validateModelsArguments(args);
  const v = args.values as FlagValues<typeof modelsFlags>;
  const presentation = presentationOf(v);
  refuseControlCreds(v.creds, v.space);
  const on = await managerPin(v, onRerun("cotal models", v, v.harness === undefined ? [] : ["--harness", v.harness]));
  const t = await resolveControlTarget(v, "control-caller-privileged", on, { onRefusal: "throw" });
  const target = { space: t.space, harness: v.harness ?? null, requestedInstanceId: on ?? null };
  const live = on === undefined && t.auth.bearer === undefined ? await refuseWithoutLiveManager(t.space, t.server, t.auth, target, "list its model catalogs") : undefined;
  // A pin the registry does not list is refused at once, as spawn refuses it; only a registered manager is waited on.
  if (on !== undefined && t.auth.bearer === undefined) await refuseUnregisteredManager(t.space, t.server, t.auth, on);
  const reply = await askManager(cliControl, t.space, t.server, "models", { agent: v.harness, refresh: v.refresh === true }, t.auth, "owner", undefined, on === undefined ? {} : { instanceId: on });
  if (!reply.ok) throw readFailure(reply, { ...target, managerInstanceId: reply.managerInstanceId ?? null });
  const items = Array.isArray(reply.data) ? reply.data as ConnectorModelCatalog[] : [reply.data as ConnectorModelCatalog];
  const failed = items.filter((row) => row.error);
  // The class queue hands an unpinned read to one manager; every other live one was not asked.
  const notAsked = live && reply.managerInstanceId ? live.filter((id) => id !== reply.managerInstanceId) : null;
  writeResult(
    presentation,
    {
      command: "models",
      target,
      result: { space: t.space, requestedManagerInstanceId: on ?? null, answeringManagerInstanceId: reply.managerInstanceId ?? null, answeringManagerEpoch: reply.managerEpoch ?? null, notAskedManagerInstanceIds: notAsked, items },
      completeness: failed.length ? "partial" : "complete",
      warnings: failed.map((row) => ({ code: "MODEL_CATALOG_UNREADABLE", target: { space: t.space, agent: row.agent }, message: `${row.agent}: ${row.error}` })),
      ...(failed.length
        ? { partial: { message: `${failed.length} of ${items.length} model catalogs could not be read`, remedy: "inspect the named application's warning and correct its stated cause before retrying" } }
        : {}),
    },
    (result) => {
      const option = (flag: string, value: string) => value.startsWith("-") ? [`${flag}=${value}`] : [flag, value];
      const base = onRerun("cotal models", {}, [...option("--space", result.space), ...(v.harness === undefined ? [] : option("--harness", v.harness))]);
      const server = v.server === undefined ? undefined : t.server;
      const atBroker = (command: string) => server !== undefined && brokerAddressForDisplay(server) !== server
        ? `${command} --server <url>` : onRerun(command, { server });
      return modelsView(result, atBroker(v.refresh ? `${base} --refresh` : base), atBroker(`${base}${v.harness === undefined ? " -H <application>" : ""} --refresh`));
    },
  );
}

function modelsView(result: ModelsResult, read: string, refresh: string): Report {
  const instance = result.requestedManagerInstanceId ?? result.answeringManagerInstanceId;
  const token = (value: string) => /^[A-Za-z0-9_-]+$/.test(value);
  const selected = instance && token(instance) ? instance : "<manager-instance>";
  const notAsked = result.notAskedManagerInstanceIds ?? [];
  return { sections: [
    { title: "Model catalogs", blocks: [{ kind: "fields", rows: [["Space", result.space], ["Requested manager", result.requestedManagerInstanceId ?? "selected by native authority"], ["Answering manager", result.answeringManagerInstanceId ?? "not reported"], ["Manager epoch", result.answeringManagerEpoch === null ? "not reported" : String(result.answeringManagerEpoch)], ...(notAsked.length ? [["Not asked", notAsked.join(", ")] as [string, string]] : [])] }, { kind: "lines", lines: [
      { text: "The manager returned these catalogs. A listed model or variant is not proof the provider accepted a launch.", tone: "hint" },
      ...(notAsked.length ? [{ text: `This space has ${notAsked.length + 1} live managers, and only the answering one was asked.`, tone: "hint" } as const] : []),
    ] }] },
    // A manager lists a row for every application its install names, so an empty list means it has none.
    ...(result.items.length ? result.items.map(catalogSection) : [{ title: "Models", blocks: [{ kind: "lines" as const, lines: ["No model catalogs were returned: the answering manager has no agent application installed."] }] }]),
    { title: "Next", blocks: [{ kind: "commands", items: [
      ...(result.space && token(result.space) ? notAsked.filter(token).map((id) => ({ command: `${read} --on ${id}`, description: "Ask a manager this read did not ask" })) : []),
      { command: `${refresh} --on ${selected}`, description: "Refresh one application's catalog on the selected manager" },
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
    const named = row.models.some((m) => (m.name && m.name !== m.id) || m.isDefault);
    const variants = row.models.some((m) => m.variants?.length);
    const defaults = row.models.some((m) => m.defaultVariant !== undefined);
    const modes = row.models.some((m) => m.modes?.length);
    blocks.push({
      kind: "table",
      columns: [
        { key: "id", label: "Model" },
        ...(named ? [{ key: "name", label: "Name" }] : []),
        ...(variants ? [{ key: "variants", label: "Variants" }] : []),
        ...(defaults ? [{ key: "defaultVariant", label: "Default variant" }] : []),
        ...(modes ? [{ key: "modes", label: "Modes" }] : []),
      ],
      rows: row.models.map((m) => ({
        id: m.id,
        name: modelName(m),
        variants: modelVariants(m) ?? "",
        defaultVariant: m.defaultVariant ?? "",
        modes: (m.modes ?? []).map(modeChoices).join(", "),
      })),
    });
  }
  return { title: row.agent, blocks };
}

/** A model's name, marked when it is the harness default. */
function modelName(m: ModelInfo): string | { text: string; tone: "hint" } {
  const text = [m.name && m.name !== m.id ? m.name : "", m.isDefault ? "(default)" : ""].filter(Boolean).join(" ");
  return text ? { text, tone: "hint" } : "";
}

/** A mode as `--mode` takes it, with its default: `fast=true|false (default false)`, or the reason
 *  the account cannot run it: `fast (unavailable: <reason>)`. */
function modeChoices(mode: ModeInfo): string {
  if (mode.unavailable !== undefined) return `${mode.id} (unavailable: ${mode.unavailable})`;
  const values = mode.kind === "toggle" ? ["true", "false"] : mode.options.map((o) => o.id);
  return `${mode.id}=${values.join("|")} (default ${String(mode.default)})`;
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
