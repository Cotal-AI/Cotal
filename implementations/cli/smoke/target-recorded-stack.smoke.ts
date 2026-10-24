/**
 * A project root whose own stack recorded a broker, with no space registered for it, is never given
 * the default broker address. After a failed `cotal up`, `whoami`, `status`, `ps`, `who` and
 * `endpoints` in that root used to target nats://127.0.0.1:4222 while the stack journal recorded
 * another port, so any broker on the default port would have been dialed. They now refuse as not
 * started, name the recorded broker and say how to start it: `space create` prepares the journal's
 * space at the root again, then `cotal up`. A folder whose `.cotal` is a link to the project's is
 * told it is a link, and its status names the link once. A journal cut short or emptied, as an
 * interrupted write leaves it, is named with its path and the way out, and status warns about it. A
 * moved folder whose space this machine does not record is told only to adopt the journal, since
 * moving it back would not start it, and status and whoami name the same step. With the space
 * prepared at the old path, up, down, whoami and status there all name moving back, or forgetting and
 * adopting, and up says to move aside first any folders found at the old path.
 * `space create` in a copy refuses; where the folder its journal names holds no journal, as for a
 * copy from another machine, the refusal and status name `space create --adopt`, which rewrites the
 * journal to name the copy and its store, and prepares the space there. A folder renamed from a path
 * with a control character, where `cotal up` refuses to start, is told only to adopt the journal. A
 * legacy root after its `down` names the address its last start configured, which a bare `cotal up`
 * there starts again.
 *
 * The journal is written by hand in the shape `cotal up` leaves when its broker never started; the
 * resolver reads only its server and space fields. Driven through the built binary in a sandboxed COTAL_HOME.
 * No broker is started.
 *
 * Run: pnpm smoke:target-recorded-stack
 */
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSuite } from "@cotal-ai/smoke-kit";

const BIN = join(import.meta.dirname, "..", "..", "..", "bin", "dist", "cotal.js");
if (!existsSync(BIN)) {
  console.error(`✗ ${BIN} missing - build first: pnpm --filter cotal-ai... build`);
  process.exit(1);
}

interface Envelope {
  outcome: string;
  target: { space?: string | null } | null;
  result: { selected?: { resolved: boolean; code?: string; message?: string }; hints?: string[] } | null;
  error?: { code: string; message: string; remedy?: string };
  warnings?: { code: string; message: string }[];
}

const RECORDED = "nats://127.0.0.1:24711";
const { check, finish } = createSuite();
const home = mkdtempSync(join(tmpdir(), "cotal-recorded-stack-"));
const root = realpathSync(mkdtempSync(join(home, "project-")));
mkdirSync(join(root, ".cotal"), { mode: 0o700 });
process.on("exit", () => rmSync(home, { recursive: true, force: true }));

const HOST_ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("COTAL_") && k !== "FORCE_COLOR" && k !== "NO_COLOR"));
const env = { ...HOST_ENV, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, ".config"), COTAL_HOME: join(home, ".cotal"), COTAL_SKIP_CONNECTOR_SEED: "1", NO_COLOR: "1" };
const run = (args: string[], cwd = root) => {
  const r = spawnSync(process.execPath, [BIN, ...args], { cwd, env, encoding: "utf8", timeout: 120_000 });
  let envelope: Envelope | undefined;
  try { envelope = JSON.parse(r.stdout ?? "") as Envelope; } catch { envelope = undefined; }
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "", envelope };
};
const shown = (r: ReturnType<typeof run>) => ({ status: r.status, stdout: r.stdout.slice(0, 900), stderr: r.stderr.slice(0, 600) });
const noDefault = (r: ReturnType<typeof run>) => !`${r.stdout}${r.stderr}`.includes(":4222");

const before = run(["whoami", "--json"]);
check("control: with nothing recorded, the root still resolves, so the journal is what changes it", before.status === 0 && before.envelope?.outcome === "ok", shown(before));

const now = new Date().toISOString();
const member = (role: string, definition: string, state: string) => ({ role, definition, instanceId: null, state });
writeFileSync(join(root, ".cotal", "stack-controller.json"), JSON.stringify({
  schemaVersion: 1, kind: "cotal-stack-controller", root, space: "la07", server: RECORDED, mode: "open",
  members: [member("broker", "stack-broker", "refused"), member("auth", "stack-auth", "not-attempted"), member("delivery", "stack-delivery", "not-attempted"), member("manager", "stack-manager", "not-attempted")],
  operation: { id: randomUUID(), kind: "up", phase: "refused", recordedAt: now, withAgents: false },
  updatedAt: now,
}, null, 2) + "\n", { mode: 0o600 });

for (const command of ["whoami", "ps", "who", "endpoints"]) {
  const r = run([command, "--json"]);
  check(`${command} refuses as not started, exit 2`, r.status === 2 && r.envelope?.outcome === "refused" && r.envelope.error?.code === "TARGET_UNAVAILABLE", shown(r));
  // `up` refuses while the space is neither prepared nor registered here, so the remedy prepares it first.
  check(`${command} names the recorded broker and the way to start it`, (r.envelope?.error?.message ?? "").includes("127.0.0.1:24711") && (r.envelope?.error?.remedy ?? "").includes(`cotal space create la07 --root ${root}`) && /cotal up/.test(r.envelope?.error?.remedy ?? ""), r.envelope?.error);
  check(`${command} names no default broker address`, noDefault(r), shown(r));
}

const status = run(["status", "--json"]);
check("status reads the machine and selects no space", (status.status === 0 || status.status === 4) && status.envelope?.target?.space === null, shown(status));
check("status reports the selection as not started at the recorded broker", status.envelope?.result?.selected?.resolved === false && status.envelope.result.selected.code === "not-started" && (status.envelope.result.selected.message ?? "").includes("127.0.0.1:24711"), status.envelope?.result?.selected);
check("status names no default broker address", noDefault(status), shown(status));

const components = run(["status", "--components"]);
check("status --components refuses the target and probes no default broker", /target\s+refused · not-started/.test(components.stdout) && noDefault(components), shown(components));

// A journal cut short or emptied names its path, and with no member running, says to remove it.
{
  const path = join(root, ".cotal", "stack-controller.json"), whole = readFileSync(path);
  const named = (r: ReturnType<typeof run>) => r.status === 1 && r.envelope?.error?.code === "SCHEMA_INVALID"
    && r.envelope.error.message === `the stack journal ${path} is not valid JSON, as an interrupted write or a full disk can leave it; no stack membership or stopped state was inferred`
    && r.envelope.error.remedy === `no member of this stack is running, so remove ${path}; the next cotal up from ${root} starts the stack again from its saved definitions`;
  writeFileSync(path, whole.subarray(0, 40));
  const cut = run(["up", "--json"]);
  check("up over a truncated journal refuses SCHEMA_INVALID, naming its path and saying to remove it", named(cut), shown(cut));
  writeFileSync(path, "");
  const down = run(["down", "--yes", "--json"]);
  check("down over an empty journal refuses the same way", named(down), shown(down));
  const clean = run(["clean", "all", "--force"]);
  check("clean all over it refuses, exit 1, naming the path and the way out", clean.status === 1 && clean.stderr.includes(`the stack journal ${path} is not valid JSON`) && clean.stderr.includes(`so remove ${path}`), shown(clean));
  const status = run(["status", "--json"]);
  check("status warns about the journal with its way out", (status.envelope?.warnings ?? []).some((w) => w.code === "STACK_JOURNAL_INVALID" && w.message.includes(path) && w.message.includes("so remove")), shown(status));
  writeFileSync(path, whole);
}

// The journal names the folder that recorded it. In a copy or a moved folder that is another folder,
// whose stack this one does not hold, so the refusal names it rather than calling the shape invalid.
const copy = `${root}-copy`, moved = `${root}-moved`;
spawnSync("cp", ["-a", root, copy]);
const copied = run(["up", "--json"], copy);
check("up in a copied folder refuses CONFLICT, exit 2, naming the folder its journal was recorded at",
  copied.status === 2 && copied.envelope?.error?.code === "CONFLICT" && (copied.envelope.error.message ?? "").includes(`recorded at ${root}, so this folder was copied from there`) && copied.envelope.error.remedy === `use the stack from ${root}, which holds it; this copy does not`, shown(copied));
renameSync(root, moved);
// Nothing on this machine records la07 or an instance of its stack, so moving back would not start it.
const adoptOnly = `adopt it with cotal space create la07 --adopt --root ${moved}; this machine records neither "la07" nor an instance of its stack, so moving the folder back would not start it`;
const movedUp = run(["up", "--json"], moved);
const movedStatus = run(["status", "--json"], moved), movedWho = run(["whoami", "--json"], moved);
// A broker from an earlier release that kept running after the move created empty store folders there.
mkdirSync(join(root, ".cotal", "nats", "jetstream"), { recursive: true });
const recreatedUp = run(["up", "--json"], moved);
rmSync(root, { recursive: true });
renameSync(moved, root);
check("up in a moved folder whose space this machine does not record refuses CONFLICT and names only --adopt",
  movedUp.status === 2 && movedUp.envelope?.error?.code === "CONFLICT" && (movedUp.envelope.error.message ?? "").includes(`recorded at ${root}, so this folder was moved from there`) && movedUp.envelope.error.remedy === adoptOnly, shown(movedUp));
check("status and whoami there name the same next step",
  (movedStatus.envelope?.result?.hints ?? []).includes(adoptOnly) && movedWho.status === 2 && movedWho.envelope?.error?.remedy === adoptOnly, { status: shown(movedStatus), whoami: shown(movedWho) });
check("with empty folders at the old path it is still moved, and names the same step",
  recreatedUp.status === 2 && (recreatedUp.envelope?.error?.message ?? "").includes(`recorded at ${root}, so this folder was moved from there`) && recreatedUp.envelope?.error?.remedy === adoptOnly, shown(recreatedUp));
// With la07 prepared at the old path, moving back starts it again; adopting it here needs a forget first.
{
  check("rig: prepare la07 at its root again", run(["space", "create", "la07", "--json"]).status === 0);
  renameSync(root, moved);
  const adopt = `or, to run it from this folder, forget it with cotal space forget la07, then run cotal space create la07 --adopt --root ${moved}`;
  const back = `move this folder back to ${root}, then run the command again there; ${adopt}`;
  const routes = [run(["up", "--json"], moved), run(["down", "--yes", "--json"], moved), run(["whoami", "--json"], moved), run(["whoami", "--space", "la07", "--json"], moved)];
  const status = run(["status", "--space", "la07", "--json"], moved);
  mkdirSync(join(root, ".cotal", "nats", "jetstream"), { recursive: true });
  const recreated = run(["up", "--json"], moved);
  rmSync(root, { recursive: true });
  renameSync(moved, root);
  check("up, down, whoami and whoami --space there all name moving back, or forgetting and adopting",
    routes.every((r) => r.status === 2 && r.envelope?.error?.remedy === back), routes.map(shown));
  check("status --space there says the folder was moved and names the same step",
    (status.envelope?.result?.selected?.message ?? "") === `"la07" is prepared in ${root}, which no longer exists, and this folder's stack journal was recorded there, so this folder was moved from there` && (status.envelope?.result?.hints ?? []).includes(back), shown(status));
  check("with empty folders at the old path, up says to move them aside first",
    recreated.status === 2 && recreated.envelope?.error?.remedy === `move what is now at ${root} aside, such as empty folders a running broker created there, then move this folder back to ${root} and run the command again there; ${adopt}`, shown(recreated));
  check("rig: forget la07", run(["space", "forget", "la07", "--json"]).status === 0);
}
// A folder whose .cotal links to this project's reads the same journal through the link.
const linked = `${root}-linked`;
mkdirSync(linked);
symlinkSync(join(root, ".cotal"), join(linked, ".cotal"));
const linkedUp = run(["up", "--json"], linked);
check("up in a folder whose .cotal is a link refuses CONFLICT, naming the link and the recorded folder",
  linkedUp.status === 2 && linkedUp.envelope?.error?.code === "CONFLICT" && linkedUp.envelope.error.message === `${join(linked, ".cotal")} is a link to ${join(root, ".cotal")}, whose stack journal was recorded at ${root}; a controller stack runs only from the folder it started in` && linkedUp.envelope.error.remedy === `use the stack from ${root}, which holds it; this folder only links to its records`, shown(linkedUp));
const linkedStatus = run(["status", "--json"], linked);
const linkedCodes = (linkedStatus.envelope?.warnings ?? []).map((w) => w.code);
check("status there warns once that it did not read the attempt inventories through the link",
  linkedCodes.includes("COTAL_DIR_LINKED") && !linkedCodes.includes("FRESH_BOOT_RECORD_UNAVAILABLE") && !linkedCodes.includes("ADDITIVE_ATTEMPT_UNAVAILABLE") && (linkedStatus.envelope?.warnings ?? []).some((w) => w.message.includes(`is a link to ${join(root, ".cotal")}`)), shown(linkedStatus));
rmSync(linked, { recursive: true, force: true });

// space create in a copy refuses, and names --adopt where the copy may take the journal over.
{
  const original = run(["space", "create", "la07", "--adopt", "--json"], copy);
  check("--adopt in a copy whose original still holds the journal refuses CONFLICT and writes nothing",
    original.status === 2 && original.envelope?.error?.code === "CONFLICT" && original.envelope.error.message === `${root} still holds the stack journal of "la07", so this folder is a copy of a stack that runs from there; it was not adopted and nothing was written` && original.envelope.error.remedy === `use the stack from ${root}, which holds it` && (JSON.parse(readFileSync(join(copy, ".cotal", "stack-controller.json"), "utf8")) as { root: string }).root === root, shown(original));
  // A copy from another machine: the folder its journal names holds no journal on this one.
  const away = `${root}-away`, brought = `${root}-brought`;
  spawnSync("cp", ["-a", root, brought]);
  const path = join(brought, ".cotal", "stack-controller.json");
  writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, "utf8")), broker: { storeDir: join(root, ".cotal", "nats") } }, null, 2) + "\n", { mode: 0o600 });
  renameSync(root, away);
  const command = `cotal space create la07 --adopt --root ${brought}`;
  const plain = run(["space", "create", "la07", "--json"], brought);
  check("space create there without --adopt refuses CONFLICT, exit 2, naming the --adopt command",
    plain.status === 2 && plain.envelope?.error?.code === "CONFLICT" && plain.envelope.error.remedy === `adopt it with ${command}`, shown(plain));
  const status = run(["status", "--json"], brought), up = run(["up", "--json"], brought);
  check("status there names the same step as up, which adopts it",
    up.status === 2 && (up.envelope?.error?.remedy ?? "").startsWith(`adopt it with ${command};`) && (status.envelope?.result?.hints ?? []).includes(up.envelope?.error?.remedy ?? "-"), { status: shown(status), up: shown(up) });
  const adopted = run(["space", "create", "la07", "--adopt", "--json"], brought);
  const journal = JSON.parse(readFileSync(path, "utf8")) as { root: string; space: string; server: string; broker?: { storeDir: string }; members: { instanceId: string | null; state: string }[] };
  renameSync(away, root);
  check("--adopt prepares the space and rewrites the journal to name this folder, its store under it, with no member started",
    adopted.status === 0 && journal.root === brought && journal.space === "la07" && journal.server === RECORDED && journal.broker?.storeDir === join(brought, ".cotal", "nats") && journal.members.every((m) => m.instanceId === null && m.state === "not-attempted"), { adopted: shown(adopted), journal });
  const preparedThere = run(["status", "--json"], brought);
  check("the space is then prepared there, to start with cotal up", (preparedThere.envelope?.result?.selected?.message ?? "").includes(`"la07" is prepared but not started`), shown(preparedThere));
  check("rig: forget the adopted space", run(["space", "forget", "la07", "--json"], brought).status === 0);
  rmSync(brought, { recursive: true, force: true });
}
// A journal recorded in a folder whose path held a tab, before up refused such a path, and then renamed.
{
  const renamed = `${root}-renamed`, path = join(renamed, ".cotal", "stack-controller.json");
  spawnSync("cp", ["-a", root, renamed]);
  writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, "utf8")), root: `${root}\tx` }, null, 2) + "\n", { mode: 0o600 });
  const up = run(["up", "--json"], renamed);
  check("up there refuses CONFLICT and names only the adopt command, since up refuses the recorded path",
    up.status === 2 && up.envelope?.error?.code === "CONFLICT" && (up.envelope.error.message ?? "").includes("so this folder was moved from there") && up.envelope.error.remedy === `to run it from this folder, adopt it with cotal space create la07 --adopt --root ${renamed}; cotal up refuses the recorded folder, whose path holds a control character or a bidirectional formatting mark`, shown(up));
  const adopted = run(["space", "create", "la07", "--adopt", "--json"], renamed);
  check("--adopt there rewrites the journal to name this folder", adopted.status === 0 && (JSON.parse(readFileSync(path, "utf8")) as { root: string }).root === renamed, shown(adopted));
  check("rig: forget the adopted space", run(["space", "forget", "la07", "--json"], renamed).status === 0);
  rmSync(renamed, { recursive: true, force: true });
}
writeFileSync(join(copy, ".cotal", "stack-controller.json"), JSON.stringify({ schemaVersion: 1, kind: "cotal-stack-controller", root: copy, space: "la07" }) + "\n", { mode: 0o600 });
const malformed = run(["up", "--json"], copy);
check("a malformed journal is still SCHEMA_INVALID, and its remedy names the journal's own path",
  malformed.status === 1 && malformed.envelope?.error?.code === "SCHEMA_INVALID" && (malformed.envelope.error.remedy ?? "").includes(join(copy, ".cotal", "stack-controller.json")) && !(malformed.envelope.error.remedy ?? "").includes("<root>"), shown(malformed));
rmSync(copy, { recursive: true, force: true });

// A legacy root has no journal, and its `down` drops the registration that named its broker. The
// broker configuration its last start rendered stays, so a one-shot names that address and the bare
// `cotal up` that starts it there again, and never dials the default one.
const legacy = realpathSync(mkdtempSync(join(home, "legacy-")));
mkdirSync(join(legacy, ".cotal"), { mode: 0o700 });
writeFileSync(join(legacy, ".cotal", "server-open.conf"), "# Generated by `cotal up` - do not edit by hand.\nhost: 127.0.0.1\nport: 24712\n", { mode: 0o600 });
for (const command of ["whoami", "ps", "who", "endpoints"]) {
  const r = run([command, "--json"], legacy);
  check(`${command} in a stopped legacy root refuses as not started, exit 2`, r.status === 2 && r.envelope?.outcome === "refused" && r.envelope.error?.code === "TARGET_UNAVAILABLE", shown(r));
  check(`${command} names the address its last start configured and the bare up`, (r.envelope?.error?.message ?? "").includes("last ran at nats://127.0.0.1:24712") && r.envelope?.error?.remedy === `start it again with \`cotal up\` in ${legacy}`, r.envelope?.error);
  check(`${command} in a stopped legacy root names no default broker address`, noDefault(r), shown(r));
}

finish();
process.exit(process.exitCode ?? 0);
