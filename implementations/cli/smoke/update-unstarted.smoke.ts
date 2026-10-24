/** A configure-only project has no registry row, but update must still check for live custody. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MeshTarget } from "@cotal-ai/workspace";
import { isStoppedLocalMesh } from "../src/commands/update.js";

const root = mkdtempSync(join(tmpdir(), "cotal-update-unstarted-"));
const prior = process.env.COTAL_HOME;
process.env.COTAL_HOME = join(root, "home");
mkdirSync(join(root, ".cotal", "agents"), { recursive: true });
const listener = createServer((socket) => socket.end());
await new Promise<void>((resolve, reject) => {
  listener.once("error", reject);
  listener.listen(0, "127.0.0.1", resolve);
});
const address = listener.address();
assert.ok(address && typeof address !== "string");
const target: MeshTarget = {
  root,
  server: `nats://127.0.0.1:${address.port}`,
  space: `update-${randomUUID()}`,
  mode: "open",
  tlsRequired: false,
  personaRoot: join(root, ".cotal", "agents"),
  source: "local-space",
};
try {
  assert.equal(await isStoppedLocalMesh(target), false, "a live listener prevents an unstarted-project shortcut");
  await new Promise<void>((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
  assert.equal(await isStoppedLocalMesh(target), true, "an unregistered project with no listener or supervisor has no custody");
  for (const source of ["flag-server", "flag-space-override", "registry", "current"] as const)
    assert.equal(await isStoppedLocalMesh({ ...target, source }), false, `${source} requires a local registration`);
  console.log("update-unstarted.smoke: 6 checks passed");
} finally {
  if (listener.listening) await new Promise<void>((resolve) => listener.close(() => resolve()));
  if (prior === undefined) delete process.env.COTAL_HOME;
  else process.env.COTAL_HOME = prior;
  rmSync(root, { recursive: true, force: true });
}
