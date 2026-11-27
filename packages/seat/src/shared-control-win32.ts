import { observeWindowsProcess, windowsUserSid, type PipePeer } from "./host.js";
import { SHARED_CONTROL_PROTOCOL } from "./shared-control-protocol.js";
import type { SharedWriterProof } from "./shared-control-server.js";
import { SharedController } from "./shared-controller.js";
import { dialSharedWindowsPipe, listenSharedWindowsPipe } from "./shared-pipe-win32.js";
import type { ExactIdentity, HostTransport, IdentityProof, VerifiedHost } from "./shared-platform.js";

export interface WindowsSharedIdentity extends ExactIdentity { user: string; session: number }
type WindowsPeer = Omit<PipePeer, "fd">;
type WindowsAddress = Readonly<{ pipe: string; session: number }>;

export interface WindowsHostAuthority extends WindowsAddress {
  readonly task: string;
  /** Recheck the exact task receipt and retained host proof, without starting or stopping it. */
  verify(identity: WindowsSharedIdentity): void;
}

export type VerifiedWindowsHost = VerifiedHost<WindowsSharedIdentity, WindowsHostAuthority>;

export const windowsWriterProof: IdentityProof<WindowsSharedIdentity> & SharedWriterProof<WindowsSharedIdentity, WindowsPeer> = {
  current() {
    try {
      const row = observeWindowsProcess(process.pid);
      if (row) return { pid: process.pid, start: row.birth, user: row.user, session: row.session };
    } catch { /* Native observation may be denied. */ }
    return undefined;
  },
  same: (a, b) => a.pid === b.pid && a.start === b.start && a.user === b.user && a.session === b.session,
  observe(identity) {
    try {
      const row = observeWindowsProcess(identity.pid);
      if (!row || row.birth !== identity.start) return "gone";
      return row.user === identity.user && row.session === identity.session ? "live" : "unknown";
    } catch { return "unknown"; }
  },
  matchesPeer(peer, identity) {
    return peer.pid === identity.pid && peer.birth === identity.start && peer.user === identity.user &&
      identity.user === windowsUserSid() && windowsWriterProof.observe(identity) === "live";
  },
};

export const windowsHostTransport: HostTransport<WindowsAddress, VerifiedWindowsHost, WindowsPeer> = {
  async dial(address, host, timeoutMs) {
    const { identity, authority } = host;
    if (host.protocol !== SHARED_CONTROL_PROTOCOL || address.pipe !== authority.pipe || address.session !== authority.session ||
        address.session !== identity.session || identity.user !== windowsUserSid() || windowsWriterProof.observe(identity) !== "live")
      throw new Error("shared PTY host authority or lifetime is unknown");
    authority.verify(identity);
    return dialSharedWindowsPipe(address.pipe, identity, timeoutMs);
  },
  listen(address, accept, ready) {
    let resolve!: () => void, reject!: (error: unknown) => void;
    const closed = new Promise<void>((done, failed) => { resolve = done; reject = failed; });
    const listener = listenSharedWindowsPipe(address.pipe, address.session, accept, reject);
    try { ready(); }
    catch (error) { listener.close(); throw error; }
    return { closed, close() { listener.close(); resolve(); } };
  },
};

export function windowsSharedController(host: VerifiedWindowsHost): SharedController {
  const recorded = { ...host, identity: { ...host.identity }, authority: { ...host.authority } };
  return new SharedController({ ...recorded.identity, protocol: recorded.protocol, token: recorded.token },
    timeout => windowsHostTransport.dial(recorded.authority, recorded, timeout));
}
