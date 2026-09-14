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
/**
 * The longest control-socket path the kernel will actually bind, in BYTES.
 *
 * `sockaddr_un.sun_path` is 108 bytes on Linux and 104 on macOS, and overrunning it fails at the
 * bind with a bare `EINVAL` — an errno that names neither paths, nor lengths, nor sockets. The
 * connector then reads as broken when what is actually wrong is the directory it was handed.
 *
 * MEASURED, not assumed: on this Linux 6.12 box a 108-byte path binds and a 109-byte path fails
 * `EINVAL`, so the limit is INCLUSIVE and the whole 108 is usable. The darwin figure is the
 * documented `sun_path` size and is NOT measured here; it is the smaller of the two, so taking it
 * as the cap fails closed.
 */
const SUN_PATH_MAX_BYTES = process.platform === "darwin" ? 104 : 108;

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
  // `id` is a fixed 32 chars, so `tmpdir()` is the ONLY variable in this path: the tail
  // `/cotal-<id>.sock` is a constant 44 bytes, leaving 64 for the temp root on Linux. A TMPDIR
  // pointed inside a deep working copy spends that budget silently, and the overrun then surfaces
  // as an `EINVAL` from a bind that cannot say why. Refuse HERE, where the path, its length and the
  // limit are all in hand. win32 named pipes are not `sun_path` and carry no such limit.
  const bytes = Buffer.byteLength(path);
  if (process.platform !== "win32" && bytes > SUN_PATH_MAX_BYTES) {
    const tail = `/cotal-${id}.sock`.length;
    throw new Error(
      `control socket path is ${bytes} bytes, over the ${SUN_PATH_MAX_BYTES}-byte sun_path limit on ` +
        `${process.platform}, so it cannot be bound and the kernel would report only EINVAL: ${path}. ` +
        `The socket name is a fixed ${tail} bytes, so the temp root must be at most ` +
        `${SUN_PATH_MAX_BYTES - tail} bytes — TMPDIR is ${Buffer.byteLength(tmpdir())} bytes ` +
        `(${tmpdir()}). Point TMPDIR at a shorter directory.`,
    );
  }
  return { path, token };
}
