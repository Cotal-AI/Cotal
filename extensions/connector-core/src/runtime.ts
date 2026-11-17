import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { CONTROL_PROTOCOL_VERSION, ensureControlSocketDir, type ControlEndpoint } from "@cotal-ai/core/control-exchange";

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
export const SUN_PATH_MAX_BYTES = process.platform === "darwin" ? 104 : 108;

/**
 * A connector's local control endpoint: the OS path its lifecycle hooks (and the manager's
 * cooperative-shutdown and session calls) connect to, the key both ends prove they hold without
 * sending it, and the exchange version (see `@cotal-ai/core`'s `control-exchange.ts`).
 *
 * The path id is `sha256(space\0name\0pid\0token)` (base64url, 22 characters): unguessable and
 * collision-free without leaking identity. Off Windows the socket sits in `cotal-ctl-<uid>` under
 * `tmpdir()`, a directory only this user can enter, made here with mode 0700 and checked for owner
 * and mode, as the server checks it again before it binds and every client before it connects.
 * Another user therefore cannot create a name there, even after the server has exited. Windows has
 * no filesystem socket Node can bind, so the path is a named pipe (`\\.\pipe\…`) in the global
 * namespace, where any local process can take a free name. There the exchange is the boundary: a
 * stand-in that cannot prove it holds the key gets no request and its reply is never used.
 *
 * Minted ONCE at launch (in the manager's process, via the connector's `buildLaunch`). The path
 * reaches the child in `COTAL_CONTROL_SOCKET`; the key and version reach it in the launch material,
 * never in argv; the manager keeps all three in memory. (`process.pid` is just generation-time
 * entropy: the value flows by env, so it never has to match across processes.)
 */
export function controlEndpoint(
  space: string,
  name: string,
  token: string = randomBytes(32).toString("base64url"),
): ControlEndpoint {
  const id = createHash("sha256")
    .update(`${space}\0${name}\0${process.pid}\0${token}`)
    .digest("base64url")
    .slice(0, 22);
  if (process.platform === "win32") return { path: `\\\\.\\pipe\\cotal-${id}`, token, version: CONTROL_PROTOCOL_VERSION };
  const tail = `/${controlDirName()}/${id}.sock`;
  const path = join(tmpdir(), tail.slice(1));
  // `id` is a fixed 22 characters, so `tmpdir()` and the uid are the only variable parts of this
  // path. A TMPDIR pointed inside a deep working copy spends the sun_path budget silently, and the
  // overrun then surfaces as an `EINVAL` from a bind that cannot say why. Refuse HERE, where the
  // path, its length and the limit are all in hand.
  const bytes = Buffer.byteLength(path);
  if (bytes > SUN_PATH_MAX_BYTES) {
    throw new Error(
      `control socket path is ${bytes} bytes, over the ${SUN_PATH_MAX_BYTES}-byte sun_path limit on ` +
        `${process.platform}, so it cannot be bound and the kernel would report only EINVAL: ${path}. ` +
        `The socket name is a fixed ${tail.length} bytes, so the temp root must be at most ` +
        `${SUN_PATH_MAX_BYTES - tail.length} bytes — TMPDIR is ${Buffer.byteLength(tmpdir())} bytes ` +
        `(${tmpdir()}). Point TMPDIR at a shorter directory.`,
    );
  }
  ensureControlSocketDir(path);
  return { path, token, version: CONTROL_PROTOCOL_VERSION };
}

/** The per-user directory control sockets live in off Windows. */
const controlDirName = (): string => `cotal-ctl-${process.getuid!()}`;
