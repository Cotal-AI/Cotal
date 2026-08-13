/**
 * Does a REAL operator command reach the dial policy?
 *
 * `join-target.smoke.ts` proves the classifier is correct and non-tautological, but it calls
 * `classifyJoinTarget` directly with hand-built arguments. That answers "does the test depend on
 * this code" and says nothing about "does the shipped path reach it" — the gap another lane lost a
 * whole feature to tonight, whose TLS suite stayed green through five reproduced blockers because
 * the CLI never produced the objects it tested.
 *
 * So this file crosses the door. It drives `cotal meshes add` itself, through the same command
 * entry point the binary dispatches, and asserts on the operator-visible outcome: exit code,
 * message, and whether a record exists afterwards.
 *
 * It needs no broker, and that is itself the assertion: a refused address must be rejected BEFORE
 * anything is dialed. If one of these cases ever hangs or times out, the gate has moved below the
 * probe and the credential it was protecting has already left the machine.
 *
 * Every refusal is paired with the nearest LEGITIMATE address, varying only the thing under test,
 * because a fence that refuses everything passes a refusal-only suite while breaking the feature.
 * Run: pnpm smoke:join-dial-entry
 */
import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "cotal-dial-home-"));
process.env.COTAL_HOME = home;
process.env.COTAL_NO_PROMPT = "1"; // flag form, never the wizard

// The CLI composition root, imported exactly as the binary does.
await import("../src/index.js");
const { findMesh, loadMeshes, removeMesh } = await import("@cotal-ai/workspace");
const { meshes } = await import("../src/commands/meshes.js");

let pass = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  assert.ok(cond, `${name}${extra !== undefined ? ` — ${JSON.stringify(extra)}` : ""}`);
  pass++;
  console.log(`  ✓ ${name}`);
};

class ExitSignal extends Error {}
/** Drive the real command, capturing what an operator would see. */
async function add(space: string, server: string, extra: Record<string, unknown> = {}): Promise<{ out: string; code: number }> {
  const lines: string[] = [];
  const [log, err, exit] = [console.log, console.error, process.exit];
  let code = 0;
  console.log = (...a: unknown[]) => void lines.push(a.join(" "));
  console.error = (...a: unknown[]) => void lines.push(a.join(" "));
  process.exit = ((c?: number) => { code = c ?? 0; throw new ExitSignal(); }) as never;
  try {
    await meshes({ positionals: ["add", space], values: { server, root, ...extra }, raw: [] } as never);
  } catch (e) {
    if (!(e instanceof ExitSignal)) throw e;
  } finally {
    console.log = log; console.error = err; process.exit = exit;
  }
  return { out: lines.join("\n"), code };
}

const root = mkdtempSync(join(tmpdir(), "cotal-dial-root-"));
mkdirSync(join(root, ".cotal"), { recursive: true });

try {
  console.log("the shipped command refuses an address the policy rejects");
  // A deliberately unroutable-but-well-formed public address. If the gate were BELOW the probe
  // this would stall on a connection attempt instead of returning immediately.
  const started = Date.now();
  const pub = await add("hostile", "nats://203.0.113.7:4222");
  check("`meshes add` exits non-zero for a public address", pub.code === 1, pub);
  // Pinned to the CLASSIFIER'S OWN WORDS. A softer `|refused` arm would also match a literal
  // "connection refused", i.e. the fence being absent, which is the thing this must detect.
  check("  it names the address problem, not a connection failure", /cannot protect/i.test(pub.out), pub.out);
  check("  it records nothing", findMesh("hostile") === undefined);
  check("  and it refused WITHOUT dialing (returned fast)", Date.now() - started < 2_000, Date.now() - started);

  console.log("\n--force cannot buy passage through it");
  const forced = await add("hostile", "nats://203.0.113.7:4222", { force: true });
  check("`meshes add --force` is refused too", forced.code === 1, forced);
  check("  still records nothing", findMesh("hostile") === undefined);

  console.log("\nRFC1918 and hostnames go through the same door");
  const lan = await add("cafe", "nats://192.168.1.10:4222");
  check("a private LAN address is refused by the command", lan.code === 1, lan);
  const named = await add("byname", "nats://broker.example.com:4222");
  check("a hostname is refused by the command", named.code === 1, named);
  check("  neither recorded", findMesh("cafe") === undefined && findMesh("byname") === undefined);

  console.log("\nTHE CONTROL: the nearest legitimate address must get PAST the dial gate");
  // Same command, same shape, one variable changed: the address. This must fail LATER and
  // DIFFERENTLY — on the broker not answering — which is the proof that the gate admits what it
  // should. A fence that refused everything would produce the same message as the cases above,
  // and this is the assertion that catches it.
  const loopback = await add("localmesh", "nats://127.0.0.1:14899");
  check("a loopback literal is NOT refused by the dial policy", !/cannot protect/i.test(loopback.out), loopback.out);
  // Scored by throw-site count before trusting it: "unreachable" matches 68 places in the source,
  // so a disjunction including it would ride on that arm and accept almost any refusal. Pinned to
  // the registration path's own sentence instead — the assertion is only as strong as its weakest
  // alternative, and the loose arm is always the one added "just in case".
  check("  it fails later, on the broker instead of the address", /no broker answered/i.test(loopback.out), loopback.out);
  // An overlay address is refused BY DEFAULT through the real command: a printed warning was not
  // a fence, because stderr is unread by scripts and nothing persisted it for later dials.
  const overlayBare = await add("boxmesh", "nats://100.64.0.1:14899");
  check("an overlay literal is REFUSED without explicit acceptance", overlayBare.code === 1, overlayBare);
  check("  and the refusal names the flag that accepts it", /--allow-unencrypted-overlay/.test(overlayBare.out), overlayBare.out);
  check("  nothing recorded", findMesh("boxmesh") === undefined);

  console.log("\nthe opt-in accepts it, and the dependency still reaches the operator");
  // `--force` here is deliberate and does NOT weaken the three checks below. The dial policy is
  // decided ABOVE the `--force` branch (`meshes.ts:144`, and its residual is printed at `:148`),
  // which is exactly what these read; `--force` only skips the broker PROBE at `:167`. This file
  // already proves force cannot buy passage through the policy, two cases up.
  //
  // Without it this case is the one place here that reaches a live connect, and the target is a
  // CGNAT literal that BLACKHOLES rather than refusing: `probeConnect` returns its verdict on the
  // 5s deadline but tears nothing down on the throw path, so the pending socket outlives the
  // command and the suite prints its checks and then never exits (core #389, pre-existing — this
  // suite exposed it, it did not cause it). A gate step that only ends when something kills it is
  // the false-green shape, and force-exiting around it would hide a future real hang through the
  // same door, so the fix is to not open the socket rather than to escape it.
  const overlay = await add("boxmesh", "nats://100.64.0.1:14899", { "allow-unencrypted-overlay": true, force: true });
  check("with the flag it is NOT refused by the dial policy", !/cannot protect/i.test(overlay.out), overlay.out);
  check("  the warning is printed, not swallowed", /tunnel is down|carrier-grade NAT/i.test(overlay.out), overlay.out);
  check("  it says the rule will tighten", /become a refusal/i.test(overlay.out), overlay.out);

  // Stronger than the bare no-state assertion this replaces: every refusal case above must have
  // written NOTHING, so the single accepted-and-forced record is the only write the file can
  // account for. A case that silently recorded would show up here as a second entry.
  check("  and that forced record is the ONLY thing any case in this file wrote",
    loadMeshes().length === 1 && findMesh("boxmesh") !== undefined, loadMeshes());
  removeMesh("boxmesh");

  check("nothing at all is left registered by this file", loadMeshes().length === 0, loadMeshes());
  console.log(`\njoin-dial-entry: ${pass} checks passed`);
} finally {
  for (const dir of [home, root]) rmSync(dir, { recursive: true, force: true });
}
