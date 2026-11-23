import type { ConnectorInventory } from "./connector-inventory.js";
import type { CredentialRenewal } from "./credential-renewal.js";
import type { GoalWriter } from "./goal-writer.js";
import type { HarnessResolution } from "./harness-resolution.js";
import type { LeaseKeeper } from "./lease-keeper.js";
import type { SeatLaunch } from "./seat-launch.js";
import type { ServePlane } from "./serve-plane.js";

/** The Manager's parts, by name. The Manager builds every part, then fills this record at the end of
 *  its constructor, so a part reads a peer from it at use and never in its own constructor. Each part
 *  types its view as a `Pick` of the peers it calls. */
export interface ManagerParts {
  connectorInventory: ConnectorInventory;
  credentialRenewal: CredentialRenewal;
  goalWriter: GoalWriter;
  harnessResolution: HarnessResolution;
  lease: LeaseKeeper;
  seatLaunch: SeatLaunch;
  servePlane: ServePlane;
}
