/** Broker-free regression for the remote supervisor's resolved exchange URL snapshot. */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "cotal-supervise-target-home-"));
const root = mkdtempSync(join(tmpdir(), "cotal-supervise-target-root-"));
const previousHome = process.env.COTAL_HOME;

try {
  process.env.COTAL_HOME = home;
  mkdirSync(join(root, ".cotal"), { recursive: true });

  const { recordMesh } = await import("@cotal-ai/workspace");
  const { superviseTarget } = await import("../src/commands.js");
  const space = "targetbinding";
  const firstUrl = "https://first-auth.example.test";
  const secondUrl = "https://second-auth.example.test";
  const userAuth = (url: string) => ({
    provider: "cotal",
    idp: { url: "https://idp.example.test", issuer: "https://idp.example.test", audience: "cotal" },
    endpoints: { url },
    remote: true as const,
  });

  recordMesh({
    space,
    server: "wss://broker.example.test",
    root,
    mode: "user",
    userAuth: userAuth(firstUrl),
    tlsRequired: true,
    ts: new Date().toISOString(),
  });
  const resolved = superviseTarget({ space }, root);

  // Simulate the registry changing after resolution. The manager startup must carry the exchange
  // pin from `resolved`, not perform another registry lookup and splice two target generations.
  recordMesh({
    space,
    server: "wss://broker.example.test",
    root,
    mode: "user",
    userAuth: userAuth(secondUrl),
    tlsRequired: true,
    ts: new Date().toISOString(),
  });

  assert.equal(resolved.remoteUser, true);
  assert.equal(resolved.agentBearerExchangeUrl, firstUrl);
  assert.equal(superviseTarget({ space }, root).agentBearerExchangeUrl, secondUrl);
  console.log("supervise target binding: 3 passed, 0 failed");
} finally {
  if (previousHome === undefined) delete process.env.COTAL_HOME;
  else process.env.COTAL_HOME = previousHome;
  rmSync(root, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
}
