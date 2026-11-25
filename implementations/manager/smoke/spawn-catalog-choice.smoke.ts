/**
 * A spawn's variant and modes against the connector's model catalog (Manager revision 55). The
 * served `spawn` input takes `modes`. The Manager refuses a variant or mode the catalog does not list
 * for the launched model, and a mode it marks unavailable, before anything is minted or launched, and
 * reads each catalog once.
 * Offline: an open-mesh Manager with a fake endpoint and runtime; no broker or harness runs.
 *
 * Run: pnpm smoke:manager-spawn-catalog-choice
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { emitSentinel } from "@cotal-ai/smoke-kit";
import { DEV_OWNER, principalKey, registry, type AgentHandle, type Connector, type LaunchOpts, type ModelCatalog } from "@cotal-ai/core";
import { Manager } from "../src/manager.js";
import { MANAGER_CONTRACTS, managerShippedSurface } from "../src/manager-service-contract.js";

let passed = 0;
let failed = 0;
function check(name: string, condition: unknown, detail?: unknown): void {
  if (condition) { passed++; console.log(`PASS ${name}`); return; }
  failed++;
  console.log(`FAIL ${name}${detail === undefined ? "" : ` :: ${JSON.stringify(detail)}`}`);
}

// --- The served schema -------------------------------------------------------------------------
const spawnInput = MANAGER_CONTRACTS.spawn!.input;
check("the Manager cluster is at revision 55", managerShippedSurface().revision === 55, managerShippedSurface().revision);
check("spawn takes a toggle and a choice in modes", spawnInput.validate({ name: "worker", modes: { fast: true, agent: "plan" } }) === true);
check("spawn refuses an empty modes object", spawnInput.validate({ name: "worker", modes: {} }) === false);
check("spawn refuses a mode value that is neither a boolean nor an option id", spawnInput.validate({ name: "worker", modes: { fast: 1 } }) === false);
check("spawn refuses an empty mode value", spawnInput.validate({ name: "worker", modes: { fast: "" } }) === false);

// --- The Manager's check -------------------------------------------------------------------------
const root = realpathSync(mkdtempSync(join(tmpdir(), "cotal-catalog-choice-")));
mkdirSync(join(root, ".cotal", "agents"), { recursive: true });
writeFileSync(join(root, ".cotal", "agents", "worker.md"), "---\nname: worker\nrole: worker\n---\nYou work.\n");

const deep = {
  id: "deep", isDefault: true, variants: [{ name: "low" }, { name: "high" }], defaultVariant: "low",
  modes: [
    { id: "fast", label: "Fast", kind: "toggle" as const, default: false },
    { id: "agent", label: "Agent", kind: "choice" as const, options: [{ id: "build", label: "Build" }, { id: "plan", label: "Plan" }], default: "build" },
    { id: "turbo", label: "Turbo", kind: "toggle" as const, default: false, unavailable: "Turbo has been disabled by your organization" },
    { id: "lane", label: "Lane", kind: "choice" as const, options: [{ id: "left", label: "Left" }], default: "left", unavailable: "Lanes need a paid plan" },
  ],
};
const reads: Record<string, number> = {};
let launched: LaunchOpts[] = [];
/** A connector whose catalog `answer` gives, counting each read. */
function fixture(name: string, answer: (() => ModelCatalog) | undefined, extra: Partial<Connector> = {}): void {
  const connector: Connector = {
    kind: "connector", name, supportsModelVariant: true, supportsModes: true, ...extra,
    ...(answer ? { listModels: async () => { reads[name] = (reads[name] ?? 0) + 1; return answer(); } } : {}),
    buildLaunch: (opts) => { launched.push(opts); return { command: "true", args: [], env: {} }; },
  };
  registry.register(connector);
}
fixture("cat", () => ({ models: [deep, { id: "plain" }] }));
fixture("cat-nomodes", () => ({ models: [deep] }), { supportsModes: undefined });
fixture("cat-nodefault", () => ({ models: [{ ...deep, isDefault: undefined }] }));
fixture("cat-unavailable", () => ({ models: [], unavailable: "not logged in" }));
fixture("cat-malformed", () => ({ models: [{ id: "deep", variants: [{ name: "low" }], defaultVariant: "max" }] }));
fixture("cat-noreason", () => ({ models: [{ id: "deep", modes: [{ id: "fast", label: "Fast", kind: "toggle", default: false, unavailable: "" }] }] }));
fixture("cat-blankreason", () => ({ models: [{ id: "deep", modes: [{ id: "fast", label: "Fast", kind: "toggle", default: false, unavailable: "  " }] }] }));
fixture("cat-blind", undefined);

const manager = new Manager({ space: "catalog-smoke", runtime: "pty", workspaceRoot: root });
const agents = (manager as unknown as { agents: Map<string, { id: string; name: string; lifecycleUid?: string; launch: { modes?: unknown } }> }).agents;
const session = { cols: 80, rows: 24, backlog: () => Buffer.alloc(0), onData: () => () => {}, onExit: () => () => {}, write: () => {}, resize: () => {} };
const handle = (name: string): AgentHandle => ({ name, kind: "fake", status: () => "running", stop: () => {}, interrupt: () => {}, attach: () => session });
(manager as unknown as { runtime: unknown }).runtime = { kind: "fake", spawn: (name: string) => handle(name) };
(manager as unknown as { ep: unknown }).ep = {
  ref: () => ({ id: "local.manager", name: "manager", role: "manager" }),
  getRoster: () => [...agents.values()].map((a) => ({ card: { id: principalKey(DEV_OWNER, a.id).key, name: a.name }, lifecycleUid: a.lifecycleUid, status: "idle" })),
  waitForPresenceSnapshot: async () => {},
  on: () => {},
  off: () => {},
};

type Reply = { ok: boolean; error?: string; data?: unknown };
/** Spawn `worker` on `agent` and stop it again, so every cell starts from an empty manager. */
async function spawn(agent: string, choice: { model?: string; variant?: string; modes?: Record<string, boolean | string> }): Promise<Reply> {
  launched = [];
  const reply = await manager.startAgent({ name: "worker", agent, events: false, ...choice }) as Reply;
  if (reply.ok) agents.clear();
  return reply;
}
/** A refusal that matches `pattern` and launched nothing. */
const refused = (reply: Reply, pattern: RegExp) => !reply.ok && pattern.test(reply.error ?? "") && launched.length === 0;

const unlistedVariant = await spawn("cat", { model: "deep", variant: "turbo" });
check("an unlisted variant is refused with the listed ones, and nothing launches",
  refused(unlistedVariant, /cat lists variants "low", "high" for model "deep", not "turbo" \(variant\)/), unlistedVariant);
const unlistedMode = await spawn("cat", { model: "deep", modes: { warp: true } });
check("an unlisted mode is refused with the listed ones", refused(unlistedMode, /lists modes "fast", "agent", "turbo", "lane" for model "deep", not "warp" \(modes\)/), unlistedMode);
const unavailableOn = await spawn("cat", { model: "deep", modes: { turbo: true } });
check("an unavailable toggle named on is refused with its reason",
  refused(unavailableOn, /mode "turbo" of model "deep" is unavailable: Turbo has been disabled by your organization \(modes\)/), unavailableOn);
const unavailableOff = await spawn("cat", { model: "deep", modes: { fast: true, turbo: false } });
check("an unavailable toggle named off is refused too, beside a mode the model runs",
  refused(unavailableOff, /mode "turbo" of model "deep" is unavailable: Turbo has been disabled/), unavailableOff);
const unavailableChoice = await spawn("cat", { modes: { lane: "left" } });
check("an unavailable choice is refused with its reason on the default row",
  refused(unavailableChoice, /mode "lane" of model "deep" is unavailable: Lanes need a paid plan \(modes\)/), unavailableChoice);
const toggleKind = await spawn("cat", { model: "deep", modes: { fast: "yes" } });
check("a toggle given an option id is refused", refused(toggleKind, /mode "fast" of model "deep" is a toggle, so it takes true or false, not "yes" \(modes\)/), toggleKind);
const choiceKind = await spawn("cat", { model: "deep", modes: { agent: true } });
check("a choice given a boolean is refused with its options", refused(choiceKind, /mode "agent" of model "deep" takes one of "build", "plan", not true \(modes\)/), choiceKind);
const choiceOption = await spawn("cat", { model: "deep", modes: { agent: "review" } });
check("a choice given an unlisted option is refused", refused(choiceOption, /takes one of "build", "plan", not "review" \(modes\)/), choiceOption);
const noModesConnector = await spawn("cat-nomodes", { model: "deep", modes: { fast: true } });
check("modes on a connector without supportsModes are refused before its catalog is read",
  refused(noModesConnector, /cat-nomodes connector does not support modes \(modes\)/) && reads["cat-nomodes"] === undefined, { noModesConnector, reads });
const ghost = await spawn("cat", { model: "ghost", variant: "high" });
check("a variant on a model the catalog does not list is refused", refused(ghost, /does not list model "ghost", so its variant cannot be checked/), ghost);
const plain = await spawn("cat", { model: "plain", variant: "high" });
check("a variant on a model that lists none is refused", refused(plain, /cat lists no variants for model "plain", not "high" \(variant\)/), plain);
const noDefault = await spawn("cat-nodefault", { variant: "high" });
check("with no model named and no default row, a variant is refused", refused(noDefault, /marks no default model/), noDefault);

const viaDefault = await spawn("cat", { variant: "high" });
check("with no model named, a variant the default row lists launches", viaDefault.ok && launched[0]?.variant === "high" && launched[0]?.model === undefined, viaDefault);
const listed = await spawn("cat", { model: "deep", variant: "high", modes: { fast: true, agent: "plan" } });
check("a listed variant and modes launch, and the connector receives the modes",
  listed.ok && launched[0]?.variant === "high" && isDeepStrictEqual(launched[0]?.modes, { fast: true, agent: "plan" }), { listed, modes: launched[0]?.modes });
check("the catalog was read once for every spawn above", reads.cat === 1, reads);

// The launch record keeps the modes, which is what preservation writes and resume replays.
launched = [];
const kept = await manager.startAgent({ name: "worker", agent: "cat", events: false, model: "deep", modes: { agent: "plan" } }) as Reply;
check("the seat's launch record names its modes", kept.ok && isDeepStrictEqual(agents.get("worker")?.launch.modes, { agent: "plan" }), agents.get("worker")?.launch);
agents.clear();

const models = await (manager as unknown as { opModels: (a: Record<string, unknown>) => Promise<Reply> }).opModels({ agent: "cat" });
const row = (models.data as { models?: { id: string; isDefault?: boolean; defaultVariant?: string; modes?: unknown[] }[] } | undefined)?.models?.[0];
const turbo = (row?.modes as { id: string; unavailable?: string }[] | undefined)?.find((m) => m.id === "turbo");
check("models reads the harness again and returns the new fields as the connector gave them, an unavailable mode with its reason",
  models.ok && reads.cat === 2 && row?.isDefault === true && row.defaultVariant === "low" && row.modes?.length === 4
    && turbo?.unavailable === "Turbo has been disabled by your organization", { models, reads });
await spawn("cat", { model: "deep", variant: "high" });
check("a spawn after models checks against that read", reads.cat === 2, reads);

const unavailable = await spawn("cat-unavailable", { variant: "high" });
await spawn("cat-unavailable", { variant: "high" });
check("a catalog that reports none refuses with its reason and is read again next time",
  refused(unavailable, /cat-unavailable has no model catalog on this host \(not logged in\)/) && reads["cat-unavailable"] === 2, { unavailable, reads });
const malformedModels = await (manager as unknown as { opModels: (a: Record<string, unknown>) => Promise<Reply> }).opModels({ agent: "cat-malformed" });
const malformedSpawn = await spawn("cat-malformed", { model: "deep", variant: "low" });
check("a catalog whose default variant is not one of its variants is unreadable, and its spawn is refused",
  !malformedModels.ok && /names default variant "max", which is not one of its variants/.test(malformedModels.error ?? "")
    && refused(malformedSpawn, /cat-malformed model catalog could not be read/), { malformedModels, malformedSpawn });
for (const agent of ["cat-noreason", "cat-blankreason"]) {
  const noReason = await (manager as unknown as { opModels: (a: Record<string, unknown>) => Promise<Reply> }).opModels({ agent });
  const noReasonSpawn = await spawn(agent, { model: "deep", modes: { fast: false } });
  check(`${agent}: a mode marked unavailable with an empty reason makes the catalog unreadable, and its spawn is refused`,
    !noReason.ok && /model "deep" mode "fast" is marked unavailable with no reason/.test(noReason.error ?? "")
      && refused(noReasonSpawn, new RegExp(`${agent} model catalog could not be read`)), { noReason, noReasonSpawn });
}
const blind = await spawn("cat-blind", { variant: "high" });
check("a variant on a connector that lists no catalog is refused", refused(blind, /cat-blind connector lists no model catalog/), blind);
const blindBare = await spawn("cat-blind", {});
check("a launch that chooses neither a variant nor modes needs no catalog", blindBare.ok, blindBare);

rmSync(root, { recursive: true, force: true });
emitSentinel({ passed, failed });
if (failed) process.exitCode = 1;
