/**
 * A stand-in for a suite that owns a smoke broker and then dies without tearing it down.
 *
 * It mints its store dir through the shared token exactly as a migrated suite does, so the dir
 * records THIS process as the owner, spawns the broker, prints the pids, and then holds. The test
 * SIGKILLs it, which is the one case the teardown helper cannot cover, and the broker is left
 * genuinely orphaned with its owner's pid still written into its path. That is the only state in
 * which the reaper is allowed to act.
 *
 * The broker is a plain child, not detached: SIGKILL on this process does not take its children with
 * it, so the broker survives and is reparented, which is exactly how a real orphan arises.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SMOKE_BROKER_TOKEN } from "@cotal-ai/smoke-kit";

const port = await new Promise((res, rej) => {
  const s = createServer();
  s.once("error", rej);
  s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => res(p)); });
});
const dir = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
writeFileSync(join(dir, "server.conf"), `port: ${port}\njetstream { store_dir: "${join(dir, "js")}" }\n`);
const broker = spawn("nats-server", ["-c", join(dir, "server.conf")], { stdio: "ignore" });
await new Promise((r) => setTimeout(r, 1200));
console.log(JSON.stringify({ ownerPid: process.pid, brokerPid: broker.pid, dir }));
setInterval(() => {}, 1 << 30);
