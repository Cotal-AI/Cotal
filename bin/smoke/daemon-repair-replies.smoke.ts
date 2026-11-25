import assert from "node:assert/strict";
import { createServer, connect } from "node:net";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { once } from "node:events";
import { assertServiceRepairPair, readServiceRepair, repairReplies, serviceRepairFile, sourceDigest, type ServiceRepairIntent } from "../daemon/service-repair.js";

const root = mkdtempSync(join(tmpdir(), "reply-"));
const path = join(root, "s");
const peers = new Set<import("node:net").Socket>();
const server = createServer(peer => {
  peers.add(peer); peer.on("close", () => peers.delete(peer));
  let text = ""; peer.setEncoding("utf8");
  peer.on("data", chunk => {
    text += chunk;
    let newline: number;
    while ((newline = text.indexOf("\n")) !== -1) {
      const request = JSON.parse(text.slice(0, newline)) as { id: string };
      text = text.slice(newline + 1);
      if (request.id === "abort") setTimeout(() => {
        if (!peer.destroyed) peer.write('{"id":"prepare","ok":true}\n{"id":"abort","ok":true}\n');
      }, 20);
      if (request.id === "unknown") peer.write('{"id":"foreign","ok":true}\n');
    }
  });
});
server.listen(path); await once(server, "listening");
const socket = connect(path); await once(socket, "connect");
const replies = repairReplies(socket);
try {
  const prepare = replies.read("prepare", 30); socket.write('{"id":"prepare"}\n');
  await assert.rejects(prepare, /timed out/);
  const abort = replies.read("abort", 1000); socket.write('{"id":"abort"}\n');
  assert.equal((JSON.parse(await abort) as { id: string }).id, "abort");
  const unknown = replies.read("unknown", 1000); socket.write('{"id":"unknown"}\n');
  await assert.rejects(unknown, /unknown request id/);
  const previousSource = '[Service]\nExecStart="/gone/node" "/gone/cotal.js" daemon serve\n';
  const nextSource = previousSource.replaceAll("/gone/", "/working/");
  const intent: ServiceRepairIntent = { v: 1, receipt: { v: 1, mechanism: "systemd-user", unit: "cotal-daemon.service", unitPath: join(root, "cotal-daemon.service"), unitSha256: sourceDigest(previousSource), installedAt: "2026-11-20T00:00:00Z" }, previousSource, nextSource, enabled: false, argv: ["/working/node", "/working/cotal.js", "daemon", "serve"], version: "1.2.3", hostedSpaces: [], phase: "prepared" };
  const journal = serviceRepairFile(root);
  writeFileSync(journal, JSON.stringify(intent), { mode: 0o600 });
  assert.deepEqual(readServiceRepair(root), intent);
  assertServiceRepairPair(intent, intent.receipt, nextSource);
  assert.throws(() => assertServiceRepairPair(intent, intent.receipt, nextSource + "# edited"), /source changed/);
  console.log("daemon repair replies and systemd intent: passed");
} finally {
  replies.close(); socket.destroy(); for (const peer of peers) peer.destroy();
  await new Promise<void>(resolve => server.close(() => resolve())); rmSync(root, { recursive: true });
}
