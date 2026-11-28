import type { Socket } from "node:net";
import { join } from "node:path";
import { runCustodian, type CustodianIdentity } from "./custodian.js";
import { capabilityToken } from "./record.js";
import { createHostControl, type SharedSeatAcceptor, type SharedWriterProof } from "./shared-control-server.js";
import type { SharedLaunchPayload } from "./shared-control-protocol.js";
import type { ExactIdentity, HostListener, HostRecords, HostTransport, SeatIsolation, SeatReservation } from "./shared-platform.js";
import type { PreparedSeat } from "./shared-prepared-seat.js";

interface SharedHostOptions<Claim extends ExactIdentity, Child extends ExactIdentity, Address, Host, Peer> {
  host: ExactIdentity & { token: string };
  generation: string;
  socket: string;
  address: Address;
  transport: HostTransport<Address, Host, Peer>;
  writer: SharedWriterProof<Claim, Peer>;
  records: HostRecords<Claim>;
  childIdentity?: CustodianIdentity<Child>;
  holdLaunchLease?(): { release(): void };
  eligiblePayload(payload: SharedLaunchPayload): boolean;
  isolate(id: string, reservation: SeatReservation): SeatIsolation<Child>;
}

function logFault(error: unknown): void {
  try { console.error("shared PTY host:", error); } catch { /* The service log must not stop a host. */ }
}

export async function serveSharedHost<Claim extends ExactIdentity, Child extends ExactIdentity, Address, Host, Peer>(
  options: SharedHostOptions<Claim, Child, Address, Host, Peer>,
): Promise<void> {
  const { generation, host, records, writer, socket, address, transport } = options;
  const sessions = new Map<string, SharedSeatAcceptor>();
  const connections = new Set<Socket>();
  let server: HostListener;
  let held = 0, closing = false, idle: ReturnType<typeof setTimeout>;
  const armIdle = () => { idle = setTimeout(() => {
    if (held) return;
    closing = true;
    server.close();
    for (const connection of connections) connection.destroy();
  }, 5_000); };
  const launch = async (id: string, payload: SharedLaunchPayload, authorize: () => void): Promise<"admitted" | "not-admitted" | "unknown"> => {
    const claimant = records.readClaim(), reservation = records.reserve(id);
    if (typeof reservation === "string") return reservation;
    const refuse = () => {
      try { reservation.refuse(); } catch (error) { logFault(error); }
      return "not-admitted" as const;
    };
    if (closing || !records.acceptsLaunch(claimant, generation) || !options.eligiblePayload(payload)) return refuse();
    let isolation: SeatIsolation<Child>;
    try { isolation = options.isolate(id, reservation); }
    catch { return refuse(); }
    let gate: PreparedSeat<Child> | undefined, cleaned = false;
    ++held;
    clearTimeout(idle);
    const settled = () => {
      if (cleaned) return;
      cleaned = true;
      sessions.delete(id);
      void isolation.drain().then(() => { if (--held === 0) armIdle(); }, logFault);
    };
    const { spec, name, cwd, artifactRoot } = payload;
    try {
      await runCustodian({ ...spec, id, name, cwd, artifactRoot, env: spec.env ?? {}, socket,
        token: capabilityToken(), recordPath: reservation.recordPath, logPath: join(reservation.directory, "custodian.log") }, {
        bind: accept => sessions.set(id, accept),
        settled,
        record: reservation.publish,
        identity: options.childIdentity,
        ...(reservation.publishExit && { publishExit: reservation.publishExit }),
        ...(reservation.appendLog && { appendLog: reservation.appendLog }),
        prepare: async () => {
          const staged = gate = await isolation.prepare(payload);
          return { ...staged, get commitAttempted() { return staged.commitAttempted; }, commit(record) { return staged.commit(() => {
            authorize();
            const current = records.readClaim();
            if (!records.acceptsLaunch(current, generation) || !writer.same(current, claimant))
              throw new Error("shared PTY controller lifetime is unknown");
            // Writer verification, record publication and dispatch occupy one synchronous turn.
            record();
          }); } };
        },
      });
      return "admitted";
    } catch (error) {
      logFault(error);
      if (gate?.commitAttempted || (!gate && isolation.prepareFailure(error) === "unknown")) return "unknown";
      try { gate?.abort(); }
      catch (rollback) { logFault(rollback); return "unknown"; }
      settled();
      return refuse();
    }
  };
  const launchWithLease: typeof launch = async (id, payload, authorize) => {
    let lease: ReturnType<NonNullable<typeof options.holdLaunchLease>> | undefined;
    try { lease = options.holdLaunchLease?.(); }
    catch { return "unknown"; }
    // Release after dispatch or rollback. If it was ambiguous, its reservation remains evidence.
    try { return await launch(id, payload, authorize); }
    finally { lease?.release(); }
  };
  const accept = createHostControl({ host, writer, closing: () => closing, authorized: () => records.readClaim(), acceptSeat: id => sessions.get(id),
    launch: options.holdLaunchLease ? launchWithLease : launch,
    launchState: id => records.launchState(id),
  });
  process.on("uncaughtException", logFault);
  try {
    const serverLifetime = transport.listen(address, (connection, peer) => {
      connections.add(connection);
      connection.once("close", () => connections.delete(connection));
      accept(connection, peer);
    }, () => { records.publishHost(); armIdle(); });
    server = serverLifetime;
    await serverLifetime.closed;
    records.removeHost();
  } finally { process.off("uncaughtException", logFault); }
}
