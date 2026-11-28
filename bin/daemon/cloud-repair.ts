/**
 * Cloud asks this computer to repair: the service side of the repair door.
 *
 * Cloud writes a request into this computer's spaces document as `repair: {revision, request}`, and
 * the service answers in its heartbeat as `repair: {revision, state, completedAt, ...}`. The service
 * runs the same Repair plan the app and `cotal daemon repair` run, in two phases: `plan` answers the
 * steps and a digest, and `apply` runs that plan only while its digest still matches.
 *
 * - Each account keeps the last revision it handled (`repair.json` beside its computer identity), so
 *   a repeated request, a 304 or a restart never runs a revision twice.
 * - A newer revision replaces an older one that has not started, so a new `plan` withdraws an `apply`
 *   that is waiting. There is no queue and no cancel.
 * - While a local change holds the agent-app gate, an `apply` is answered `waiting` and tried again
 *   on the next poll.
 * - A run the service did not finish because it restarted is answered `interrupted` with a fresh
 *   plan, and never runs again.
 * - Only steps that are safe without the person at this computer run from Cloud: finding agent apps,
 *   setting up the agent app connectors again, starting stopped spaces and removing an old
 *   registration. A plan that needs any other change is
 *   refused `needs-this-computer`, and its steps show that change as `needs-you`. Reset is never
 *   accepted.
 * - The ack carries fixed plain words, booleans and space ids only: never a path, a person's or
 *   account's name, a command or what the service said.
 */
import { homedir, userInfo } from "node:os";
import { basename, dirname, join } from "node:path";
import { readFileSync } from "node:fs";
import { mkSecretDir, writeSecretFileAtomic } from "@cotal-ai/core";
import type { AppliedStep, RepairConsent, RepairPlan, RepairResult, RepairStep } from "./repair.js";

export const REPAIR_CAPABILITY = "repair-v1";
/** The bounds Cloud reads: at most this many steps, and characters in any string. */
export const ACK_MAX_STEPS = 32;
export const ACK_MAX_CHARS = 300;
/** The ack's share of the heartbeat, whose whole body must stay under 16384 bytes. */
export const ACK_MAX_BYTES = 6144;

export type CloudRepairRequest =
  | { readonly revision: number; readonly request: "plan" }
  | { readonly revision: number; readonly request: "apply"; readonly digest: string; readonly consent: readonly RepairConsent[] }
  | { readonly revision: number; readonly request: "unsupported" };

export type AckState = "planned" | "applied" | "failed" | "refused" | "waiting" | "interrupted" | "unsupported";

export interface AckStep {
  readonly step: string;
  readonly outcome: string;
  readonly found: string;
  readonly change?: string;
  readonly consent?: string;
  /** The space's catalog id, never its name. */
  readonly space?: string;
  readonly spaces?: readonly string[];
  /** Present and true when the step ran and finished. */
  readonly changed?: true;
  /** Present and true when the step ran and stopped. The steps after it did not run. */
  readonly failed?: true;
}

export interface RepairAck {
  readonly revision: number;
  readonly state: AckState;
  /** When the service finished answering this revision, as an ISO time. */
  readonly completedAt: string;
  readonly digest?: string;
  /** Applied and failed only: a new check finds nothing left to fix. */
  readonly repaired?: boolean;
  readonly reason?: "plan-changed" | "needs-this-computer" | "needs-consent";
  readonly steps?: readonly AckStep[];
}

/** The only consent Cloud can give. Moving or starting the service needs the person at this computer. */
const REMOTE_CONSENTS: readonly RepairConsent[] = ["remove-old-registration"];
/** The steps a Cloud request may run. Every other step changes the service itself. */
const REMOTE_STEPS: ReadonlySet<string> = new Set(["agent-apps", "connectors", "spaces", "stale-registration"]);

/** Read the request Cloud wrote. Undefined when there is none or it has no usable revision. */
export function parseRepairRequest(raw: unknown): CloudRepairRequest | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const value = raw as Record<string, unknown>;
  if (!Number.isSafeInteger(value.revision) || Number(value.revision) < 1) return undefined;
  const revision = Number(value.revision);
  if (value.request === "plan") return { revision, request: "plan" };
  if (value.request === "apply" && typeof value.digest === "string" && /^[0-9a-f]{64}$/.test(value.digest)
    && Array.isArray(value.consent) && value.consent.every(item => typeof item === "string"))
    return { revision, request: "apply", digest: value.digest, consent: REMOTE_CONSENTS.filter(item => (value.consent as string[]).includes(item)) };
  return { revision, request: "unsupported" };
}

/** A fix step Cloud may not run shows as one that needs the person at this computer. */
export function remoteStep(step: RepairStep): RepairStep {
  if (step.outcome !== "fix" || REMOTE_STEPS.has(step.step)) return step;
  const { change: _change, consent: _consent, ...rest } = step;
  return { ...rest, outcome: "needs-you" };
}

/** Why a plan can't run from Cloud as asked, or undefined when it can. */
export function remoteRefusal(plan: RepairPlan, consent: readonly RepairConsent[]): "needs-this-computer" | "needs-consent" | undefined {
  const fixes = plan.steps.filter(step => step.outcome === "fix");
  if (fixes.some(step => !REMOTE_STEPS.has(step.step))) return "needs-this-computer";
  if (fixes.some(step => step.consent && !consent.includes(step.consent))) return "needs-consent";
  return undefined;
}

const FALLBACK: Record<string, string> = {
  "service-owner": "The background service needs a change made on this computer.",
  "service-running": "The background service needs a change made on this computer.",
  "agent-apps": "The background service has not found your agent apps.",
  connectors: "Cotal couldn't set up the agent app connectors on this computer.",
  spaces: "Some spaces have stopped on this computer.",
  "stale-registration": "An old copy of this computer's agent host is still registered in a space.",
  account: "An account on this computer needs you to sign in again.",
};

/** Names that must not leave this computer: the person's user and home folder names, plus `extra`. */
export function privateWords(extra: readonly string[]): string[] {
  const words = [...extra];
  try { words.push(userInfo().username); } catch { /* no user record */ }
  words.push(basename(homedir()));
  return [...new Set(words.filter(word => word.length >= 3))];
}

/** The text when it is plain words within the bound, with no path, command or private name. */
function plain(text: string | undefined, secrets: readonly string[]): string | undefined {
  if (text === undefined || text.length > ACK_MAX_CHARS || /[\\/`~$%<>{}|]|\b[A-Za-z]:/.test(text)) return undefined;
  const lower = text.toLowerCase();
  return secrets.some(word => lower.includes(word.toLowerCase())) ? undefined : text;
}

/** One step as Cloud may store and show it. */
export function ackStep(step: RepairStep | AppliedStep, spaceId: (slug: string) => string | undefined, secrets: readonly string[]): AckStep {
  const shown = remoteStep(step);
  const found = plain(shown.found, secrets) ?? FALLBACK[shown.step] ?? "Repair checked this computer.";
  const change = shown.outcome === "fix" ? plain(shown.change, secrets) : undefined;
  const space = shown.space === undefined ? undefined : spaceId(shown.space);
  const spaces = shown.spaces?.flatMap(slug => { const id = spaceId(slug); return id ? [id] : []; });
  const applied = step as AppliedStep;
  return {
    step: shown.step, outcome: shown.outcome, found,
    ...(change ? { change } : {}),
    ...(shown.consent ? { consent: shown.consent } : {}),
    ...(space ? { space } : {}),
    ...(spaces?.length ? { spaces } : {}),
    ...(applied.changed !== undefined ? { changed: true as const } : {}),
    ...(applied.failed !== undefined ? { failed: true as const } : {}),
  };
}

/** Keep the ack within its share of the heartbeat: at most 32 steps, then no change words, then fewer steps. */
export function boundedAck(ack: RepairAck): RepairAck {
  const size = (value: RepairAck) => Buffer.byteLength(JSON.stringify(value), "utf8");
  let steps = ack.steps?.slice(0, ACK_MAX_STEPS);
  let bounded: RepairAck = steps ? { ...ack, steps } : ack;
  if (steps && size(bounded) > ACK_MAX_BYTES) { steps = steps.map(({ change: _change, ...rest }) => rest); bounded = { ...ack, steps }; }
  while (steps?.length && size(bounded) > ACK_MAX_BYTES) { steps = steps.slice(0, -1); bounded = { ...ack, steps }; }
  return bounded;
}

interface StoredRecord { readonly v: 1; readonly handled: number; readonly inProgress?: number; readonly ack?: RepairAck }

function readRecord(file: string): StoredRecord {
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    const ack = raw.ack as Record<string, unknown> | undefined;
    if (raw.v === 1 && Number.isSafeInteger(raw.handled) && Number(raw.handled) >= 0
      && (raw.inProgress === undefined || Number.isSafeInteger(raw.inProgress))
      && (ack === undefined || (typeof ack === "object" && ack !== null && Number.isSafeInteger(ack.revision) && typeof ack.state === "string")))
      return raw as unknown as StoredRecord;
  } catch { /* none yet, or unreadable: nothing handled */ }
  return { v: 1, handled: 0 };
}

/** What the repair door runs. The service gives it its own Repair. */
export interface CloudRepairRunner {
  plan(): Promise<RepairPlan>;
  /** Run the plan with this digest. `failure` is why a step stopped, when one did. */
  apply(digest: string, consent: readonly RepairConsent[]): Promise<{ readonly result: RepairResult; readonly failure?: unknown }>;
  /** A local change holds the agent-app gate. */
  busy(): boolean;
}

/** One signed-in account: its key and the folder that keeps its records. */
export interface RepairAccount { readonly key: string; readonly dir: string }

type Pending = CloudRepairRequest | { readonly revision: number; readonly request: "interrupted" };
type Outcome = { readonly ack: Omit<RepairAck, "revision" | "completedAt">; readonly keep: boolean };
const applyKey = (request: Extract<CloudRepairRequest, { request: "apply" }>) => `${request.digest}:${[...request.consent].sort().join(",")}`;

/** Answer Cloud's repair requests for every signed-in account, one run at a time. */
export function createCloudRepair(runner: CloudRepairRunner, opts: {
  readonly log?: (line: string) => void;
  /** A space's catalog id from its name. */
  readonly spaceId: (slug: string) => string | undefined;
  /** Names that must never reach Cloud: account subjects and labels, the computer's name, space names. */
  readonly secrets: () => readonly string[];
  /** How long a request waits for other accounts' requests from the same poll. */
  readonly settleMs?: number;
}) {
  const records = new Map<string, StoredRecord & { readonly file: string }>();
  const pending = new Map<string, Pending>();
  const listeners = new Set<(key: string) => void>();
  let work: Promise<void> | undefined;
  let again = false;
  let stopped = false;
  const now = () => new Date().toISOString();

  const record = (account: RepairAccount) => {
    let found = records.get(account.key);
    if (!found) {
      const file = join(account.dir, "repair.json");
      found = { ...readRecord(file), file };
      records.set(account.key, found);
      // A run this service started and never finished: it restarted. Answer it once, never run it again.
      if (found.inProgress !== undefined && found.inProgress > found.handled) pending.set(account.key, { revision: found.inProgress, request: "interrupted" });
    }
    return found;
  };
  const save = (key: string, next: Omit<StoredRecord, "v">) => {
    const { file } = records.get(key)!;
    const stored: StoredRecord = { v: 1, handled: next.handled, ...(next.inProgress !== undefined ? { inProgress: next.inProgress } : {}), ...(next.ack ? { ack: next.ack } : {}) };
    records.set(key, { ...stored, file });
    try { mkSecretDir(dirname(file)); writeSecretFileAtomic(file, JSON.stringify(stored)); }
    catch { opts.log?.("cloud repair: could not save the handled revision"); }
  };
  const answer = (key: string, ack: RepairAck) => {
    const current = records.get(key)!;
    // A waiting apply that is still waiting sends nothing new.
    if (ack.state === "waiting" && current.ack?.state === "waiting" && current.ack.revision === ack.revision) return;
    save(key, { handled: ack.state === "waiting" ? current.handled : Math.max(current.handled, ack.revision), ack: boundedAck(ack) });
    for (const listener of listeners) { try { listener(key); } catch { /* a listener never stops an ack */ } }
  };
  const ackSteps = (items: readonly (RepairStep | AppliedStep)[]) => {
    const secrets = privateWords(opts.secrets());
    return items.map(step => ackStep(step, opts.spaceId, secrets));
  };

  async function applyOnce(runs: readonly (readonly [string, number])[], digest: string, consent: readonly RepairConsent[]): Promise<Outcome> {
    let plan: RepairPlan;
    try { plan = await runner.plan(); } catch { return { ack: { state: "failed", repaired: false }, keep: false }; }
    const refused = (reason: NonNullable<RepairAck["reason"]>): Outcome => ({ ack: { state: "refused", reason, digest: plan.digest, steps: ackSteps(plan.steps) }, keep: false });
    if (plan.digest !== digest) return refused("plan-changed");
    const why = remoteRefusal(plan, consent);
    if (why) return refused(why);
    opts.log?.(`cloud repair: apply revision ${runs[0]![1]}`);
    // Recorded before the run for every account it answers, so a restart during it is answered as
    // interrupted and never runs again.
    for (const [key, revision] of runs) {
      const current = records.get(key)!;
      save(key, { handled: current.handled, inProgress: revision, ...(current.ack ? { ack: current.ack } : {}) });
    }
    try {
      const { result, failure } = await runner.apply(digest, consent);
      // The gate was taken between the check and the run, and nothing changed: still waiting.
      if ((failure as { code?: unknown } | undefined)?.code === "LIFECYCLE_BLOCKED" && !result.steps.some(step => step.changed !== undefined)) return { ack: { state: "waiting" }, keep: true };
      return { ack: { state: failure === undefined ? "applied" : "failed", repaired: result.repaired, steps: ackSteps(result.steps) }, keep: false };
    } catch (error) {
      if ((error as { native?: { code?: unknown } } | undefined)?.native?.code === "PLAN_CHANGED") {
        try { plan = await runner.plan(); } catch { return { ack: { state: "refused", reason: "plan-changed" }, keep: false }; }
        return refused("plan-changed");
      }
      return { ack: { state: "failed", repaired: false }, keep: false };
    }
  }

  /** One pass over every pending request. A plan is read once for all of them, and identical applies share one run. */
  async function pass(): Promise<void> {
    let plan: RepairPlan | undefined;
    let planFailed = false;
    let plans = 0;
    const applies = new Map<string, Outcome>();
    const batch = [...pending.entries()];
    for (const [key, request] of batch) {
      if (stopped) return;
      // A newer request replaced this one; the next pass takes it.
      if (pending.get(key) !== request) continue;
      const revision = request.revision;
      if (request.request === "unsupported") {
        pending.delete(key);
        opts.log?.(`cloud repair: unsupported revision ${revision}`);
        answer(key, { revision, state: "unsupported", completedAt: now() });
        continue;
      }
      if (request.request === "plan" || request.request === "interrupted") {
        if (!plan && !planFailed) {
          try { plan = await runner.plan(); plans++; } catch { planFailed = true; }
        }
        if (pending.get(key) !== request) continue;
        pending.delete(key);
        opts.log?.(`cloud repair: ${request.request} revision ${revision}`);
        answer(key, plan
          ? { revision, state: request.request === "plan" ? "planned" : "interrupted", completedAt: now(), digest: plan.digest, steps: ackSteps(plan.steps) }
          : { revision, state: "failed", completedAt: now(), repaired: false });
        continue;
      }
      const same = applyKey(request);
      let outcome = applies.get(same);
      if (!outcome) {
        if (runner.busy()) outcome = { ack: { state: "waiting" }, keep: true };
        else {
          const runs = [...pending.entries()].flatMap(([other, item]) => item.request === "apply" && applyKey(item) === same ? [[other, item.revision] as const] : []);
          outcome = await applyOnce(runs, request.digest, request.consent);
          plan = undefined; planFailed = false;
        }
        applies.set(same, outcome);
      } else if (!outcome.keep) opts.log?.(`cloud repair: apply revision ${revision} shared a run`);
      // A run that started is answered even when a newer request arrived meanwhile; the newer one runs next.
      const replaced = pending.get(key) !== request;
      if (replaced && outcome.keep) continue;
      if (!replaced && !outcome.keep) pending.delete(key);
      answer(key, { revision, ...outcome.ack, completedAt: now() });
    }
    if (plans) opts.log?.(`cloud repair: ran ${plans} plan${plans === 1 ? "" : "s"} for ${batch.filter(([, item]) => item.request === "plan" || item.request === "interrupted").length} request(s)`);
  }

  const kick = () => {
    if (stopped) return;
    if (work) { again = true; return; }
    work = (async () => {
      await new Promise(resolve => setTimeout(resolve, opts.settleMs ?? 250));
      await pass();
    })().catch(() => { opts.log?.("cloud repair: a request could not be answered"); }).finally(() => {
      work = undefined;
      // Requests that arrived during the pass run now; a waiting apply waits for the next poll.
      const fresh = [...pending.entries()].some(([key, item]) => !(item.request === "apply" && records.get(key)?.ack?.state === "waiting" && records.get(key)?.ack?.revision === item.revision));
      if (again && fresh && !stopped) { again = false; kick(); } else again = false;
    });
  };

  return {
    /** Take what an account's spaces document asks for. Called on every poll, so a waiting apply is tried again. */
    offer(account: RepairAccount, raw: unknown, read: boolean) {
      if (stopped) return;
      const current = record(account);
      if (read) {
        const request = parseRepairRequest(raw);
        const queued = pending.get(account.key);
        if (request && request.revision > current.handled && (!queued || request.revision > queued.revision)) pending.set(account.key, request);
      }
      if (pending.size) kick();
    },
    /** The latest ack for this account. Once it has handled any revision, every heartbeat carries it. */
    ack(account: RepairAccount): RepairAck | undefined { return record(account).ack; },
    /** Called with an account's key when it has a new ack to send. */
    onAck(listener: (key: string) => void) { listeners.add(listener); },
    async close() { stopped = true; await work; },
  };
}

export type CloudRepair = ReturnType<typeof createCloudRepair>;
