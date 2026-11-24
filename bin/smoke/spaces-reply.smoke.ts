import assert from "node:assert/strict";
import { createConnection, createServer } from "node:net";
import { DAEMON_PROTOCOL_VERSION, MAX_LINE_BYTES } from "../daemon/endpoint.js";
import { readSpacesReply, spacesReplyLines } from "../daemon/spaces-reply.js";
import type { DaemonSpaces } from "../daemon/protocol.js";

const id = "spaces-test";
const collisions = Array.from({ length: 406 }, (_, i) => ({
  space: `space-${i}-${"a".repeat(53)}`, origin: "manual" as const, idp: "https://example.test/api/auth",
}));
const empty: DaemonSpaces = { kind: "spaces", refresh: "complete", unreadable: 0, collisions: 0, spaces: [] };
const large: DaemonSpaces = {
  ...empty, refresh: "partial", collisions: collisions.length, collisionDetails: collisions,
  spaces: collisions.map(({ space }) => ({ space, mode: "open", label: `${space} 🚀\n\"` })),
};
const lines = (result: DaemonSpaces) => spacesReplyLines(result, data => ({ v: DAEMON_PROTOCOL_VERSION, id, ok: true, ...data }))!;
assert.equal(lines(empty).length, 1);
const parts = lines(large);
assert.ok(parts.length > 2);
assert.ok(parts.every(line => Buffer.byteLength(line) <= MAX_LINE_BYTES));
assert.equal(spacesReplyLines({ ...empty, spaces: [{ space: "large", mode: "open", label: "a".repeat(8 * 1024 * 1024) }] }, data => data), undefined);

async function read(reply: readonly string[]) {
  const server = createServer(sock => sock.once("data", () => sock.end(reply.join(""))));
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const sock = createConnection((server.address() as { port: number }).port, "127.0.0.1");
  try { return await readSpacesReply(sock, id, true); }
  finally { sock.destroy(); await new Promise<void>(resolve => server.close(() => resolve())); }
}
assert.deepEqual(await read(lines(empty)), { v: DAEMON_PROTOCOL_VERSION, id, ok: true, result: empty });
assert.deepEqual(await read(parts), { v: DAEMON_PROTOCOL_VERSION, id, ok: true, result: large });
await assert.rejects(read(parts.slice(1)), /invalid daemon spaces frame/);
await assert.rejects(read(parts.slice(0, -1)), /before its spaces reply finished/);
await assert.rejects(read([parts[0]!, parts[0]!, ...parts.slice(1)]), /invalid daemon spaces frame/);
console.log("Spaces reply smoke passed: single and streamed replies, Unicode, limits and incomplete responses.");
