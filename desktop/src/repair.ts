/** The Repair panel: read the plan, show what each step found and will change, ask once for a step
 *  that stops agents or moves the background service, then run that plan and nothing else. */
import type { Request } from "./model";

export interface RepairStepView { step: string; outcome: "ok" | "fix" | "needs-you" | "cannot" | "unchecked"; found: string; change?: string; changed?: string; failed?: string; detail?: string; consent?: "takeover" | "start-stopped" | "remove-old-registration"; space?: string; spaces?: string[]; action?: "update" | "reinstall"; disconnected?: true; agentsUnknown?: true; agents?: { space: string; name: string; application: string }[]; owner?: { kind: "app" | "cli" } }
export interface RepairPlanView { digest: string; steps: RepairStepView[] }
/** What applying returned: each step as applied, and what a new check finds still needs fixing. */
export interface RepairResultView { steps: RepairStepView[]; repaired: boolean; remaining?: RepairStepView[] }

/** The approval for every step that needs one, in plain words. Choosing the button approves all of
 *  them, so each is named. Empty when nothing needs asking. */
export function consentCopy(plan: RepairPlanView): string {
  const list = (items: readonly string[]) => new Intl.ListFormat("en", { type: "conjunction" }).format(items);
  const parts: string[] = [];
  const takeover = plan.steps.find(step => step.outcome === "fix" && step.consent === "takeover");
  if (takeover) {
    const copy = takeover.owner?.kind === "app" ? "another copy of the Cotal app" : "a command-line install of Cotal";
    const count = takeover.agents?.length ?? 0;
    const stops = takeover.agentsUnknown
      ? ` Cotal could not list the agents it runs, so any agents it runs stop and don't start again by themselves.${count ? " These are known to stop:" : ""}`
      : count ? ` ${count === 1 ? "This agent stops and doesn't start again by itself" : `These ${count} agents stop and don't start again by themselves`}:` : "";
    parts.push(`The background service is now run by ${copy}. Repair moves it to this app, so that copy stops running it. Your spaces and sign-in stay as they are.${stops}`);
  }
  if (plan.steps.some(step => step.outcome === "fix" && step.consent === "start-stopped")) parts.push("The background service was stopped on this computer. Repair starts it again.");
  const stale = plan.steps.filter(step => step.outcome === "fix" && step.consent === "remove-old-registration" && step.space);
  if (stale.length) {
    const hosted = stale.filter(step => !step.disconnected).map(step => step.space!), left = stale.filter(step => step.disconnected).map(step => step.space!);
    const where = [
      ...(hosted.length ? [`in ${list(hosted)} and starts ${hosted.length === 1 ? "its agent host" : "their agent hosts"} again`] : []),
      ...(left.length ? [`${hosted.length ? "" : "in "}${list(left)}, which ${left.length === 1 ? "stays" : "stay"} disconnected from this computer`] : []),
    ];
    parts.push(`Repair ${parts.length ? "also " : ""}removes this computer's old agent host registration ${where.join(", and in ")}. If an older copy still answers there, Repair leaves it alone.`);
  }
  return parts.join(" ");
}

/** The button label: one plain verb for what applying does. `retried` marks a plan that already
 *  stopped at a step: its apply button is not offered again unchanged. */
export function applyLabel(plan: RepairPlanView, retried = false): string {
  if (retried || !plan.steps.some(step => step.outcome === "fix")) return signInNeeded(plan) ? "Sign in" : updateNeeded(plan) ? "Check for updates" : reinstallNeeded(plan) ? "Download installer" : "Done";
  return plan.steps.some(step => step.consent === "takeover" && step.outcome === "fix") ? "Use this app" : "Repair";
}

/** The service record can't be verified: installing Cotal again replaces it. Repair can't. */
export function reinstallNeeded(plan: RepairPlanView): boolean {
  return plan.steps.some(step => step.outcome === "cannot" && step.action === "reinstall");
}

/** A newer copy of Cotal runs the service: updating this app is the fix, not a move. */
export function updateNeeded(plan: RepairPlanView): boolean {
  return plan.steps.some(step => step.outcome === "cannot" && step.action === "update");
}

/** The list after applying: what changed, where Repair stopped, and what a new check still finds. */
export function resultSteps(result: RepairResultView): RepairStepView[] {
  const acted = result.steps.filter(step => step.changed || step.failed);
  const stopped = result.steps.some(step => step.failed);
  // After a failed step the new check repeats what the failed step names, so it is not listed twice.
  return stopped ? acted : [...acted, ...(result.remaining ?? [])];
}

/** The sentence above the list after applying. */
export function resultNotice(result: RepairResultView): string {
  if (result.repaired) return "This computer is repaired.";
  if (result.steps.some(step => step.failed)) return "Repair stopped at a step it could not finish. The list shows what changed before it.";
  if (!result.remaining) return "Repair made its changes but could not check this computer again.";
  return "Repair fixed what it could. The list shows what is left.";
}

/** A sign-in only the person can give: Repair cannot fix it, so its one button is Sign in. */
export function signInNeeded(plan: RepairPlanView): boolean {
  return plan.steps.some(step => step.step === "account" && step.outcome === "needs-you");
}

/** Consents the person gives by choosing the apply button. */
export function consents(plan: RepairPlanView): NonNullable<RepairStepView["consent"]>[] {
  return [...new Set(plan.steps.flatMap(step => step.outcome === "fix" && step.consent ? [step.consent] : []))];
}

export function renderRepair(root: HTMLElement, plan: RepairPlanView, result?: RepairStepView[], retried = false): void {
  const list = root.querySelector<HTMLOListElement>("#repair-steps")!;
  list.replaceChildren(...(result ?? plan.steps).map(step => {
    const li = document.createElement("li");
    li.dataset.outcome = step.outcome;
    const found = document.createElement("span"); found.textContent = step.found;
    li.append(found);
    const next = step.failed ?? step.changed ?? (step.outcome === "fix" ? step.change : undefined);
    if (next) { const change = document.createElement("small"); change.textContent = next; li.append(change); }
    if (step.failed) li.dataset.outcome = "failed";
    return li;
  }));
  const consent = root.querySelector<HTMLElement>("#repair-consent")!;
  const agents = root.querySelector<HTMLUListElement>("#repair-agents")!;
  const copy = result || retried ? "" : consentCopy(plan);
  consent.textContent = copy; consent.hidden = !copy;
  const stopping = result || retried ? [] : plan.steps.find(step => step.consent === "takeover" && step.outcome === "fix")?.agents ?? [];
  agents.replaceChildren(...stopping.map(agent => { const li = document.createElement("li"); li.textContent = `${agent.name} (${agent.application}) in ${agent.space}`; return li; }));
  agents.hidden = !stopping.length;
  const apply = root.querySelector<HTMLButtonElement>("#repair-apply")!;
  apply.textContent = result ? "Done" : applyLabel(plan, retried);
}

export type RepairRequest = (request: Request & { digest?: string; consent?: string[] }) => Promise<Record<string, unknown>>;

/** Validate a plan the background service returned before the window trusts it. */
export function readPlan(value: Record<string, unknown>): RepairPlanView {
  if (typeof value.digest !== "string" || !/^[0-9a-f]{64}$/.test(value.digest) || !Array.isArray(value.steps)) throw new Error("Repair returned an unsupported plan.");
  const steps = value.steps.map((raw): RepairStepView => {
    if (!raw || typeof raw !== "object" || typeof raw.step !== "string" || typeof raw.found !== "string" || !["ok", "fix", "needs-you", "cannot", "unchecked"].includes(raw.outcome)) throw new Error("Repair returned an unsupported step.");
    return raw as RepairStepView;
  });
  return { digest: value.digest, steps };
}
