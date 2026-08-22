import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createPiEvents, PI_EVENTS_LIMIT, type PiRuntime } from "../src/extension.js";

let pass = 0;
let fail = 0;
const check = (name: string, condition: unknown, extra?: unknown): void => {
  if (condition) pass++;
  else {
    fail++;
    console.log(`  x FAIL: ${name}`, extra ?? "");
  }
};

class FakeMesh {
  connected = false;
  frames: unknown[] = [];
  nextAck = 1;
  ep = Object.assign(new EventEmitter(), {
    principal: { owner: "owner", actor: "actor" },
    actorIsEphemeral: false,
    maxPayload: 1_000_000,
    async assertExpectationSemantics() {},
    encodedSize: () => 1,
    multicastExpecting: async ({ parts }: { parts: unknown[] }) => {
      this.frames.push(parts[0]);
      return { ack: { seq: this.nextAck++, duplicate: false } };
    },
  });
  connect(): void {
    this.connected = true;
    this.ep.emit("connection", { connected: true });
  }
  disconnect(): void {
    this.connected = false;
    this.ep.emit("connection", { connected: false });
  }
}

function context(path: string, id = "session-1", entries: unknown[] = []): ExtensionContext {
  return {
    sessionManager: {
      getSessionFile: () => path,
      getSessionId: () => id,
      getEntries: () => entries,
    },
  } as unknown as ExtensionContext;
}

function pi(path: string): ExtensionAPI & { records: unknown[]; entries: unknown[] } {
  const records: unknown[] = [];
  const entries: unknown[] = [];
  return {
    records,
    entries,
    appendEntry(type: string, data: unknown): void {
      records.push(data);
      entries.push({ type: "custom", customType: type, data });
      appendFileSync(path, `${JSON.stringify({ type: "custom", customType: type, data })}\n`);
    },
  } as unknown as ExtensionAPI & { records: unknown[]; entries: unknown[] };
}

const root = mkdtempSync(join(tmpdir(), "cotal-pi-events-lifecycle-"));
const oldEvents = process.env.COTAL_EVENTS;
const oldRoot = process.env.COTAL_WORKSPACE_ROOT;
process.env.COTAL_EVENTS = "1";
process.env.COTAL_WORKSPACE_ROOT = root;

try {
  // C1: creation while the mesh is down persists but does not publish/adopt. The real holder's
  // start path is deliberately unreachable until a connection event arrives.
  {
    const path = join(root, "down.jsonl");
    writeFileSync(path, "");
    const mesh = new FakeMesh();
    const api = pi(path);
    const runtime = { config: { space: "space" }, mesh, driver: {}, personaCleaned: false } as unknown as PiRuntime;
    const events = await createPiEvents(runtime, context(path), api);
    events?.startTurn(1);
    events?.close(2);
    await events?.settled();
    check("C1: nothing published while the mesh is down", events?.holder.path === undefined && events?.holder.failure === undefined && mesh.frames.length === 0, {
      path: events?.holder.path,
      failure: events?.holder.failure?.message,
      frames: mesh.frames.length,
    });
    check("C1: complete disconnected turn is persisted for a later connection", api.records.length >= 3, api.records.length);
  }

  // C2: the boundary is captured before holder setup. A complete turn appended after creation is
  // ahead of that cursor, not silently treated as history once the mesh becomes available.
  {
    const path = join(root, "boundary.jsonl");
    writeFileSync(path, "");
    const mesh = new FakeMesh();
    const api = pi(path);
    const runtime = { config: { space: "space" }, mesh, driver: {}, personaCleaned: false } as unknown as PiRuntime;
    const events = await createPiEvents(runtime, context(path, "boundary"), api);
    events?.startTurn(3);
    events?.close(4);
    const beforeConnect = readFileSync(path, "utf8");
    mesh.connect();
    await events?.settled();
    check("C2: complete turn after createPiEvents remains after the captured source boundary", /RUN_STARTED/.test(beforeConnect) && /RUN_FINISHED/.test(beforeConnect));
    check("C2: a complete turn after createPiEvents publishes frames, not history", mesh.frames.length > 0, mesh.frames.length);
  }

  // C3: a post-adopt disconnect must defer the flush. It neither calls the holder while disconnected
  // nor kills it; connecting again is the one place that drains the durable source.
  {
    const path = join(root, "reconnect.jsonl");
    writeFileSync(path, "");
    const mesh = new FakeMesh();
    mesh.connect();
    const api = pi(path);
    const runtime = { config: { space: "reconnect-space" }, mesh, driver: {}, personaCleaned: false } as unknown as PiRuntime;
    const events = await createPiEvents(runtime, context(path, "reconnect"), api);
    await events?.settled();
    mesh.disconnect();
    events?.startTurn(5);
    events?.close(6);
    await events?.settled();
    check("C3: post-adopt disconnect does not halt the holder", events?.holder.failure === undefined, events?.holder.failure?.message);
    check("C3: post-adopt disconnect leaves no publish attempt in flight", events?.holder.path !== undefined && mesh.frames.length === 0, {
      path: events?.holder.path,
      frames: mesh.frames.length,
    });
    mesh.connect();
    await events?.settled();
    check("C3: reconnect drains the post-adopt durable records without halting", events?.holder.failure === undefined && mesh.frames.length > 0, {
      failure: events?.holder.failure?.message,
      frames: mesh.frames.length,
    });
  }

  // C4: a later extension runtime for the same never-connected session reads the saved start
  // cursor rather than starting at the current end and silently skipping its complete turn.
  {
    const path = join(root, "cross-session.jsonl");
    writeFileSync(path, "");
    const firstMesh = new FakeMesh();
    const firstApi = pi(path);
    const firstRuntime = { config: { space: "cross-space" }, mesh: firstMesh, driver: {}, personaCleaned: false } as unknown as PiRuntime;
    const first = await createPiEvents(firstRuntime, context(path, "cross", firstApi.entries), firstApi);
    first?.startTurn(7);
    first?.close(8);
    const nextMesh = new FakeMesh();
    const nextApi = pi(path);
    const nextRuntime = { config: { space: "cross-space" }, mesh: nextMesh, driver: {}, personaCleaned: false } as unknown as PiRuntime;
    const next = await createPiEvents(nextRuntime, context(path, "cross", firstApi.entries), nextApi);
    nextMesh.connect();
    await next?.settled();
    check("C4: later session drains a never-connected predecessor's persisted complete turn", nextMesh.frames.length > 0, nextMesh.frames.length);
  }

  // C5: retention is bounded while no observer can receive records.
  {
    const path = join(root, "cap.jsonl");
    writeFileSync(path, "");
    const mesh = new FakeMesh();
    const api = pi(path);
    const runtime = { config: { space: "space" }, mesh, driver: {}, personaCleaned: false } as unknown as PiRuntime;
    const events = await createPiEvents(runtime, context(path, "cap"), api);
    let capped = false;
    for (let index = 0; index <= PI_EVENTS_LIMIT.records; index++) {
      try {
        events?.startTurn(index + 10);
        events?.close(index + 10);
      } catch (error) {
        capped = /queue reached/.test(String(error));
        break;
      }
    }
    check("C5: disconnected retention cap fails loud", capped);
  }
} finally {
  if (oldEvents === undefined) delete process.env.COTAL_EVENTS;
  else process.env.COTAL_EVENTS = oldEvents;
  if (oldRoot === undefined) delete process.env.COTAL_WORKSPACE_ROOT;
  else process.env.COTAL_WORKSPACE_ROOT = oldRoot;
  rmSync(root, { recursive: true, force: true });
}

const expected = 9;
check(`every lifecycle cell ran (${expected})`, pass + fail === expected, { pass, fail });
console.log(`pi AG-UI lifecycle smoke: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
