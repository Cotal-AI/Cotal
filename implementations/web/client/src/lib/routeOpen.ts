// What a route asks of the controller: a channel route opens that channel and every other route
// closes whatever is open. The shell calls this when the route changes, so the store's open channel
// follows the address.
import type { Controller } from "../state/controller.js";
import type { Route } from "./route.js";

/** The channel a route opens, or null when the route is not a channel. */
export function openTarget(r: Route): string | null {
  return r.view === "channel" ? r.channel : null;
}

/** Hand a target to the controller. Before the dashboard has started there is no controller and
 *  nothing happens: the shell calls this again when one exists. A refused history read never rejects
 *  `open()`, so a rejection is a defect, and it is logged rather than left unhandled. */
export function syncOpen(controller: Controller | null, target: string | null): void {
  controller?.open(target).catch((err) => console.error("opening a channel failed:", err));
}
