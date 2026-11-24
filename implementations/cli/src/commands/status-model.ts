import {
  type RolledBackRun,
  brokerAddressForDisplay,
  jsonFlag,
  plainFlag,
  preflightTarget,
  serverFlag,
  spaceFlag,
  type BrokerCheck,
  type MeshEntry,
  type MeshTarget,
  type OutputWarning,
} from "@cotal-ai/workspace";
import { type CliProvenance } from "../lib/version.js";
import { type MachineStatus } from "../lib/status.js";
import { type DeliveryResponderState } from "../lib/delivery-responder.js";
import { type StoreWriteObservation } from "../lib/broker-store-health.js";
import { serviceDefinitionProjection } from "../lib/service-definitions.js";
import { instanceProjection } from "../lib/service-instances.js";
import { additiveTeamRecordedState } from "../lib/team-additive-attempt.js";
import { type StackOperationBlock, type StackRole } from "../lib/stack-journal.js";

/** `--components` is the fail-loud health pass with a machine-readable EXIT DISPOSITION. Bare
 * `status` is a broad, recovery-oriented report: it exits 0, or 4 when it could not read part of what
 * it reports; this explicit mode is for an operator or monitor that needs a component state per
 * component and an exit code to branch on.
 *
 * THAT DIVISION IS ABOUT EXIT CODES AND COMPLETENESS, NOT ABOUT TRUTHFULNESS, and #1576 is where the
 * difference bit. Bare status printed `delivery  running (pid N)` over a daemon whose responder had
 * never bound — not a broad answer but a specific and wrong one, identical to the line it prints
 * when delivery is fully healthy, for 22 hours, while spawn/retirement/join all failed. A broad
 * diagnostic may omit an axis; it may not claim one it never checked. So bare status stays broad,
 * and the delivery row names the responder state it actually read (or says plainly that it did not
 * read it, and points here). */
export const statusFlags = [
  spaceFlag,
  serverFlag,
  { name: "on", type: "string", value: "<manager-instance>", description: "named agent: inspect one manager instance" },
  { name: "creds", type: "string", value: "<file>", description: "explicit credential file (unsupported for status)" },
  { name: "all", type: "boolean", description: "check every recorded mesh, not only the selected one, and report every row in full" },
  { name: "wide", type: "boolean", description: "report every row in full: each known agent application, each extension, and the spaces under their broker addresses" },
  { name: "verbose", short: "v", type: "boolean", description: "include installation paths, local records and detailed diagnostics" },
  { name: "components", type: "boolean", description: "probe manager, delivery, web, and registered broker component health (exit: 0 serving, an intentionally omitted manager, or the optional dashboard not installed or not started; 1 absent; 2 present but not serving; 3 probe refused)" },
  jsonFlag,
  plainFlag,
] as const;

/** The mesh `spawn` would load personas from, resolved ONCE for the whole run.
 *
 *  Two sections need this answer — "This Folder" (to say whether its catalog is the one that
 *  launches) and "Selected Mesh" — and resolution is NOT side-effect-free: `resolveMeshTarget`
 *  prunes a stale registry entry as it fails. Resolving twice would let the first call prune what
 *  the second then reports as simply absent, so the two sections would describe different worlds.
 *  Resolve once, share the outcome, including the failure. */
export type Selected = { ok: true; target: MeshTarget } | { ok: false; error: unknown };
export type SelectedPreflight = Awaited<ReturnType<typeof preflightTarget>> | undefined;

/** A project root with an empty `.cotal/` and no registration or prepared space. The resolver
 *  gives it the default broker address, which any broker may hold, so status selects no space for
 *  it and dials nothing. A root whose records name no space is refused by the resolver instead, and
 *  status uses that refusal. */
export class UnregisteredRoot {
  constructor(readonly root: string) {}
}

/** What a persona catalog holds: whether its `default` passes the loader spawn uses, and how many of
 *  the demo team's personas do. A catalog directory that exists and cannot be read is `unreadable`,
 *  with no demo count and the error. */
export interface PersonaCatalog {
  root: string;
  default: "valid" | "invalid" | "missing" | "unreadable";
  demo: number | null;
  error: string | null;
}

/** One local process row: the state word, the pid it recorded, and what else the row knows. */
export interface ProcessRow {
  name: string;
  state: "running" | "stopped" | "not-serving" | "unknown" | "unreadable";
  pid: number | null;
  detail: string | null;
  /** The nats summary's source. Older serialized reports and other components may omit it. */
  source?: "legacy-pidfile" | "owned-service";
  legacyPidfile?: { state: ProcessRow["state"]; pid: number | null; detail: string | null };
  ownedService?: Pick<ReturnType<typeof instanceProjection>, "definition" | "instanceId" | "observedProcess" | "recordedState" | "pid"> | null;
}

export interface OwnedServiceStatus {
  space: string | null;
  state: "read" | "partial" | "not-checked";
  observedAt: string;
  atomicSnapshot: false;
  definitions: ReturnType<typeof serviceDefinitionProjection>[] | null;
  instances: ReturnType<typeof instanceProjection>[] | null;
  scope: "selected-space local owned records; no remote registration or fresh endpoint probe";
}

/** Everything bare `status` reports, in the order it prints. The JSON envelope carries it as
 *  `result`, and the report is built from it, so the two cannot disagree. A part that could not be
 *  read is null or carries its error, and is named in the warnings. */
export interface StatusResult {
  kind: "infrastructure";
  machine: {
    version: string;
    node: string;
    platform: string;
    install: CliProvenance;
    nats: MachineStatus["nats"];
    natsServer: MachineStatus["natsServer"];
    natsProblem: MachineStatus["natsProblem"];
    /** One row per piece a connector or client provider installed. `client` marks an ACP client's row. */
    integrations: { name: string; state: "ok" | "warn" | "error" | "off"; text: string; client?: true }[];
    connectors: { name: string; requires: string[]; missing: string[] }[] | null;
    /** For a resolved space, the bare direct launch's persona and effective harness, including its pin. */
    defaults: { harness: string | null; persona: string | null } | null;
    skills: { state: "current" | "not-installed" | "behind" | "unreadable"; total: number; behind: number; retired: number; error: string | null; setupBlocked?: string };
    web: { installed: boolean | null; installedError: string | null; url: string | null; urlError: string | null };
  };
  extensions: { root: string; items: { package: string; label: string; version: string }[] | null };
  folder: {
    root: string;
    auth: { state: "space" | "spaces" | "none" | "unreadable"; spaces: string[]; userAuth: boolean; error: string | null };
    personas: PersonaCatalog;
    launches: boolean | null;
    processes: ProcessRow[] | null;
    processSpace: string | null;
    storedState: boolean;
    /** Whether this root records a controller stack for the process space. The nats summary uses
     *  its owned broker observation and retains the legacy pidfile observation separately. */
    controllerStack: boolean;
    /** Presence of a folder's journal, even when it cannot be parsed or read. Older inputs may omit it. */
    stackJournal?: "present" | "absent" | "unreadable";
    /** Whether that controller stack was started with `--no-manager`, so it runs no manager by choice. */
    noManager: boolean;
    /** The service of this space, outside that stack, whose process runs this root's manager, as a
     *  `manager` preset started here does. Null when none does; older inputs may omit it. */
    managerService?: { definition: string; instanceId: string } | null;
    /** The services of this space, outside that stack, whose processes run this root's records, as
     *  `up` names them before it refuses to start the stack beside them. Null when the records could
     *  not be read; older inputs may omit it. */
    heldServices?: { definition: string; instanceId: string; record: string; pid: number }[] | null;
    /** The member that keeps `up` and `down` from settling that stack's last operation, which ended
     *  with no recorded outcome, with why and the way out their refusal names. Null when none does;
     *  older inputs may omit it. */
    stackBlock?: StackOperationBlock | null;
    /** That stack's last `up` or `down` when it ended with no recorded outcome part way, with the
     *  members left running and stopped. Null when there is none; older inputs may omit it. */
    stackUnfinished?: { kind: "up" | "down"; id: string; running: StackRole[]; stopped: StackRole[]; noManager: boolean } | null;
  };
  meshes: {
    current: string | null;
    currentRecorded: boolean;
    /** Whether the selection names a space `cotal space create` prepared and no `cotal up` started. */
    currentPrepared: boolean;
    /** Whether any local space is prepared, including one that is not selected. Older inputs may omit it. */
    hasPrepared?: boolean;
    /** Whether that prepared space's controller stack ran and was stopped. */
    currentStopped: boolean;
    /** This folder's space when a command without `--space` targets it here instead of `current`, as
     *  `cotal space` gives it, else null. Older inputs may omit it. */
    folder?: string | null;
    unreadable: { file: string; error: string }[];
    items: {
      space: string;
      server: string | null;
      mode: MeshEntry["mode"];
      root: string;
      origin: MeshEntry["origin"] | null;
      tlsRequired: boolean;
      eventsRequired: boolean;
      modeChecked: boolean;
      current: boolean;
      check: BrokerCheck | "not-checked";
      catalog: { name: string | null; fetchedAt: string | null; error: string | null } | null;
    }[];
    /** `account` is the IdP subject whose catalog this is, which its error line names instead of the
     *  token URL. Older inputs may omit it. */
    catalogs: { idp: string; account?: string; state: string; error: string | null }[];
  };
  selected: SelectedResult;
  /** Older serialized/read-view inputs may omit this observation; absence is never an empty inventory. */
  services?: OwnedServiceStatus;
  /** Selected folder's local boot intents, not a live broker or ownership census. */
  bootAttempts?: { root: string; state: "read" | "partial" | "not-checked"; observedAt: string; unsettled: { deploymentId: string; space: string; server: string; createdAt: string }[]; additive: { deploymentId: string; space: string; server: string; createdAt: string; recordedState: ReturnType<typeof additiveTeamRecordedState> }[]; unreadable: string[]; elsewhere: { deploymentId: string; root: string }[] };
  /** This folder's maintenance journal: a preserved cut, a restore or a resume, with the full attempt
   *  a recovery command names. Null when the root holds none; older inputs may omit it.
   *  `rolledBackRuns` names the runs a restore over a newer cut rolled back, and `rolledBackRunsMore`
   *  counts those it did not list. */
  maintenance?: { root: string; space: string | null; state: string; attemptId: string | null; next: string | null; rolledBackRuns?: readonly RolledBackRun[]; rolledBackRunsMore?: number } | null;
  /** A store write failure the selected space's running local broker logged, or a store over its
   *  recorded cap; older inputs may omit it. */
  store?: StoreWriteObservation;
  /** One probe of the selected space's running stack manager's own endpoint. Its process record alone
   *  stays `running` while it hangs; absent when no stack manager runs, and older inputs may omit it. */
  stackManager?: { instanceId: string; pid: number; endpoint: ManagerEndpoint };
  /** The selected space's manager endpoint when this stack intentionally omitted its manager. */
  outsideStackManager?: ManagerObservation;
  hints: string[];
}

export type SelectedResult =
  | {
      resolved: false;
      code: string;
      message: string;
      channelSeedBlocksRestart?: true;
      space?: string;
      root?: string;
      /** In a copy or a moved folder, the folder its records were recorded at, and `space` the space
       *  they name, which the commands run here refuse on. */
      recordedRoot?: string;
    }
  | {
      resolved: true;
      space: string;
      server: string | null;
      mode: MeshTarget["mode"];
      source: string;
      root: string;
      /** The project folder is gone while this machine still records the space's stack there. */
      rootGone: boolean;
      tlsRequired: boolean;
      eventsRequired: boolean;
      idp: string | null;
      personas: PersonaCatalog;
      connection: string;
      channelSeedBlocksRestart?: true;
      /** The stopped process holding a loopback broker's listener, when `connection` is `broker-stopped`. */
      brokerPid?: number;
      staleRecord: boolean;
      login: { idp: string; subject: string | null; expiresAt: string | null; actor: "granted" | "not-granted" | "not-checkable" | null; grant: { label: string | null; read: string[]; post: string[]; scope: string[] } | null } | null;
      deliveryResponder: DeliveryResponderState | null;
      snapshot: { state: "read" | "unavailable" | "skipped"; reason: string | null };
      channels: { channel: string; messages: number }[] | null;
      membershipFeed: { entries: number; asOf: string | null } | null;
      /** Whether the space's streams are on its broker, read only where `cotal up` created them.
       *  When they are absent, `root` is this machine's stack of the space, null when none runs from
       *  here, and `stack` says whether it still runs members other than the broker, null when its
       *  records cannot be read. */
      spaceStreams: { state: "present" | "absent" | "not-checked"; root: string | null; stack: "running" | "stopped" | null };
      /** The bytes the space's account holds in the broker's JetStream file store, null when not read. */
      storedBytes: number | null;
    };

/** Collects what each reader could not read, so the report names it on its row and the run is
 *  reported partial rather than complete. */
export class Gaps {
  readonly warnings: OutputWarning[] = [];
  /** Two readers that hit the same part, such as one catalog read as the folder's and the selected
   *  mesh's, name it once. */
  add(code: string, message: string, target: unknown = null): void {
    if (this.warnings.some((w) => w.code === code && w.message === message)) return;
    this.warnings.push({ code, target, message });
  }
}

/** Keep unsafe stored addresses explicit without exposing their original text. */
export function displayStatusBroker(server: string, space: string, gaps: Gaps): string | null {
  const display = brokerAddressForDisplay(server);
  if (display !== undefined) return display;
  gaps.add("BROKER_ADDRESS_INVALID", `broker address for '${space}' cannot be displayed`, { space });
  return null;
}

type ManagerEndpoint = "answered" | "not-answering" | "unchecked";
export type ManagerObservation = { endpoint: ManagerEndpoint; instanceId?: string };
