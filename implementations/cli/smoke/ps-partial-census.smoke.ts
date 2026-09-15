/**
 * `cotal ps` MUST NOT PRESENT A PARTIAL CENSUS AS A COMPLETE ONE (#1637).
 *
 * THE DEFECT. A class scatter pins the command contract from ONE instance's `describe` and fans the
 * request to every registered instance. An instance serving a different contract cannot honor that
 * pin, so it rejects (`contract-mismatch`, SPEC 13.7) and every seat it hosts is absent from the
 * listing. The renderer printed the refusal as that instance's header line, printed nothing else
 * about it, and returned. Measured on the fixture below: six seats running, one printed, exit 0.
 * A refusal that hides a whole roster is indistinguishable from an instance with no seats, and the
 * only half of that a script can read is the exit status, which said the listing was complete.
 *
 * THE FIXTURE IS THE CONDITION, NOT A SIMULATION OF IT. Section 1 registers two instances of one
 * endpoint whose `ps` output contracts genuinely differ, serves both through `serveEndpoint`, and
 * runs the same freeze + resolve + scatter the CLI runs. The refusal comes out of the serve
 * boundary's own §13.7 binding; nothing here crafts one. A third instance is registered and serves
 * nothing, so the same run also carries the OTHER way an instance contributes no rows.
 *
 * WHICH INSTANCE REFUSES IS NOT FIXED, and the cells are written to survive that: whichever wins
 * the describe queue supplies the pin, and the other rejects. That swap is the reported symptom,
 * so a cell that demanded a particular instance would be asserting the race, not the behavior.
 *
 * SECTION 4 RUNS THE COMMAND. Sections 2 and 3 grade the decision; section 4 grades the wiring, by
 * running the real `ps` against this same space and reading the status it leaves behind. That is
 * the half of the output a script sees, and it is the half the defect got wrong: on the shipped
 * code this fixture printed one instance's seats and exited 0.
 *
 * SECTION 3 IS THE CONTROL SET. A census over instances that all reported must produce no notice
 * and no failure, or the notice would be noise on every healthy multi-manager space; and a refusal
 * carrying some OTHER code must still make the listing partial while NOT claiming a contract split,
 * which is what keys the split on the structured code rather than on the message text.
 *
 * Run: pnpm smoke:ps-partial-census   (needs nats-server on PATH; part of smoke:ci)
 */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "@nats-io/transport-node";
import { jetstreamManager } from "@nats-io/jetstream";
import {
  isReachable, compileContract, contractDigest, VOID_SCHEMA,
  openRecordsBucket, registerServiceInstance, writeServiceStatus, authorizeServeGrant,
  serveEndpoint, ensureContractStore, contractStoreContext, publishContractArtifact,
  contractArtifactCanonicalBytes, freezeExpectedSet, resolveService, scatterCommand,
  SERVICE_READY,
  type EpCaller, type EpCommandDef, type EpIssuanceBarrier, type ServiceNameAuthority, type ServiceSpec,
} from "@cotal-ai/core";
import type { KV } from "@nats-io/kv";
import { SMOKE_BROKER_TOKEN, teardownOnSignal } from "@cotal-ai/smoke-kit";
import { recordMesh } from "@cotal-ai/workspace";
import { ps, psCensus, psCensusNotice } from "../src/commands/agents.js";
import type { ParsedArgs } from "@cotal-ai/core";
import { pickFreePort } from "../../../packages/core/smoke/_free-port.js";

const EXPECTED_CELLS = 24;

let pass = 0, fail = 0;
const check = (name: string, cond: boolean, extra?: unknown): void => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ FAIL: ${name}`, extra === undefined ? "" : JSON.stringify(extra)); }
};
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

const SPACE = "pspartial";
const EP = "manager";
const IID_OLD = "a".repeat(26);   // 5 seats, the build the newer one diverged from
const IID_NEW = "b".repeat(26);   // 1 seat, one more fact per row
const IID_SILENT = "c".repeat(26); // registered, serves nothing
const EPOCH = 1;
const asOp = { owner: "u_op" };
const caller: EpCaller = { owner: "u_op", actor: "cli", uid: "u".repeat(26) };

// Two builds of one manager: the newer records the seat's host, so its output closure digest
// differs and a request pinned to the older one cannot be honored.
const seatProps = {
  name: { type: "string" }, agent: { type: "string" }, mode: { type: "string" }, status: { type: "string" },
  uptimeMs: { type: "integer" }, mesh: { type: "string" }, lifecycleUid: { type: "string" }, id: { type: "string" },
};
const seatRequired = ["name", "agent", "mode", "status", "uptimeMs", "mesh", "lifecycleUid", "id"];
const ROWS_OLD_SCHEMA = { type: "array", items: { type: "object", additionalProperties: false, required: seatRequired, properties: seatProps } };
const ROWS_NEW_SCHEMA = { type: "array", items: { type: "object", additionalProperties: false, required: seatRequired, properties: { ...seatProps, host: { type: "string" } } } };
const ROWS_OLD = compileContract({ root: ROWS_OLD_SCHEMA });
const ROWS_NEW = compileContract({ root: ROWS_NEW_SCHEMA });
const VOID_IN = compileContract({ root: VOID_SCHEMA });

/** Every §13.7 artifact a caller fetches: each schema root with its single-member closure manifest,
 *  and each cluster document with its own. The manager publishes this same set at registration. */
const artifacts = new Map<string, unknown>();
const addArtifact = (value: unknown): string => {
  const rootDigest = contractDigest(value);
  const manifest = { v: 1, root: rootDigest, members: [] as string[] };
  artifacts.set(rootDigest, value);
  artifacts.set(contractDigest(manifest), manifest);
  return contractDigest(manifest);
};
for (const schema of [VOID_SCHEMA, ROWS_OLD_SCHEMA, ROWS_NEW_SCHEMA]) addArtifact(schema);
const docFor = (outputDigest: string) => ({
  urn: "ai.cotal.manager", revision: 1, attributes: [], events: [],
  commands: [{ name: "ps", class: "ephemeral", targeted: false, capability: "manager.read", inputDigest: VOID_IN.closureDigest, outputDigest }],
});
const DC_OLD = addArtifact(docFor(ROWS_OLD.closureDigest));
const DC_NEW = addArtifact(docFor(ROWS_NEW.closureDigest));

const authority: ServiceNameAuthority = { authorize: (_name, owner) => ({ authorized: owner === "u_op", revision: 0 }) };

// A faithful freeze -> (spec write) -> reopen writer; the §13.1 fence internals are proven in
// packages/core/smoke/endpoint-serve-auth.smoke.ts and are not what this suite is about.
const gates = new Map<string, { space: string; endpoint: string; lifecycleUid: string; principal: string; state: "open" | "frozen" | "retired"; generation: number; processEpoch: number; registrationRevision: number; nameAuthorityRevision: number; revision: number }>();
function barrierFor(instanceId: string): EpIssuanceBarrier {
  if (!gates.has(instanceId))
    gates.set(instanceId, { space: SPACE, endpoint: EP, lifecycleUid: instanceId, principal: "u_op.mgr", state: "open", generation: 0, processEpoch: 0, registrationRevision: 0, nameAuthorityRevision: 0, revision: 1 });
  const g = gates.get(instanceId)!;
  return {
    observe: () => ({ ...g }),
    freeze: (rev) => { if (g.state !== "open" || g.revision !== rev) return null; g.state = "frozen"; g.revision++; return g.revision; },
    enumerate: () => [],
    revoke: () => {},
    evict: () => true,
    reopen: (token, succ) => { if (g.state !== "frozen" || g.revision !== token) return false; g.state = "open"; g.generation = succ.generation; g.processEpoch = succ.processEpoch; g.registrationRevision = succ.registrationRevision; g.nameAuthorityRevision = succ.nameAuthorityRevision; g.revision++; return true; },
  };
}

const PORT = await pickFreePort();
const sd = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
const broker = spawn("nats-server", ["-js", "-sd", sd, "-p", String(PORT), "-a", "127.0.0.1"], { stdio: "ignore" });
const releaseBroker = teardownOnSignal(broker, sd);
try {
  let up = false;
  for (let i = 0; i < 60 && !up; i++) { up = await isReachable(`nats://127.0.0.1:${PORT}`); if (!up) await wait(150); }
  if (!up) throw new Error("broker did not come up");
  const nc = await connect({ servers: `nats://127.0.0.1:${PORT}` });
  const jsm = await jetstreamManager(nc);
  await ensureContractStore(jsm, SPACE);
  const store = await contractStoreContext(nc, SPACE);
  for (const value of artifacts.values()) await publishContractArtifact(store, contractArtifactCanonicalBytes(value));
  const kv = await openRecordsBucket(nc, SPACE, { create: true });

  /** Register one instance under its own contract, publish READY, and (unless it is the silent one)
   *  serve `ps` off that many seats. */
  const bring = async (instanceId: string, clusterDigest: string, output: typeof ROWS_OLD, seats: number | "silent") => {
    const spec: ServiceSpec = { endpoint: EP, owner: "u_op", clusterDigests: [clusterDigest], protocol: { v: 1 } };
    const reg = await registerServiceInstance(kv as KV, { spec, instanceId, registrant: asOp, authority, space: SPACE, barrier: barrierFor(instanceId), readClusterArtifact: (d) => artifacts.get(d) });
    await writeServiceStatus(kv as KV, { endpoint: EP, instanceId, epoch: EPOCH, readProcessEpoch: () => EPOCH, status: { epoch: EPOCH, state: SERVICE_READY, observedSpecRevision: reg.registrationRevision } });
    if (seats === "silent") return undefined;
    const grant = await authorizeServeGrant(kv as KV, { space: SPACE, endpoint: EP, instanceId, epoch: EPOCH, holder: asOp, authority, readProcessEpoch: () => EPOCH, readClusterArtifact: (d) => artifacts.get(d) });
    const def: EpCommandDef = {
      command: "ps", contract: { input: VOID_IN, output },
      handler: () => Array.from({ length: seats }, (_v, i) => ({
        name: `${instanceId.slice(0, 3)}-seat-${i}`, agent: "claude", mode: "managed", status: "running",
        uptimeMs: 1_000, mesh: "idle", lifecycleUid: "u".repeat(26), id: `${instanceId.slice(0, 3)}-${i}`,
      })),
    };
    return serveEndpoint(nc, SPACE, grant, [def], { public: true });
  };

  console.log("1. the space: two instances on different contracts, plus one that answers nothing");
  const served = [
    await bring(IID_OLD, DC_OLD, ROWS_OLD, 5),
    await bring(IID_NEW, DC_NEW, ROWS_NEW, 1),
    await bring(IID_SILENT, DC_OLD, ROWS_OLD, "silent"),
  ];
  await wait(300);
  const frozen = (await freezeExpectedSet(jsm, SPACE, EP)).map((f) => f.instanceId);
  check("the freeze names all three registered instances (six seats run under the two that serve)",
    [IID_OLD, IID_NEW, IID_SILENT].every((id) => frozen.includes(id)), frozen);

  // The CLI's own path: one describe pins the class contract, then the request goes to every
  // instance on the `all` rail.
  const service = await resolveService(nc, SPACE, EP, caller, { deadlineMs: 8_000 });
  const pin = service.commands.get("ps")!;
  const pinned = { instanceId: service.responder.instanceId, input: pin.contract.input.closureDigest, output: pin.contract.output.closureDigest };
  check("the describe that supplied the pin was answered by ONE of the two serving instances",
    pinned.instanceId === IID_OLD || pinned.instanceId === IID_NEW, pinned.instanceId);
  const result = await scatterCommand(nc, SPACE, service, "ps", undefined, { deadlineMs: 3_000, reconcileDeadlineMs: 2_000 });

  // Built exactly as implementations/cli/src/lib/control.ts builds it, so what the census grades is
  // the shape the renderer sees.
  const instances: { instanceId: string; reachable: boolean; data?: unknown; error?: string; code?: string }[] = [];
  for (const [instanceId, ar] of result.replies) {
    if (ar.reply.ok === true) instances.push({ instanceId, reachable: true, data: ar.reply.data });
    else instances.push({ instanceId, reachable: true, error: ar.reply.error?.message ?? "error", code: ar.reply.error?.code });
  }
  for (const instanceId of result.missing) instances.push({ instanceId, reachable: false });

  const refusals = instances.filter((i) => i.error !== undefined);
  const answered = instances.filter((i) => i.reachable && i.error === undefined);
  const printedSeats = answered.reduce((n, i) => n + ((i.data as unknown[]) ?? []).length, 0);
  check("every registered instance is in the result, silent one included (SPEC 13.5 pin 3)", instances.length === 3, instances.map((i) => i.instanceId));
  check("the instance on the other contract REFUSED, and the refusal is the serve boundary's own",
    refusals.length === 1 && refusals[0].code === "contract-mismatch", refusals);
  check("...naming both digest pairs, which is why the CLI never has to parse this message",
    (refusals[0]?.error ?? "").includes(pinned.output) && /do not match the served contract/.test(refusals[0]?.error ?? ""), refusals[0]?.error);
  check("THE DEFECT'S INPUT: six seats are running and the rows carry one instance's worth",
    printedSeats === (pinned.instanceId === IID_OLD ? 5 : 1), { printedSeats, pinnedTo: pinned.instanceId });
  check("...and the silent registration contributed no rows either", instances.some((i) => !i.reachable && i.instanceId === IID_SILENT), instances);

  console.log("2. the census over those replies");
  const census = psCensus(instances);
  check("one instance of three reported its seats", census.reported === 1 && census.total === 3, census);
  check("...so two did not, the refusal and the silence counted the same way", census.silent === 2, census);
  check("the refusal is read as a CONTRACT SPLIT, off the structured code", census.contractSplit === true, census);
  // Indexed through `at` with a string floor: a cell RECORDS its verdict and never throws, or the
  // one that reads a line the notice no longer has takes every cell below it down with it - which
  // is what a mutation run then reports as inconclusive rather than as the kill it is.
  const notice = psCensusNotice(census, pinned);
  const line = (i: number): string => notice[i] ?? "";
  check("a partial census produces a notice", notice.length === 2, notice);
  check("...that names how many instances did not report", /partial listing: 2 of 3 manager instances did not report/.test(line(0)), line(0));
  check("...and a second line naming the split, the pinned digests, and the instance they came from",
    line(1).includes(pinned.instanceId) && line(1).includes(pinned.input) && line(1).includes(pinned.output)
    && /do not all serve the same command contract/.test(line(1)), line(1));

  console.log("3. controls: what must NOT produce a notice, and what must not claim a split");
  const healthy = psCensus([{ reachable: true }, { reachable: true }]);
  check("every instance reporting is a COMPLETE census", healthy.silent === 0 && healthy.reported === 2 && healthy.contractSplit === false, healthy);
  check("...and produces no notice, so a healthy multi-manager space stays quiet", psCensusNotice(healthy, pinned).length === 0);
  const empty = psCensus([{ reachable: true }]);
  check("an instance that answers with NO seats has reported: zero rows is an answer, not a hole",
    empty.silent === 0 && empty.reported === 1, empty);
  const otherRefusal = psCensus([{ reachable: true }, { reachable: true, error: "no manager rows", code: "permission-denied" }]);
  check("a refusal under another code still makes the listing partial", otherRefusal.silent === 1, otherRefusal);
  check("...but does NOT claim a contract split, so the split line keys on the code and not on prose",
    otherRefusal.contractSplit === false && psCensusNotice(otherRefusal, pinned).length === 1, otherRefusal);
  const prose = psCensus([{ reachable: true, error: "pinned digests do not match the served contract; a member that cannot honor a pinned digest rejects, never coerces (SPEC 13.7)" }]);
  check("...and a refusal whose MESSAGE reads like a mismatch but carries no code is not one either",
    prose.contractSplit === false && prose.silent === 1, prose);

  console.log("4. and the command itself, run against this space");
  // THE HALF ONLY A SCRIPT SEES. Everything above grades the decision; this grades the wiring, by
  // running the real `ps` against the real space and reading what it leaves behind. It is in-
  // process rather than a subprocess so it exercises the SOURCE under test rather than whatever
  // `dist` happens to hold, and `process.exit` is replaced by a throw because the status is the
  // observable: it is the only half of this output a script reads, and it is the half that was
  // wrong. COTAL_HOME is redirected first so the mesh record lands in the fixture, never in the
  // developer's own registry.
  const root = join(sd, "root");
  mkdirSync(join(root, ".cotal", "agents"), { recursive: true });
  process.env.COTAL_HOME = join(sd, "home");
  recordMesh({ space: SPACE, server: `nats://127.0.0.1:${PORT}`, root, mode: "open", ts: new Date().toISOString() });
  const EXITED = Symbol("process.exit");
  const strip = (text: string): string => text.replace(/\x1b\[[0-9;]*m/g, "");
  const runPs = async (values: Record<string, string | boolean | undefined>) => {
    const out: string[] = [], err: string[] = [];
    const realLog = console.log, realErr = console.error, realExit = process.exit, realCwd = process.cwd();
    let status = 0;
    console.log = (...a: unknown[]) => { out.push(a.map(String).join(" ")); };
    console.error = (...a: unknown[]) => { err.push(a.map(String).join(" ")); };
    process.exit = ((code?: number) => { status = code ?? 0; throw EXITED; }) as typeof process.exit;
    process.chdir(root);
    try { await ps({ values, positionals: [], raw: [] } as ParsedArgs); }
    catch (e) { if (e !== EXITED) throw e; }
    finally { console.log = realLog; console.error = realErr; process.exit = realExit; process.chdir(realCwd); }
    return { stdout: strip(out.join("\n")), stderr: strip(err.join("\n")), status };
  };

  const human = await runPs({ space: SPACE });
  check("`cotal ps` over this space EXITS NON-ZERO: a partial census is not a listing of the space",
    human.status !== 0, { status: human.status, stderr: human.stderr });
  check("...while still printing every seat the instance that answered could enumerate",
    /-seat-0/.test(human.stdout), human.stdout);
  check("...and saying on stderr that the listing is partial", /partial listing: 2 of 3/.test(human.stderr), human.stderr);
  // The split line reaches the operator only if the scatter carried each refusal's CODE up to the
  // renderer. Section 1 builds its own slots, so this is the only cell that crosses that seam.
  check("...and naming the contract split once, with the pin, off the code the scatter carried",
    /do not all serve the same command contract/.test(human.stderr) && (human.stderr.includes(IID_OLD) || human.stderr.includes(IID_NEW)),
    human.stderr);
  const asJson = await runPs({ space: SPACE, json: true });
  const stdoutLines = asJson.stdout.split("\n").filter((l) => l.trim().length > 0);
  check("--json exits the same way and keeps stdout one JSON object per seat, notice on stderr",
    asJson.status !== 0 && stdoutLines.length > 0 && stdoutLines.every((l) => { try { JSON.parse(l); return true; } catch { return false; } })
    && /partial listing: 2 of 3/.test(asJson.stderr), { status: asJson.status, stdout: asJson.stdout.slice(0, 200) });

  for (const handle of served) await handle?.stop();
  await nc.drain().catch(() => nc.close());
} finally {
  broker.kill("SIGKILL");
  await wait(200);
  rmSync(sd, { recursive: true, force: true });
  releaseBroker();
}

const ran = pass + fail;
if (ran !== EXPECTED_CELLS) {
  console.log(`  ✗ FAIL: expected ${EXPECTED_CELLS} cells, ran ${ran} - a partial run is not a pass`);
  fail++;
}
console.log(`\nps partial census smoke: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
