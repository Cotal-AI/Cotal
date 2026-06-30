import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";

/**
 * A connector's local control endpoint: the OS path its lifecycle hooks (and the manager's
 * cooperative-shutdown call) connect to, plus the shared secret that authenticates the first frame.
 *
 * The path id is `sha256(space\0name\0pid\0token)` (base64url, ≤32) — unguessable and
 * collision-free without leaking identity; the 256-bit `token` is the actual auth boundary (the
 * server validates it with a constant-time compare before doing anything — see `control.ts`).
 *
 * Transport is per-platform but the same `node:net` path string drives both: win32 has no
 * filesystem AF_UNIX socket Node can bind, so the path is a named pipe (`\\.\pipe\…`) whose default
 * DACL lets ANY local process connect — which is exactly why the token, not the path, is the
 * security boundary there. POSIX uses a per-user `tmpdir` socket.
 *
 * Minted ONCE at launch (in the manager's process, via the connector's `buildLaunch`). Both ends —
 * the in-agent server that LISTENS and the short-lived hooks that CONNECT — then read `path`+`token`
 * from the child env (`COTAL_CONTROL_SOCKET`/`COTAL_CONTROL_TOKEN`), never recompute them from
 * public identity; the manager keeps them in memory for the cooperative shutdown. (`process.pid` is
 * just generation-time entropy — the value flows by env, so it never has to match across processes.)
 */
export function controlEndpoint(
  space: string,
  name: string,
  token: string = randomBytes(32).toString("base64url"),
): { path: string; token: string } {
  const id = createHash("sha256")
    .update(`${space}\0${name}\0${process.pid}\0${token}`)
    .digest("base64url")
    .slice(0, 32);
  const path =
    process.platform === "win32" ? `\\\\.\\pipe\\cotal-${id}` : join(tmpdir(), `cotal-${id}.sock`);
  return { path, token };
}
