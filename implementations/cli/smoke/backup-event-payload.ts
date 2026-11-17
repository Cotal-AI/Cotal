import assert from "node:assert/strict";
import { connect } from "@nats-io/transport-node";
import { jetstreamManager } from "@nats-io/jetstream";
import { CotalEndpoint, eventPayloadStream, eventPayloadSubject, mintCreds, mintLifecycleUid, newIdentity, standaloneConnectOpts, type Part } from "@cotal-ai/core";
import { authDir, loadSoleSpaceAuth } from "@cotal-ai/workspace";

const [root, servers, space, action, mode] = process.argv.slice(2);
if (!root || !servers || !space || !["seed", "full", "empty"].includes(action ?? "") || !["open", "auth"].includes(mode ?? ""))
  throw new Error("usage: backup-event-payload <root> <server> <space> <seed|full|empty> <open|auth>");
const auth = mode === "auth" ? loadSoleSpaceAuth(authDir(root)) : undefined;
if (mode === "auth" && !auth) throw new Error("missing fixture SpaceAuth");
const principal = { owner: "local", actor: "backup_payload" };
const parts: Part[] = [{ kind: "ag-ui.frame", protocol: "ag-ui/0.0.57",
  threadId: "backup-payload-thread", runId: "backup-run", epoch: "backup-epoch", seq: 1,
  events: [
    { type: "TOOL_CALL_ARGS", toolCallId: "backup-call", delta: '{"path":"fixture.txt"}' },
    { type: "TOOL_CALL_RESULT", toolCallId: "backup-call", messageId: "backup-result", content: "payload survives restore", role: "tool" },
  ],
}];
const lifecycleUid = mintLifecycleUid();
const creds = auth ? await mintCreds(auth, newIdentity(), "agent", { principal, lifecycleUid, allowSubscribe: [">"], allowPublish: [] }) : undefined;
const endpoint = new CotalEndpoint({ space, servers, creds, lifecycleUid, card: { name: "backup-payload", kind: "endpoint", owner: principal.owner, actor: principal.actor }, consume: false, registerPresence: false, watchPresence: false });
try {
  await endpoint.start();
  if (action === "seed") await endpoint.publishEventPayload({ parts, id: "backup-payload-frame", expectedLastSubjectSeq: 0 });
  await endpoint.stop();
  const readerCreds = auth ? await mintCreds(auth, newIdentity(), "observer", { principal }) : undefined;
  const reader = new CotalEndpoint({ space, servers, creds: readerCreds, card: { name: "backup-payload-reader", kind: "endpoint", ...principal }, consume: false, registerPresence: false, watchPresence: false });
  try {
    await reader.start();
    const rows = await reader.eventPayloadHistory(principal.owner, principal.actor);
    assert.equal(rows.length, action === "empty" ? 0 : 1);
    if (action !== "empty") assert.deepEqual(rows[0]!.parts, parts);
    if (auth) {
      await assert.rejects(reader.eventPayloadHistory("u_aaaaaaaaaaaaaaaaaaaaaaaaaa", "foreign"), /permission|authorization|timeout/i,
        "observer cannot read another owner's payload history after restore");
    }
  } finally { await reader.stop(); }
} finally { await endpoint.stop(); }
const nc = await connect({ servers, ...(creds ? standaloneConnectOpts({ creds, tls: false }) : {}) });
try {
  const manager = await jetstreamManager(nc);
  const info = await manager.streams.info(eventPayloadStream(space));
  assert.equal(info.state.messages, action === "empty" ? 0 : 1);
  if (action !== "empty") {
    // The per-subject state comes from the native stream, not the envelope's channel claim.
    const subjects = await manager.streams.info(eventPayloadStream(space), { subjects_filter: eventPayloadSubject(space, principal.owner, principal.actor) });
    assert.equal(subjects.state.subjects?.[eventPayloadSubject(space, principal.owner, principal.actor)], 1);
  }
} finally { await nc.drain(); }
