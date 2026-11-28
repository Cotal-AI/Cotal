/** The Repair panel: read the plan, show what each step found and will change, ask once for a step
 *  that stops agents or moves the background service, then run that plan and nothing else. */
import type { Request } from "./model";

export interface RepairStepView { step: string; outcome: "ok" | "fix" | "needs-you" | "cannot"; found: string; change?: string; changed?: string; consent?: "takeover" | "start-stopped" | "remove-old-registration"; space?: string; agents?: { space: string; name: string; application: string }[]; owner?: { kind: "app" | "cli"; location: string } }
export interface RepairPlanView { digest: string; steps: RepairStepView[] }

/** The approval line for a step that needs one, in plain words. Empty when nothing needs asking. */
export function consentCopy(plan: RepairPlanView): string {
  const takeover = plan.steps.find(step => step.outcome === "fix" && step.consent === "takeover");
  if (takeover) {
    const copy = takeover.owner?.kind === "app" ? "another copy of the Cotal app" : "a command-line install of Cotal";
    const count = takeover.agents?.length ?? 0;
    return `The background service is now run by ${copy}. Repair moves it to this app. Your spaces and sign-in stay as they are.${count ? ` ${count === 1 ? "This agent stops" : `These ${count} agents stop`}:` : ""}`;
  }
  if (plan.steps.some(step => step.outcome === "fix" && step.consent === "start-stopped")) return "The background service was stopped on this computer. Repair starts it again.";
  const stale = plan.steps.filter(step => step.outcome === "fix" && step.consent === "remove-old-registration").map(step => step.space).filter(Boolean);
  if (stale.length) return `Repair removes this computer's old agent host registration in ${new Intl.ListFormat("en", { type: "conjunction" }).format(stale as string[])}. If an older copy still answers there, Repair leaves it alone.`;
  return "";
}

/** The button label: one plain verb for what applying does. */
export function applyLabel(plan: RepairPlanView): string {
  if (!plan.steps.some(step => step.outcome === "fix")) return "Done";
  return plan.steps.some(step => step.consent === "takeover" && step.outcome === "fix") ? "Use this app" : "Repair";
}

/** Consents the person gives by choosing the apply button. */
export function consents(plan: RepairPlanView): NonNullable<RepairStepView["consent"]>[] {
  return [...new Set(plan.steps.flatMap(step => step.outcome === "fix" && step.consent ? [step.consent] : []))];
}

export function renderRepair(root: HTMLElement, plan: RepairPlanView, result?: RepairStepView[]): void {
  const list = root.querySelector<HTMLOListElement>("#repair-steps")!;
  list.replaceChildren(...(result ?? plan.steps).map(step => {
    const li = document.createElement("li");
    li.dataset.outcome = step.outcome;
    const found = document.createElement("span"); found.textContent = step.found;
    li.append(found);
    const next = step.changed ?? (step.outcome === "fix" ? step.change : undefined);
    if (next) { const change = document.createElement("small"); change.textContent = next; li.append(change); }
    return li;
  }));
  const consent = root.querySelector<HTMLElement>("#repair-consent")!;
  const agents = root.querySelector<HTMLUListElement>("#repair-agents")!;
  const copy = result ? "" : consentCopy(plan);
  consent.textContent = copy; consent.hidden = !copy;
  const stopping = result ? [] : plan.steps.find(step => step.consent === "takeover" && step.outcome === "fix")?.agents ?? [];
  agents.replaceChildren(...stopping.map(agent => { const li = document.createElement("li"); li.textContent = `${agent.name} (${agent.application}) in ${agent.space}`; return li; }));
  agents.hidden = !stopping.length;
  const apply = root.querySelector<HTMLButtonElement>("#repair-apply")!;
  apply.textContent = result ? "Done" : applyLabel(plan);
}

export type RepairRequest = (request: Request & { digest?: string; consent?: string[] }) => Promise<Record<string, unknown>>;

/** Validate a plan the background service returned before the window trusts it. */
export function readPlan(value: Record<string, unknown>): RepairPlanView {
  if (typeof value.digest !== "string" || !/^[0-9a-f]{64}$/.test(value.digest) || !Array.isArray(value.steps)) throw new Error("Repair returned an unsupported plan.");
  const steps = value.steps.map((raw): RepairStepView => {
    if (!raw || typeof raw !== "object" || typeof raw.step !== "string" || typeof raw.found !== "string" || !["ok", "fix", "needs-you", "cannot"].includes(raw.outcome)) throw new Error("Repair returned an unsupported step.");
    return raw as RepairStepView;
  });
  return { digest: value.digest, steps };
}
