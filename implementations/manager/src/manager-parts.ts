import type { BrokerTransport } from "./broker-transport.js";
import type { ConnectorInventory } from "./connector-inventory.js";
import type { CredentialRenewal } from "./credential-renewal.js";
import type { GoalWriter } from "./goal-writer.js";
import type { HarnessResolution } from "./harness-resolution.js";
import type { LeaseKeeper } from "./lease-keeper.js";
import type { NamesCapacity } from "./names-capacity.js";
import type { PersonaCatalog } from "./persona-catalog.js";
import type { Preservation } from "./preservation.js";
import type { SeatLaunch } from "./seat-launch.js";
import type { SeatStop } from "./seat-stop.js";
import type { ServePlane } from "./serve-plane.js";
import type { SpawnGoal } from "./spawn-goal.js";

/** The Manager's parts, by name. The Manager builds every part, then fills this record at the end of
 *  its constructor, so a part reads a peer from it at use and never in its own constructor. Each part
 *  types its view as a `Pick` of the peers it calls. */
export interface ManagerParts {
  brokerTransport: BrokerTransport;
  connectorInventory: ConnectorInventory;
  credentialRenewal: CredentialRenewal;
  goalWriter: GoalWriter;
  harnessResolution: HarnessResolution;
  lease: LeaseKeeper;
  namesCapacity: NamesCapacity;
  personaCatalog: PersonaCatalog;
  preservation: Preservation;
  seatLaunch: SeatLaunch;
  seatStop: SeatStop;
  servePlane: ServePlane;
  spawnGoal: SpawnGoal;
}
