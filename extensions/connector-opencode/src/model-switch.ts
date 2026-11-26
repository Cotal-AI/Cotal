/**
 * The OpenCode agent's `set-model` on its `agent` endpoint (SPEC 13.22). A switch names a
 * `provider/model` the server lists and, optionally, a variant that model lists, checked first
 * because OpenCode runs an unlisted variant as no variant and does not say so.
 *
 * OpenCode 1.x has no route that sets a session's model. Each prompt runs on `input.model ??
 * agent.model ?? the session's model` (1.19.6), and the launch pins the `cotal` agent's model, so a
 * prompt that names none runs on the launch model. The 1.x switch keeps the owner's choice, and every
 * prompt and command the connector sends names it. OpenCode 2.x sets the session's model with
 * `POST /api/session/:id/model`, which outranks the agent's model and takes any model it is given.
 */
import { CommandRefused } from "@cotal-ai/connector-core";
import type { SetModelOutput } from "@cotal-ai/core";
import { OpenCodeHttpError } from "./opencode2-http.js";

type Api = <T>(path: string, init?: RequestInit, timeoutMs?: number) => Promise<T>;
interface ModelRef { providerID: string; modelID: string }

/** What a 1.x prompt body names: nothing before the owner's first switch. */
export interface PromptModel1 { model?: ModelRef; variant?: string }

/** `provider/model`, split as OpenCode splits it: the provider ends at the first slash. */
function refOf(id: string): ModelRef {
  const slash = id.indexOf("/");
  if (slash < 1 || slash === id.length - 1) throw new CommandRefused("failed-precondition", `OpenCode names a model provider/model, not "${id}"`);
  return { providerID: id.slice(0, slash), modelID: id.slice(slash + 1) };
}

/** The server's model list, as `read` takes it from the reply. Nothing has changed yet, so a list
 *  OpenCode does not give refuses the switch. */
async function listOf(api: Api, path: string, read: (reply: unknown) => unknown): Promise<unknown[]> {
  let list: unknown;
  try {
    list = read(await api<unknown>(path, undefined, 30_000));
  } catch (e) {
    throw new CommandRefused("failed-precondition", `OpenCode did not list its models at ${path}: ${(e as Error).message}`);
  }
  if (!Array.isArray(list)) throw new CommandRefused("failed-precondition", `OpenCode answered ${path} with no list`);
  return list;
}

/** The variants 1.x lists for the model at `GET /provider`, or undefined when no provider lists it. */
async function variants1(api: Api, ref: ModelRef): Promise<string[] | undefined> {
  const all = await listOf(api, "/provider", (r) => (r as { all?: unknown } | undefined)?.all);
  const models = (all as { id?: unknown; models?: Record<string, { variants?: Record<string, unknown> }> }[]).find((p) => p.id === ref.providerID)?.models;
  if (!models || !Object.hasOwn(models, ref.modelID)) return undefined;
  return Object.keys(models[ref.modelID]?.variants ?? {});
}

/** The variants 2.x lists for the model at `GET /api/model`, or undefined when it lists no such model. */
async function variants2(api: Api, ref: ModelRef): Promise<string[] | undefined> {
  const data = await listOf(api, "/api/model", (r) => (r as { data?: unknown } | undefined)?.data);
  const entry = (data as { providerID?: unknown; id?: unknown; variants?: unknown }[]).find((m) => m.providerID === ref.providerID && m.id === ref.modelID);
  if (!entry) return undefined;
  return (Array.isArray(entry.variants) ? entry.variants : []).map((v) => (v as { id?: unknown } | null)?.id).filter((v): v is string => typeof v === "string");
}

/** Refuse a model the server does not list, or a variant the model does not. `named` is whether the
 *  owner named the model: an unlisted model the agent already runs is not a name they got wrong. */
function offered(id: string, named: boolean, variants: string[] | undefined, variant: string | undefined): string[] {
  if (!variants) {
    if (named) throw new CommandRefused("not-found", `OpenCode lists no model ${id}`);
    throw new CommandRefused("failed-precondition", `OpenCode does not list ${id}, the model this agent runs, so name a model`);
  }
  if (variant !== undefined && !variants.includes(variant))
    throw new CommandRefused("failed-precondition", `OpenCode lists ${variants.length ? `the variants ${variants.join(", ")}` : "no variants"} for ${id}, not "${variant}"`);
  return variants;
}

const answer = (model: string, variant: string | undefined): SetModelOutput => ({ model, ...(variant !== undefined ? { variant } : {}) });

interface ModelChoice1 {
  setModel(model: string | undefined, variant: string | undefined): Promise<SetModelOutput>;
  prompt(): PromptModel1;
  /** What a 1.x `/command` body names: nothing before the owner's first switch. */
  command(): { model?: string; variant?: string };
}

/** The 1.x switch. `launch` is what the launch pinned on the `cotal` agent, each absent when it
 *  pinned none. */
export function opencode1ModelChoice(api: Api, launch: { model?: string; variant?: string }): ModelChoice1 {
  let chosen: { id: string; ref: ModelRef; variant?: string } | undefined;
  const variantField = (): { variant?: string } => (chosen?.variant !== undefined ? { variant: chosen.variant } : {});
  return {
    async setModel(model, variant) {
      const id = model ?? chosen?.id ?? launch.model;
      if (id === undefined) throw new CommandRefused("failed-precondition", "this agent runs the model OpenCode chose at launch, which the connector is not told, so name a model");
      const ref = refOf(id);
      const variants = offered(id, model !== undefined, await variants1(api, ref), variant);
      chosen = { id, ref, ...(variant !== undefined ? { variant } : {}) };
      // A prompt that names no variant runs the `cotal` agent's own variant when it names the agent's
      // own model, so the answer names that variant.
      const kept = id === launch.model && launch.variant !== undefined && variants.includes(launch.variant) ? launch.variant : undefined;
      return answer(id, variant ?? kept);
    },
    prompt: () => (chosen ? { model: chosen.ref, ...variantField() } : {}),
    command: () => (chosen ? { model: chosen.id, ...variantField() } : {}),
  };
}

interface ModelSwitch2 {
  setModel(model: string | undefined, variant: string | undefined): Promise<SetModelOutput>;
  /** OpenCode's `model.request` hook named the model the session runs. */
  ran(model: string): void;
}

/** The 2.x switch. `launchModel` is the model the launch pinned, absent when it pinned none. */
export function opencode2ModelSwitch(deps: { api: Api; ensureSession(): Promise<string | undefined>; launchModel?: string }): ModelSwitch2 {
  // The model the session runs, as the last switch or `model.request` named it.
  let current: string | undefined;
  return {
    async setModel(model, variant) {
      const id = model ?? current ?? deps.launchModel;
      if (id === undefined) throw new CommandRefused("failed-precondition", "OpenCode has not said which model this agent runs, so name a model");
      const ref = refOf(id);
      offered(id, model !== undefined, await variants2(deps.api, ref), variant);
      const session = await deps.ensureSession();
      if (!session) throw new CommandRefused("failed-precondition", "this agent has no OpenCode session yet");
      try {
        // Without a variant OpenCode clears the session's, so the model runs its own default.
        await deps.api(`/api/session/${encodeURIComponent(session)}/model`, {
          method: "POST",
          body: JSON.stringify({ model: { providerID: ref.providerID, id: ref.modelID, ...(variant !== undefined ? { variant } : {}) } }),
        });
      } catch (e) {
        if (e instanceof OpenCodeHttpError && e.status >= 400 && e.status < 500) throw new CommandRefused("failed-precondition", e.message);
        throw e;
      }
      current = id;
      return answer(id, variant);
    },
    ran(model) {
      current = model;
    },
  };
}
