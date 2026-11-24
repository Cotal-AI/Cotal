import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { savedProjectTrust } from "./trust.js";

/** Loaded into the pi that lists commands before launch: it trusts a project as a supervised seat
 *  does (extension.ts), so the list holds the project's templates and skills only when the seat's
 *  would. It keeps Pi's saved decision, and with none trusts nothing for this run. */
export default function trustAsASeat(pi: ExtensionAPI): void {
  pi.on("project_trust", async (event) => ((await savedProjectTrust(event.cwd)) === undefined ? { trusted: "no" } : { trusted: "undecided" }));
}
