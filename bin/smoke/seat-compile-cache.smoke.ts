/**
 * The seat entry puts Node's compile cache in a per-user directory, and a cache it cannot open
 * costs one stderr line and nothing else.
 *
 * Parsing the connector's 5 MB bundle leaves about 5.7 MiB in the seat's main malloc arena for as
 * long as the seat lives. Node's compile cache removes the parse from every launch after the first,
 * which is why `dist/seat.cjs` exists at all: the cache covers modules compiled after it is
 * enabled, so it cannot be enabled from inside the bundle it needs to cover.
 *
 * Three things have to hold for that to pay off in production, and each is a cell below. The
 * directory survives a restart, so it is under the user's own Cotal directory and never a temp
 * directory a reboot clears. The cache is on disk before the seat is killed, because Node writes it
 * at a clean exit and a seat ends on a signal. And a directory the seat cannot write is not a seat
 * failure.
 *
 * Run: pnpm smoke:seat-compile-cache
 */
import { spawn } from "node:child_process";
import { existsSync, chmodSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { seatCompileCacheDir } from "@cotal-ai/connector-core/seat-cache";
import { userCotalDir } from "@cotal-ai/workspace";
import { createSuite } from "@cotal-ai/smoke-kit";

const { check, finish } = createSuite();
const SEAT = fileURLToPath(new URL("../../extensions/connector-claude-code/dist/seat.cjs", import.meta.url));
/** The seat's own line when it has no identity: proof it served, with or without a cache. */
const SERVING = /not a managed session/;

check("the cache directory is `compile-cache` under this user's Cotal directory",
  seatCompileCacheDir() === join(userCotalDir(), "compile-cache"), seatCompileCacheDir());
check("the cache directory is not in a temp directory",
  !seatCompileCacheDir().startsWith(tmpdir()), { dir: seatCompileCacheDir(), tmpdir: tmpdir() });
check("the seat entry is built", existsSync(SEAT), SEAT);

/** Run the seat entry with nothing inherited but PATH, wait for it to serve, kill it, and report
 *  what it printed. Killing it is the point: nothing here may depend on a clean exit. */
async function serveOnce(home: string, env: Record<string, string> = {}): Promise<{ stderr: string; served: boolean }> {
  const child = spawn(process.execPath, [SEAT], {
    env: { HOME: home, PATH: process.env.PATH ?? "", ...env },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  const served = await new Promise<boolean>((resolve) => {
    const done = setTimeout(() => resolve(false), 30_000);
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
      if (SERVING.test(stderr)) { clearTimeout(done); resolve(true); }
    });
    child.on("exit", () => { clearTimeout(done); resolve(SERVING.test(stderr)); });
  });
  child.kill("SIGKILL");
  return { stderr, served };
}

/** Every cache file Node wrote under `home`, by path. */
const cacheFiles = (home: string): string[] => {
  const root = join(home, ".cotal", "compile-cache");
  if (!existsSync(root)) return [];
  return readdirSync(root, { recursive: true, encoding: "utf8" })
    .map((entry) => join(root, entry))
    .filter((path) => statSync(path).isFile());
};

const sandbox = join(tmpdir(), `cotal-seat-cache-${process.pid}`);
rmSync(sandbox, { recursive: true, force: true });

// 1) A seat that is KILLED still leaves a cache behind: the entry flushes it after the bundle is
//    compiled, so the next seat reads it instead of parsing 5 MB again.
const warmHome = join(sandbox, "warm");
mkdirSync(warmHome, { recursive: true });
const cold = await serveOnce(warmHome);
check("a first seat serves", cold.served, cold.stderr.slice(0, 400));
const afterCold = cacheFiles(warmHome);
check("a killed seat has already written its compile cache", afterCold.length === 1, afterCold);
const coldSize = afterCold.length === 1 ? statSync(afterCold[0]!).size : 0;
check("the cache it wrote is the bundle's, not a stub", coldSize > 100_000, coldSize);

// 2) The second seat reads that cache. Node rewrites an entry only when it differs, so an
//    unchanged file is the observable that it was accepted rather than recompiled.
const warm = await serveOnce(warmHome);
check("a second seat serves", warm.served, warm.stderr.slice(0, 400));
const afterWarm = cacheFiles(warmHome);
check("the second seat reuses the cache rather than writing a new one",
  afterWarm.length === 1 && afterWarm[0] === afterCold[0] && statSync(afterWarm[0]!).size === coldSize, afterWarm);
check("neither seat printed a cache diagnostic", !/compile cache/.test(cold.stderr + warm.stderr), (cold.stderr + warm.stderr).slice(0, 400));

// 3) A cache directory the seat cannot create costs one line, and the seat serves anyway.
if (process.getuid?.() === 0) {
  check("an unwritable cache directory is reported and not fatal (skipped as root)", true);
} else {
  const blockedHome = join(sandbox, "blocked");
  mkdirSync(blockedHome, { recursive: true });
  chmodSync(blockedHome, 0o500);
  const blocked = await serveOnce(blockedHome);
  chmodSync(blockedHome, 0o700);
  check("a seat with an unwritable cache directory still serves", blocked.served, blocked.stderr.slice(0, 400));
  check("it says so once, with Node's own reason",
    (blocked.stderr.match(/compile cache unavailable, continuing without it: /g) ?? []).length === 1, blocked.stderr.slice(0, 400));
  check("it wrote no cache", cacheFiles(blockedHome).length === 0, cacheFiles(blockedHome));
}

// 4) An operator who turns the cache off gets no diagnostic: that is an answer, not a failure.
const offHome = join(sandbox, "off");
mkdirSync(offHome, { recursive: true });
const off = await serveOnce(offHome, { NODE_DISABLE_COMPILE_CACHE: "1" });
check("a seat with the cache disabled serves silently", off.served && !/compile cache/.test(off.stderr), off.stderr.slice(0, 400));
check("a disabled cache writes nothing", cacheFiles(offHome).length === 0, cacheFiles(offHome));

rmSync(sandbox, { recursive: true, force: true });
finish();
