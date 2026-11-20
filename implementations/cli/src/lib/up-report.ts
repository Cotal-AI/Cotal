import { oneLine, type Block } from "@cotal-ai/workspace";
import { displayCmd } from "./self-exec.js";
import { shellWord } from "./endpoint-errors.js";
import { unattributableRecordSteps } from "./local-process-stop.js";

export interface DetachedStatus {
  root?: string;
  /** The stack runs from the machine home, which bare `down` does not stop. */
  machineHome?: boolean;
  pid: number;
  delivery: boolean;
  authService: boolean;
  manager: boolean;
}

/** Render only components confirmed running for this detached boot. */
export function renderDetachedSummary(status: DetachedStatus): string {
  const components = [`nats-server (pid ${status.pid})`];
  if (status.delivery) components.push("delivery daemon");
  if (status.authService) components.push("user-auth service");
  if (status.manager) components.push("manager");
  // The home stack's only stop is --preserve-state, which takes its inventory from a manager.
  const cmd = displayCmd();
  const stop = !status.machineHome ? `\`${cmd} down\`` : status.manager ? `\`${cmd} down --preserve-state\`` : `\`${cmd} up\` to start its manager, then \`${cmd} down --preserve-state\``;
  return `✓ running in the background: ${components.join(", ")} - ${status.root ? `from ${oneLine(status.root)}, stop with: ${stop}` : `stop with: ${stop}`}`;
}

/** The Next after a detached boot, or after a refresh that found the mesh already running: launch
 *  an agent when its manager runs and the control plane spawn needs is not degraded, and stop the
 *  stack the way {@link renderDetachedSummary} names. It reads only what a refresh can also
 *  establish, so both receipts end the same way. A manager pidfile that holds no pid makes `down`
 *  refuse too, so the steps are then the ones that work: the check only the operator can make, then
 *  removing that file and running `up` again. */
export function detachedNext(status: Pick<DetachedStatus, "root" | "machineHome" | "manager"> & { controlPlane: boolean; unattributableManager?: string; noManager?: boolean }, space: string): Block[] {
  const cmd = displayCmd();
  if (status.unattributableManager !== undefined) {
    const up = `${cmd} up${status.root ? ` --root ${shellWord(status.root)}` : ""}`;
    const steps = unattributableRecordSteps("manager", status.unattributableManager);
    return [
      { kind: "lines", lines: [steps.check] },
      { kind: "commands", items: [steps.removal, status.noManager ? { command: `${up} --no-manager`, description: "Then refresh the stack without a manager" } : { command: up, description: "Then start the manager" }] },
    ];
  }
  const items = status.manager && status.controlPlane ? [{ command: `${cmd} spawn --space ${space}`, description: "Launch your default agent" }] : [];
  const where = status.root ? ` from ${oneLine(status.root)}` : "";
  if (!status.machineHome) items.push({ command: `${cmd} down`, description: `Stop the stack${where}` });
  else if (status.manager) items.push({ command: `${cmd} down --preserve-state`, description: `Stop the stack${where}` });
  else items.push({ command: `${cmd} up`, description: `Start its manager, which \`${cmd} down --preserve-state\` needs` });
  return [{ kind: "commands", items }];
}
