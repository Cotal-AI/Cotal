import { closeSync, constants, fstatSync, linkSync, lstatSync, openSync, readdirSync, realpathSync, unlinkSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { lockExclusiveNb } from "./host.js";
import { capabilityToken, isSeatId } from "./record.js";
import { validSharedGeneration } from "./shared-controller-claim.js";
import { readDarwinControllerClaim, type DarwinControllerClaim } from "./shared-controller-claim-darwin.js";
import { darwinHostTransport } from "./shared-control-darwin.js";
import { darwinSharedIdentity } from "./shared-identity-darwin.js";
import { darwinCustodianIdentity, darwinSeatIsolation } from "./shared-lifetime-darwin.js";
import { serveSharedHost } from "./shared-host-v2.js";
import type { HostRecords } from "./shared-platform.js";
import { readPrivateRecord, sharedHostRecord, sharedSeatRecord, SHARED_MULTIPLEX_VERSION, writePrivateRecord } from "./shared-record.js";

function privateRoot(path: string, uid: number): void {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.uid !== uid || (stat.mode & 0o777) !== 0o700 || realpathSync.native(path) !== path)
    throw new Error("unverified Darwin PTY custody directory");
}

function publishHostRecord(path: string, host: unknown): void {
  const temp = join(dirname(path), `.host-${capabilityToken()}`);
  writePrivateRecord(temp, host);
  try { linkSync(temp, path); }
  finally { unlinkSync(temp); }
}

/** The private retained entry verifies the LaunchAgent and creates the private generation directory. */
export async function serveDarwinSharedHost(
  root: string, generation: string, scope: string, socket: string, holdLaunchLease: () => { release(): void },
): Promise<void> {
  const identity = darwinSharedIdentity.current();
  if (!identity || !validSharedGeneration(generation) || basename(root) !== generation ||
      !/^ai\.cotal\.pty\.[a-f0-9]{32}$/.test(scope) || basename(socket) !== `p-${scope.slice(-32)}.sock`)
    throw new Error("unverified Darwin PTY host identity");
  const lineage = dirname(root), path = sharedHostRecord(root);
  privateRoot(lineage, identity.uid);
  privateRoot(root, identity.uid);
  const fd = openSync(join(root, "host.lock"), constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
  try {
    const lock = fstatSync(fd);
    if (!lock.isFile() || lock.uid !== identity.uid || (lock.mode & 0o777) !== 0o600 || !lockExclusiveNb(fd) ||
        lstatSync(path, { throwIfNoEntry: false })) throw new Error("Darwin PTY host custody is already held");
    const { pid, start, bootId } = identity;
    const protocol = SHARED_MULTIPLEX_VERSION;
    const host = { version: protocol, protocol, pid, start, bootId, scope, token: capabilityToken() };
    const launchState = (id: string) => lstatSync(dirname(sharedSeatRecord(root, id)), { throwIfNoEntry: false }) ? "unknown" : "absent";
    const records: HostRecords<DarwinControllerClaim> = {
      readClaim: () => readDarwinControllerClaim(lineage, identity.uid),
      acceptsLaunch: (_claim): _claim is DarwinControllerClaim => false,
      launchState,
      reserve: id => launchState(id) === "unknown" ? "unknown" : "not-admitted",
      publishHost: () => publishHostRecord(path, host),
      removeHost() {
        if (readdirSync(root).some(isSeatId)) return;
        if (JSON.stringify(readPrivateRecord(path, 1024)) === JSON.stringify(host)) unlinkSync(path);
      },
    };
    // Admission stays closed until the explicit stop and removal paths can prove parity.
    await serveSharedHost({ host, generation, socket, address: socket, transport: darwinHostTransport,
      writer: darwinSharedIdentity, records, childIdentity: darwinCustodianIdentity(identity), holdLaunchLease, eligiblePayload: () => false,
      isolate: (_id, reservation) => darwinSeatIsolation(root, socket, observation => {
        if (observation.observedDetachedSurvivors !== undefined)
          reservation.appendLog?.(`observed detached PTY survivors: ${observation.observedDetachedSurvivors}\n`);
      }),
    });
  } finally { closeSync(fd); }
}
