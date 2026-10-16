import { type CompletionResult, type ConnectorModelCatalog, type FlagSpec, type FlagValues, type ModelInfo, type ParsedArgs } from "@cotal-ai/core";
import { jsonFlag, loadMeshes, plainFlag, presentationOf, targetFlags, writeResult, type Block, type Report, type Section } from "@cotal-ai/workspace";
import { extensionNames } from "../ext-loader.js";
import { askManager, readFailure, resolveControlTarget } from "../lib/control.js";
import { completingFlagValue } from "../lib/completion.js";

export const modelsFlags = [
  ...targetFlags,
  { name: "agent", type: "string", value: "<connector>", description: "connector to inspect (default: all registered connectors)" },
  { name: "refresh", type: "boolean", description: "ask the connector to refresh its provider cache" },
  jsonFlag,
  plainFlag,
] as const satisfies readonly FlagSpec[];

export function modelsComplete(argv: string[]): CompletionResult {
  const flag = completingFlagValue(argv, modelsFlags);
  if (flag?.name === "space") return { items: loadMeshes().map((m) => ({ value: m.space })), directive: "nofiles" };
  if (flag?.name === "agent") return { items: extensionNames("connector").map((name) => ({ value: name })), directive: "nofiles" };
  if (flag?.name === "creds") return { items: [], directive: "default" };
  return { items: [], directive: "nofiles" };
}

/** What `cotal models` read: each connector's catalog exactly as the manager returned it. A
 *  connector that exposes no catalog says so (`supported: false`); one whose catalog could not be
 *  read carries its `error` and makes the read partial. */
export interface ModelsResult {
  readonly items: readonly ConnectorModelCatalog[];
}

export async function models(args: ParsedArgs): Promise<void> {
  const v = args.values as FlagValues<typeof modelsFlags>;
  const presentation = presentationOf(v);
  const t = await resolveControlTarget(v, "control-caller-privileged", undefined, { onRefusal: "throw" });
  const target = { space: t.space, agent: v.agent ?? null };
  const reply = await askManager(t.space, t.server, "models", { agent: v.agent, refresh: v.refresh === true }, t.auth, "owner");
  if (!reply.ok) throw readFailure(reply, target);
  const items = Array.isArray(reply.data) ? reply.data as ConnectorModelCatalog[] : [reply.data as ConnectorModelCatalog];
  const failed = items.filter((row) => row.supported && row.error);
  writeResult(
    presentation,
    {
      command: "models",
      target,
      result: { items },
      completeness: failed.length ? "partial" : "complete",
      warnings: failed.map((row) => ({ code: "MODEL_CATALOG_UNREADABLE", target: { space: t.space, agent: row.agent }, message: `${row.agent}: ${row.error}` })),
      ...(failed.length
        ? { partial: { message: `${failed.length} of ${items.length} model catalogs could not be read`, remedy: "retry, or `cotal models --agent <connector> --refresh`" } }
        : {}),
    },
    modelsView,
  );
}

function modelsView(result: ModelsResult): Report {
  return { sections: result.items.map(catalogSection) };
}

function catalogSection(row: ConnectorModelCatalog): Section {
  const blocks: Block[] = [];
  if (row.source) blocks.push({ kind: "lines", lines: [{ text: row.source, tone: "hint" }] });
  if (!row.supported) blocks.push({ kind: "lines", lines: [{ text: "no model catalog exposed", tone: "hint" }] });
  else if (row.error) blocks.push({ kind: "lines", lines: [{ text: row.error, tone: "failed" }] });
  else if (!row.models.length) blocks.push({ kind: "lines", lines: [{ text: "(no models reported)", tone: "hint" }] });
  else {
    const named = row.models.some((m) => m.name && m.name !== m.id);
    const variants = row.models.some((m) => m.variants?.length);
    blocks.push({
      kind: "table",
      columns: [
        { key: "id", label: "MODEL" },
        ...(named ? [{ key: "name", label: "NAME" }] : []),
        ...(variants ? [{ key: "variants", label: "VARIANTS" }] : []),
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
