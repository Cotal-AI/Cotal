/**
 * OpenCode tool results through the shared emitter: each result reaches the payload rail, and the
 * public channel carries the `cotal.toolResult` marker beside it with the error flag OpenCode
 * recorded, on 1.x and 2.x.
 *
 * The records are the redacted real sessions the mapping suites use (`fixtures/session-shape.json`
 * for 1.x, the last snapshot of each `fixtures/opencode2-sessions.json` session for 2.x), read
 * through the shipped sources and mappers into `AguiEmitter` over a fake endpoint with the payload
 * rail on. Every record is handed over in a read of its own, the finest split a live session can
 * produce, so a result can never lean on a public unit of an earlier record in the same read. No
 * broker is started.
 *
 * Run: pnpm smoke:opencode-result-marker
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Part } from "@cotal-ai/core";
import {
  AGUI_EVENT_TYPE as T, AguiEmitter, EventWal, TOOL_RESULT_EVENT,
  type AguiEvent, type DurableSource, type EmitterEndpoint, type RecordMapper,
} from "@cotal-ai/connector-core";
import { createSuite, memorySubjectFrontier } from "@cotal-ai/smoke-kit";
import { OpenCodeSessionSource, type OpenCodeMessageWithParts } from "../src/agui-source.js";
import { createOpenCodeMapper } from "../src/agui-map.js";
import { OpenCode2SessionSource, type OpenCode2Message } from "../src/agui-source2.js";
import { createOpenCode2Mapper } from "../src/agui-map2.js";

const { check, finish } = createSuite();
const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string): unknown => JSON.parse(readFileSync(join(here, "fixtures", name), "utf8"));

/** Hand over one settled record per read. */
function oneAtATime<R>(inner: DurableSource<R>): DurableSource<R> {
  return {
    kind: inner.kind,
    end: () => inner.end(),
    async read(cursor) {
      const r = await inner.read(cursor);
      const first = r.records[0];
      return first ? { records: [first], cursor: first.cursor } : r;
    },
  };
}

interface Published { rail: "public" | "payload"; events: AguiEvent[] }

/** Pump `source` to its end through the real emitter with the payload rail on. */
async function publish<R>(source: DurableSource<R>, map: RecordMapper<R>) {
  const root = mkdtempSync(join(tmpdir(), "cotal-opencode-marker-"));
  const published: Published[] = [];
  const events = (parts: Part[]) => parts.flatMap((p) => ((p as unknown as { events?: AguiEvent[] }).events ?? []));
  const ep: EmitterEndpoint = {
    principal: { owner: "local", actor: "seat" }, actorIsEphemeral: false, maxPayload: 1_000_000,
    assertExpectationSemantics: async () => {}, eventPayloadLimit: async () => 1_000_000,
    encodedSize: (o) => Buffer.byteLength(JSON.stringify(o)) + 100,
    multicastExpecting: async (o) => { published.push({ rail: "public", events: events(o.parts) }); return { ack: { seq: published.length, duplicate: false } }; },
    publishEventPayload: async (o) => { published.push({ rail: "payload", events: events(o.parts) }); return { ack: { seq: published.length, duplicate: false } }; },
  };
  const errors: string[] = [];
  try {
    mkdirSync(join(root, "thread"));
    const wal = await EventWal.open(join(root, "thread", "wal.json"), { space: "opencode", threadId: "thread", principal: "local.seat", subjectMayExist: false });
    const emitter = await AguiEmitter.start<R>({ endpoint: ep, wal, subjectFrontier: memorySubjectFrontier(), source, map });
    // A read that maps to nothing still advances the cursor, so the end is a read that moves nothing.
    for (;;) {
      const before = wal.frontier.sourceCursor;
      const ok = await emitter.pump().then(() => true, (e: Error) => { errors.push(e.message); return false; });
      if (!ok || wal.frontier.sourceCursor === before) break;
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  return { published, errors };
}

/** What the emitter put on each rail, and whether every result has its marker with the same flag. */
function grade(label: string, out: Awaited<ReturnType<typeof publish>>) {
  const on = (rail: Published["rail"]) => out.published.filter((p) => p.rail === rail).flatMap((p) => p.events);
  const results = on("payload").filter((e) => e.type === T.TOOL_CALL_RESULT) as { toolCallId: string; cotal?: { isError?: boolean } }[];
  const starts = on("public").filter((e) => e.type === T.TOOL_CALL_START);
  const markers = new Map(on("public")
    .filter((e) => e.type === T.CUSTOM && (e as { name?: string }).name === TOOL_RESULT_EVENT)
    .map((e) => { const v = (e as { value: { toolCallId: string; isError: boolean } }).value; return [v.toolCallId, v.isError]; }));
  const failedResults = results.filter((r) => r.cotal?.isError === true).length;
  check(`${label}: every read publishes without error`, out.errors.length === 0, out.errors);
  check(`${label}: every tool call's result reaches the payload rail`, starts.length > 0 && results.length === starts.length, { starts: starts.length, results: results.length });
  check(`${label}: the public channel carries one cotal.toolResult marker per result`, markers.size === results.length, { markers: markers.size, results: results.length });
  check(`${label}: each marker's isError is the result's own flag`,
    results.every((r) => markers.get(r.toolCallId) === (r.cotal?.isError === true)),
    results.filter((r) => markers.get(r.toolCallId) !== (r.cotal?.isError === true)).map((r) => r.toolCallId).slice(0, 5));
  return { failedResults };
}

console.log("OpenCode 1.x: the redacted real session, one record per read");
{
  const session = fixture("session-shape.json") as OpenCodeMessageWithParts[];
  let n = 0;
  const mapper = createOpenCodeMapper({ threadId: "ses_fixture", mintRunId: () => `run-${++n}` });
  const inner = new OpenCodeSessionSource({ read: async () => session });
  // Start from the beginning of the session, not from an adopt at its end.
  const source: DurableSource<Parameters<typeof mapper.map>[0]> = { ...oneAtATime(inner), read: (c) => oneAtATime(inner).read(c ?? "") };
  const { failedResults } = grade("1.x", await publish(source, mapper.map));
  check("1.x: the session holds a failed call, so the error flag is exercised", failedResults > 0, failedResults);
}

console.log("OpenCode 2.x: each redacted real session, one record per read");
{
  const sessions = (fixture("opencode2-sessions.json") as { sessions: { name: string; snapshots: OpenCode2Message[][] }[] }).sessions;
  let failedResults = 0;
  for (const s of sessions.filter((x) => x.snapshots.at(-1)!.some((m) => (m.content ?? []).some((c) => c.type === "tool")))) {
    let n = 0;
    const map = createOpenCode2Mapper({ threadId: "ses_fixture", mintRunId: () => `run-${++n}` });
    const inner = new OpenCode2SessionSource({ page: async () => ({ data: s.snapshots.at(-1)!, cursor: { next: null } }) });
    const source: DurableSource<Parameters<typeof map>[0]> = { ...oneAtATime(inner), read: (c) => oneAtATime(inner).read(c ?? "") };
    failedResults += grade(`2.x ${s.name}`, await publish(source, map)).failedResults;
  }
  check("2.x: a captured session holds a failed call, so the error flag is exercised", failedResults > 0, failedResults);
}

finish();
