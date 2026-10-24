/** Placed migration through the shipped methods. Only terminal I/O is supplied;
 *  no broker, Manager, credential or seat process is created by this metadata cell. */
import { MeshHandler } from "../src/mesh-handler.js";
import { migrationSeats } from "../src/migrate.js";
import { EffectError, journalEntryKeyString, type JournalEntry, type SpawnRequest } from "@cotal-ai/lang";

const HOST = "m".repeat(26), OTHER = "n".repeat(26), UID = "s".repeat(26), RUN = "placed_migration";
const handle = { agent: `keeper#${UID}`, persona: "keeper" };
const original = {
  v: 1, seq: 0, run: RUN, scope: "", kind: "spawn", name: "old", occurrence: 0,
  inputHash: `sha256:${"0".repeat(64)}`, requestId: "o".repeat(43), attempt: 0,
  state: "settled", status: "ok", startedAt: 1, endedAt: 2, result: handle,
  external: { goalId: "o".repeat(43), name: "keeper", owner: "local", actor: "seat1", uid: UID, host: HOST, spawnedAt: 1 },
} as unknown as JournalEntry;
type Probe = {
  seedRunMemos(entries: readonly JournalEntry[]): void;
  seatAddress(name: string, uid: string): { address: { host?: string; uid: string; owner: string } };
  adoptMigratedSeats(seats: ReadonlyMap<string, readonly JournalEntry[]>): void;
  spawn: MeshHandler["spawn"];
  goalTerminal(ref: { goalId: string }): Promise<unknown>;
  manager(): Promise<never>;
};
function fresh(): Probe {
  return new MeshHandler(null as never, null as never, null as never, null as never, {
    space: "placedmigration", endpoint: "manager", runId: RUN,
    caller: { owner: "local", actor: "wf_probe", uid: "c".repeat(26) },
    instanceId: "d".repeat(26), epoch: 1, holder: { id: "probe", lifecycleUid: "h".repeat(26) }, defaultCheckpointTimeout: "1m",
  }, {} as never, () => 100, undefined, {} as never) as unknown as Probe;
}
let pass = 0, fail = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  if (ok) pass++; else fail++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name} ${JSON.stringify(detail ?? null)}`);
}
function selected(entry: JournalEntry) {
  return migrationSeats([entry], { orphans: [{ step: journalEntryKeyString(entry), verdict: "kept" }], overrides: [`--adopt ${handle.agent}`] } as never).adopt;
}
async function adopt(entry: JournalEntry, placement?: string, resume?: Record<string, unknown>) {
  const handler = fresh(); handler.adoptMigratedSeats(selected(entry));
  let reads = 0, submits = 0, bound: Record<string, unknown> | undefined;
  handler.goalTerminal = async ref => {
    reads++;
    if (ref.goalId !== original.requestId) throw new Error("wrong original goal selected");
    return { state: "succeeded", data: { name: "keeper", id: "local.seat1", lifecycleUid: UID } };
  };
  handler.manager = async () => { submits++; throw new Error("migration must never submit a replacement seat"); };
  const req: SpawnRequest = { persona: "keeper", ...(placement === undefined ? {} : { placement: { endpoint: "manager", instanceId: placement } }) };
  let got: Awaited<ReturnType<MeshHandler["spawn"]>> | undefined, error: unknown;
  try {
    got = await handler.spawn(req, {
      requestId: "a".repeat(43), key: { scope: [], kind: "spawn", name: "new", occurrence: 0 },
      signal: { cancelled: false }, ...(resume ? { resume } : {}),
      bind: async (value: Record<string, unknown>) => { bound = structuredClone(value); },
    } as never);
  } catch (e) { error = e; }
  return { handler, reads, submits, bound, got, error };
}
const restored = fresh(); restored.seedRunMemos([original]);
check("M01 ordinary restored placed spawn retains its original host", restored.seatAddress("keeper", UID).address.host === HOST);
check("M02 stock migration selection hands over the original journal entry", selected(original).get("keeper")?.[0] === original);
const same = await adopt(original, HOST);
check("M03 unchanged-placement adoption returns original handle with no manager submission", same.got?.agent === handle.agent && same.submits === 0 && same.reads === 1);
check("M04 migration durable binding preserves ORIGINAL host", same.bound?.host === HOST, same.bound);
check("M05 live migrated roster remains on ORIGINAL host", same.handler.seatAddress("keeper", UID).address.host === HOST);
const adopted = { ...original, seq: 1, name: "new", requestId: "a".repeat(43), external: same.bound, result: same.got } as JournalEntry;
const takeover = fresh(); takeover.seedRunMemos([original, adopted]);
check("M06 second takeover retains ORIGINAL host rather than class routing", takeover.seatAddress("keeper", UID).address.host === HOST, takeover.seatAddress("keeper", UID));
const incompatible = await adopt(original, OTHER);
check("M07 incompatible requested placement refuses before bind or submission", incompatible.error !== undefined && incompatible.bound === undefined && incompatible.submits === 0, { refused: incompatible.error !== undefined, bound: incompatible.bound });
const { host: _host, ...legacyExternal } = original.external as Record<string, unknown>;
const legacy = { ...original, external: legacyExternal } as JournalEntry;
const old = await adopt(legacy);
check("M08 legacy no-host adoption remains unplaced without inventing a host", old.got?.agent === handle.agent && old.bound?.host === undefined && old.handler.seatAddress("keeper", UID).address.host === undefined && old.submits === 0);
const invented = await adopt(legacy, HOST);
check("M09 legacy no-host entry cannot acquire a requested placement", invented.error !== undefined && invented.bound === undefined && invented.submits === 0);
const omitted = await adopt(original);
check("M10 omitted request placement still preserves the recorded actual host", omitted.bound?.host === HOST && omitted.handler.seatAddress("keeper", UID).address.host === HOST);
const resumed = await adopt(original, OTHER, { ...original.external as Record<string, unknown>, adoptedFrom: journalEntryKeyString(original) });
check("M11 a resumed accepted spawn rejects an incompatible new requested placement", resumed.error !== undefined && resumed.submits === 0);
// An ordinary placement refusal is catchable. It must not spend the hand-over that a later
// valid spawn can still adopt, whether the kept entry is legacy unplaced or already placed.
for (const [entry, badHost, goodHost, firstCell] of [
  [legacy, HOST, undefined, 12],
  [original, OTHER, HOST, 15],
] as const) {
  const handler = fresh(); handler.adoptMigratedSeats(selected(entry));
  const bindings: Record<string, unknown>[] = [];
  let submits = 0, reads = 0;
  handler.goalTerminal = async ref => {
    reads++;
    if (ref.goalId !== original.requestId) throw new Error("wrong adopted goal selected");
    return { state: "succeeded", data: { name: "keeper", id: "local.seat1", lifecycleUid: UID } };
  };
  handler.manager = async () => {
    submits++;
    throw new EffectError("L4000", "spawn", "fixture refuses a replacement lookup");
  };
  const attempt = async (placement: string | undefined, tag: string) => {
    let got: Awaited<ReturnType<MeshHandler["spawn"]>> | undefined, error: unknown;
    try {
      got = await handler.spawn({ persona: "keeper", ...(placement === undefined ? {} : { placement: { endpoint: "manager", instanceId: placement } }) }, {
        requestId: tag.repeat(43), key: { scope: [], kind: "spawn", name: `retry_${tag}`, occurrence: 0 },
        signal: { cancelled: false }, bind: async (value: Record<string, unknown>) => { bindings.push(structuredClone(value)); },
      } as never);
    } catch (e) { error = e; }
    return { got, error };
  };
  const refused = await attempt(badHost, "b");
  check(`M${firstCell} incompatible placement refuses without a bind or manager lookup`,
    refused.error instanceof EffectError && refused.error.code === "L4000" && bindings.length === 0 && submits === 0 && reads === 0);
  const valid = await attempt(goodHost, "c");
  check(`M${firstCell + 1} a valid spawn after refusal still adopts the original kept handle`, valid.got?.agent === handle.agent && valid.error === undefined, { got: valid.got, error: valid.error });
  check(`M${firstCell + 2} refusal then adoption makes no replacement lookup and binds the original host`,
    submits === 0 && reads === 1 && bindings.length === 1 && bindings[0]?.goalId === original.requestId && bindings[0]?.host === goodHost,
    { submits, reads, bindings });
}
console.log(`placed-migration.smoke: ${pass} passed, ${fail} failed`);
process.exit(pass + fail === 17 && fail === 0 ? 0 : 1);
