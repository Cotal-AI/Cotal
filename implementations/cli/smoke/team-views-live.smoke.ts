/**
 * LIVE e2e for the team verbs on a running static-auth stack. Folder `s` runs its space through
 * `space create` and `up --server` on a free port and takes a channel-only `team deploy`. Then:
 *
 *  A. `team`, `team show <id>`, `team deploy --dry-run`, `team boot --dry-run` and
 *     `team remove <id> --dry-run` each exit 0 with outcome `ok` and `completeness` `partial`, and
 *     the report says what the read does not establish, with no failure line on stderr.
 *  B. a card without `deliveryClass: live`: the apply refuses `UNSUPPORTED`, names the cards and
 *     says what to set, and its preview warns `LIVE_DELIVERY_REQUIRED` for the same cards.
 *  C. a reapply of the identical settled deployment is a no-op, and the preview says so instead of
 *     saying a reapply refuses.
 *  D. a manifest `defaults:` block: `team check` and `team boot --dry-run` show it, and mark each
 *     channel field that inherits it `(default)` instead of "not declared".
 *  E. rows that do not apply are left out: no "Durable delivery on open" row for a static space,
 *     and no empty agent table; the deploy preview's TLS row reads as `team show` reads it.
 *  F. `team boot` on the stack that is up says so and offers `team deploy` with the same file, or
 *     `cotal down`, instead of naming the stop the stack lacks.
 *  G. folder `b` takes a fresh channel-only `team boot` of its own space on a second port. Its
 *     receipt, `team show <id>` and the inventory name the record's kind, state, next action and
 *     auth mode in words; the JSON keeps the recorded values.
 *     Its show and its `team remove` refusal offer `cotal down --space <space> --dry-run` with the
 *     space filled in, with no placeholder and no note that the stop is not integrated. After
 *     `down`, a second boot refuses LIFECYCLE_BLOCKED naming `cotal up` and the earlier boot's ID,
 *     and that `cotal up` starts the stack again.
 *  H. a deployment ID that no record names is TARGET_NOT_FOUND, naming the ID, from `team show` and
 *     from `team remove` with and without `--dry-run`.
 *  I. `team boot --dry-run` of another space's manifest in this prepared folder says the folder
 *     belongs to the running space and that the apply needs a folder of its own. In folder `c`,
 *     prepared for no space, it says the folder is not prepared and names `--root .`.
 *  J. after a clean `down` of folder `s`, `team remove <id>` refuses CONFLICT naming `cotal up` in
 *     its root and the remove again, a bare `up` starts the stack again with the deployment's records
 *     as they were, and a removal after one of its cards was edited names that card.
 *
 * Channels only, so no agent launches. COTAL_HOME is sandboxed, the child environment carries no
 * `COTAL_` variable of the runner, and each stack stops with `cotal down --yes`.
 * Needs `nats-server` on PATH. Run: pnpm smoke:team-views:live
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { assertSmokeSandboxDown, createSuite, freePort, recordSmokeSandbox } from "@cotal-ai/smoke-kit";

const WT = resolve(import.meta.dirname, "..", "..", "..");
const CLI = join(WT, "bin", "cotal.ts");
const TSX = join(WT, "node_modules", ".bin", "tsx");
const SERVER = `nats://127.0.0.1:${await freePort()}`, SERVER_B = `nats://127.0.0.1:${await freePort()}`;
const SPACE = `team-views-${process.pid}`, SPACE_B = `team-boot-${process.pid}`;

const base = mkdtempSync(join(tmpdir(), "cotal-team-views-"));
const home = join(base, "home"), configDir = join(base, "xdg"), s = join(base, "s"), b = join(base, "b"), c = join(base, "c");
// The product refuses a local-record store that is not private, so every folder here is 0700.
for (const dir of [home, configDir, s, b, c]) mkdirSync(dir, { mode: 0o700 });
const sandboxes = new Map([s, b].map((root) => [root, recordSmokeSandbox({ root, cotalHome: home, xdgConfigHome: configDir })]));
const env: Record<string, string> = {};
for (const [key, value] of Object.entries(process.env)) if (value !== undefined && !key.startsWith("COTAL_") && key !== "FORCE_COLOR") env[key] = value;
Object.assign(env, { HOME: home, COTAL_HOME: home, XDG_CONFIG_HOME: configDir, COTAL_SKIP_CONNECTOR_SEED: "1", COTAL_NO_PROMPT: "1" });

const { check, finish } = createSuite();
const cotal = (cwd: string, ...args: string[]) => {
  const options = { cwd, env, encoding: "utf8" as const, timeout: 180_000 };
  assertSmokeSandboxDown(sandboxes.get(cwd), args, options);
  const run = spawnSync(TSX, [CLI, ...args], options);
  return { status: run.status, stdout: run.stdout, stderr: run.stderr, out: `${run.stdout}${run.stderr}` };
};
type Envelope = { outcome?: string; completeness?: string; error?: { code?: string; message?: string; remedy?: string }; warnings?: { code: string; target: Record<string, unknown>; message: string }[]; result?: Record<string, unknown> };
const envelope = (stdout: string): Envelope | undefined => { try { return JSON.parse(stdout.trim().split("\n").at(-1) ?? "") as Envelope; } catch { return undefined; } };
/** A read that completed: exit 0, outcome ok, completeness partial and no error. */
const answered = (run: ReturnType<typeof cotal>) => { const e = envelope(run.stdout); return run.status === 0 && e?.outcome === "ok" && e.completeness === "partial" && e.error === undefined; };
/** A text read that completed: exit 0, with its caveat in the report on stdout and not on stderr. */
const reported = (run: ReturnType<typeof cotal>, caveat: string) => run.status === 0 && run.stdout.includes(caveat) && !run.stderr.includes(caveat);

const manifest = (name: string, space: string, channels: Record<string, string>, { head = "", open = false, dir = s, server = SERVER } = {}) => {
  writeFileSync(join(dir, name), `apiVersion: cotal/v1\nkind: Mesh\nspace: ${space}\nbroker:\n  servers: ${server}\n${open ? "  auth: false\n" : ""}${head}channels:\n${Object.entries(channels).map(([channel, extra]) => `  ${channel}:\n    description: The ${channel} channel.\n${extra}`).join("")}`);
};
manifest("live.yaml", SPACE, { live1: "    deliveryClass: live\n", live2: "    deliveryClass: live\n" });
manifest("inherit.yaml", SPACE, { design: "", ops: "    replay: true\n", fine: "    deliveryClass: live\n" });
const OTHER = `other-${process.pid}`, SERVER_OTHER = `nats://127.0.0.1:${await freePort()}`;
for (const dir of [s, c]) manifest("other.yaml", OTHER, { x: "    deliveryClass: live\n" }, { dir, server: SERVER_OTHER });
manifest("boot.yaml", SPACE_B, { bootch: "    deliveryClass: live\n" }, { dir: b, server: SERVER_B });
manifest("open.yaml", SPACE, { lobby: "    deliveryClass: live\n" }, { open: true });
manifest("defaults.yaml", SPACE, { dops: "", own: "    replay: true\n" }, { head: "defaults:\n  replay: false\n  replayWindow: 2h\n  deliveryClass: live\n" });

let up = false, bUp = false;
try {
  check("space create prepares the folder", cotal(s, "space", "create", SPACE).status === 0);
  up = true;
  const started = cotal(s, "up", "--server", SERVER);
  check("up starts the static-auth stack", started.status === 0, started.out.slice(-600));
  if (started.status !== 0) throw new Error("the stack did not start; no later cell can run");

  console.log("\nA. reads and previews that complete exit 0");
  const deployPreview = cotal(s, "team", "deploy", "live.yaml", "--dry-run");
  check("team deploy --dry-run exits 0 and says its read is not a deployment plan",
    reported(deployPreview, "not an authorized deployment plan"), deployPreview.out.slice(-800));
  check("team deploy --dry-run --json is ok and partial in completeness", answered(cotal(s, "team", "deploy", "live.yaml", "--dry-run", "--json")));
  const applied = cotal(s, "team", "deploy", "live.yaml", "--json");
  const id = envelope(applied.stdout)?.result?.deploymentId;
  check("team deploy applies the live channels", applied.status === 0 && typeof id === "string", applied.out.slice(-600));
  const deployment = String(id);

  const inventory = cotal(s, "team");
  check("team exits 0 and says the inventory is not complete",
    reported(inventory, "do not establish a complete historical or live team inventory"), inventory.out.slice(-800));
  check("team --json is ok and partial in completeness", answered(cotal(s, "team", "--json")));
  const shown = cotal(s, "team", "show", deployment);
  check("team show <id> exits 0 and says the receipt is historical",
    reported(shown, "This is historical, not current broker state"), shown.out.slice(-800));
  check("team show <id> --json is ok and partial in completeness", answered(cotal(s, "team", "show", deployment, "--json")));
  const removePreview = cotal(s, "team", "remove", deployment, "--dry-run");
  check("team remove <id> --dry-run exits 0 and says how it compared the cards",
    reported(removePreview, "Current card revisions were compared with the returned create revisions"), removePreview.out.slice(-800));
  check("team remove <id> --dry-run --json is ok and partial in completeness", answered(cotal(s, "team", "remove", deployment, "--dry-run", "--json")));
  const bootPreview = cotal(s, "team", "boot", "live.yaml", "--dry-run");
  check("team boot --dry-run exits 0 and says what it has not checked",
    reported(bootPreview, "startup readiness have not been checked"), bootPreview.out.slice(-800));
  check("team boot --dry-run --json is ok and partial in completeness", answered(cotal(s, "team", "boot", "live.yaml", "--dry-run", "--json")));

  console.log("\nB. cards without deliveryClass: live");
  const notLivePreview = envelope(cotal(s, "team", "deploy", "inherit.yaml", "--dry-run", "--json").stdout);
  const required = notLivePreview?.warnings?.find((w) => w.code === "LIVE_DELIVERY_REQUIRED");
  check("team deploy --dry-run warns that the apply refuses the cards without deliveryClass: live",
    JSON.stringify(required?.target.cards) === JSON.stringify(["design", "ops"]) && required!.message.startsWith("Apply refuses: #design, #ops do not set deliveryClass: live."), notLivePreview?.warnings);
  const notLiveText = cotal(s, "team", "deploy", "inherit.yaml", "--dry-run");
  check("the text preview prints that warning on stderr", notLiveText.status === 0 && notLiveText.stderr.includes("! Apply refuses: #design, #ops do not set deliveryClass: live."), notLiveText.stderr);
  const notLive = cotal(s, "team", "deploy", "inherit.yaml", "--json");
  const refused = envelope(notLive.stdout);
  check("team deploy refuses those cards with UNSUPPORTED, names them and says what to set",
    notLive.status === 2 && refused?.error?.code === "UNSUPPORTED" && refused.error.message!.includes("#design, #ops do not set deliveryClass: live") &&
      refused.error.remedy === "set `deliveryClass: live` on each card, or create a durable channel with `cotal channel set <name> --delivery durable`", notLive.out.slice(-800));
  const liveCheck = cotal(s, "team", "deploy", "live.yaml", "--dry-run", "--json");
  check("a manifest whose cards all set deliveryClass: live has no such warning", !envelope(liveCheck.stdout)?.warnings?.some((w) => w.code === "LIVE_DELIVERY_REQUIRED"));

  console.log("\nC. a reapply of an identical settled deployment");
  const reapplied = cotal(s, "team", "deploy", "live.yaml", "--json");
  check("the second team deploy of the same manifest is a no-op", reapplied.status === 0 && envelope(reapplied.stdout)?.outcome === "no-op", reapplied.out.slice(-600));
  const reapplyPreview = cotal(s, "team", "deploy", "live.yaml", "--dry-run");
  check("its preview says a reapply of an identical settled deployment changes nothing, not that it refuses",
    reapplyPreview.stdout.includes("Reapplying an identical settled deployment changes nothing") && !reapplyPreview.stdout.includes("reapply refuse"), reapplyPreview.stdout.slice(-900));

  console.log("\nD. a manifest defaults block");
  const checked = cotal(s, "team", "check", "defaults.yaml");
  const inheritedRow = /#dops\s+live \(default\)\s+off \(default\)\s+2h \(default\)/;
  check("team check shows the manifest defaults", /Manifest defaults:\s+delivery live, replay off, window 2h/.test(checked.stdout), checked.stdout);
  check("team check marks each field a channel inherits from them (default)", inheritedRow.test(checked.stdout) && /#own\s+live \(default\)\s+on\s+2h \(default\)/.test(checked.stdout), checked.stdout);
  check("team check --json carries the defaults", JSON.stringify(envelope(cotal(s, "team", "check", "defaults.yaml", "--json").stdout)?.result?.defaults) === JSON.stringify({ replay: false, replayWindow: "2h", deliveryClass: "live" }));
  const bootDefaults = cotal(s, "team", "boot", "defaults.yaml", "--dry-run");
  check("team boot --dry-run shows them the same way", /Manifest defaults:\s+delivery live, replay off, window 2h/.test(bootDefaults.stdout) && inheritedRow.test(bootDefaults.stdout), bootDefaults.stdout.slice(-1500));
  const noDefaults = cotal(s, "team", "check", "live.yaml");
  check("a manifest with no defaults block says none are declared", /Manifest defaults:\s+none declared/.test(noDefaults.stdout) && /#live1\s+live\s+not declared\s+not declared/.test(noDefaults.stdout), noDefaults.stdout);

  console.log("\nE. rows that do not apply");
  const staticCheck = cotal(s, "team", "check", "live.yaml");
  check("team check of a static manifest has no durable-on-open row", staticCheck.status === 0 && !staticCheck.stdout.includes("Durable delivery on open"), staticCheck.stdout);
  check("team check with no agents says so instead of printing an empty agent table", staticCheck.stdout.includes("No agents declared.") && !/Agent\s+Application\s+Role\s+Declared model/.test(staticCheck.stdout), staticCheck.stdout);
  const openCheck = cotal(s, "team", "check", "open.yaml");
  check("team check of an open manifest keeps the durable-on-open row", /Durable delivery on open:\s+not a contradiction/.test(openCheck.stdout), openCheck.stdout);
  const staticDeploy = cotal(s, "team", "deploy", "live.yaml", "--dry-run");
  check("the deploy preview on a static space has no durable-on-open row, and its TLS row reads not required",
    !staticDeploy.stdout.includes("Durable delivery on open") && /\n\s+TLS:\s+not required\n/.test(staticDeploy.stdout) && !staticDeploy.stdout.includes("recorded required"), staticDeploy.stdout.slice(0, 1200));
  check("the boot preview of a static manifest has no durable-on-open row", !cotal(s, "team", "boot", "live.yaml", "--dry-run").stdout.includes("Durable delivery on open"));

  console.log("\nF. team boot on a stack that is up");
  const second = cotal(s, "team", "boot", "live.yaml", "--json");
  const blocked = envelope(second.stdout)?.error;
  check("team boot on the running stack refuses LIFECYCLE_BLOCKED and says the space is already up",
    second.status === 2 && blocked?.code === "LIFECYCLE_BLOCKED" && blocked.message === `"${SPACE}" is already up at this root and no cotal down has stopped it; a team boot starts only a stopped stack, so nothing was booted`, second.out.slice(-800));
  check("its Next offers team deploy with the same manifest, or cotal down",
    blocked?.remedy === `add this manifest's channels and agents to the running stack with \`cotal team deploy ${join(s, "live.yaml")}\`, or stop it with \`cotal down\` before a team boot`, blocked);

  console.log("\nG. a fresh boot's records in words");
  check("space create prepares folder b", cotal(b, "space", "create", SPACE_B).status === 0);
  bUp = true;
  const booted = cotal(b, "team", "boot", "boot.yaml");
  check("team boot starts the fresh stack in b, and its receipt names the auth mode in words",
    booted.status === 0 && /Auth mode:\s+static auth\n/.test(booted.stdout) && !booted.stdout.includes("static-auth"), booted.out.slice(-1200));
  const bootId = /cotal team show ([0-9a-f]{16})/.exec(booted.stdout)?.[1] ?? "";
  const freshShow = cotal(b, "team", "show", bootId);
  check("team show <boot id> names its kind, state, next action and auth mode in words",
    /Kind:\s+fresh boot\n/.test(freshShow.stdout) && /Auth mode:\s+static auth\n/.test(freshShow.stdout) && /Recorded state:\s+boot returned\n/.test(freshShow.stdout) &&
      /Next action:\s+inspect the stack\n/.test(freshShow.stdout) && !/broker-boot-returned|inspect-selected-stack/.test(freshShow.stdout), freshShow.stdout);
  check("team show <boot id> offers the stack's own down preview, with no placeholder",
    freshShow.stdout.includes(`cotal down --space ${SPACE_B} --dry-run  Preview the guarded whole-stack stop`) && !/<recorded-space>|in this source/.test(freshShow.stdout), freshShow.stdout);
  const removeBoot = cotal(b, "team", "remove", bootId, "--dry-run", "--json");
  const bootRefusal = envelope(removeBoot.stdout)?.error;
  check("team remove <boot id> refuses CONFLICT and offers cotal down with the space filled in",
    removeBoot.status === 2 && bootRefusal?.code === "CONFLICT" && bootRefusal.remedy === `stop the booted stack with cotal down; preview that stop with cotal down --space ${SPACE_B} --dry-run`, removeBoot.out.slice(-800));
  const freshJson = envelope(cotal(b, "team", "show", bootId, "--json").stdout)?.result;
  check("its JSON keeps the recorded values", freshJson?.recordedState === "broker-boot-returned" && freshJson.nextAction === "inspect-selected-stack" && freshJson.authMode === "auth", freshJson);
  const freshList = cotal(b, "team");
  check("the inventory row names them in words", new RegExp(`${bootId}\\s+fresh boot\\s+boot returned\\s+inspect the stack`).test(freshList.stdout), freshList.stdout);
  check("the boot preview names the requested auth mode in words", /Auth mode request:\s+static auth\n/.test(cotal(b, "team", "boot", "boot.yaml", "--dry-run").stdout));
  // A stopped stack that carried a team is not booted with another one. The refusal names the
  // earlier boot's ID and cotal up, which starts that stack again.
  const stopped = cotal(b, "down", "--yes");
  const again = cotal(b, "team", "boot", "boot.yaml", "--json");
  const againError = envelope(again.stdout)?.error;
  check("a second team boot after down refuses LIFECYCLE_BLOCKED, naming cotal up and the earlier boot's ID",
    stopped.status === 0 && again.status === 2 && againError?.code === "LIFECYCLE_BLOCKED" &&
      againError.remedy === `start this stack again with cotal up in ${realpathSync(b)}, or inspect the earlier boot with cotal team show ${bootId}`, { down: stopped.out.slice(-400), again: again.out.slice(-800) });
  const restarted = cotal(b, "up");
  check("cotal up there starts that stack again", restarted.status === 0 && /Controller stack started/.test(restarted.stdout), restarted.out.slice(-800));
  const additiveShow = cotal(s, "team", "show", deployment);
  check("an additive team show names its state and auth mode in words",
    /Auth mode:\s+static auth\n/.test(additiveShow.stdout) && /Recorded state:\s+channels created\n/.test(additiveShow.stdout), additiveShow.stdout);

  console.log("\nH. a deployment ID that no record names");
  const missing = (run: ReturnType<typeof cotal>, message: string) => {
    const error = envelope(run.stdout)?.error;
    return run.status === 2 && error?.code === "TARGET_NOT_FOUND" && error.message === message && error.remedy === "list the deployments recorded here with cotal team";
  };
  const unknown = "0000000000000000";
  check("team show <unknown id> is TARGET_NOT_FOUND and names the ID", missing(cotal(s, "team", "show", unknown, "--json"), `no team deployment "${unknown}" is recorded in this root`));
  check("team show <garbage> is TARGET_NOT_FOUND and says what an ID looks like", missing(cotal(s, "team", "show", "nonsense", "--json"), `no team deployment "nonsense" is recorded in this root; a deployment ID is 16 hex characters`));
  check("team remove <unknown id> --dry-run is TARGET_NOT_FOUND", missing(cotal(s, "team", "remove", unknown, "--dry-run", "--json"), `no team deployment "${unknown}" is recorded in this root`));
  check("team remove <unknown id> --yes is TARGET_NOT_FOUND, not a route it does not support", missing(cotal(s, "team", "remove", unknown, "--yes", "--json"), `no team deployment "${unknown}" is recorded in this root`));

  console.log("\nI. another space's manifest in this folder");
  const other = cotal(s, "team", "boot", "other.yaml", "--dry-run");
  check("the boot preview says this folder belongs to the running space", other.status === 0 && new RegExp(`Root source:\\s+this folder, which belongs to "${SPACE}"\\n`).test(other.stdout), other.stdout.slice(0, 900));
  check("its hint says the apply needs the space's own folder, with no placeholder",
    other.stdout.includes(`the apply refuses until "${OTHER}" has its own folder: prepare one with cotal space create ${OTHER} --root <project-directory>`) && !other.stdout.includes("--root ."), other.stdout.slice(-900));
  const otherJson = envelope(cotal(s, "team", "boot", "other.yaml", "--dry-run", "--json").stdout)?.result;
  check("its JSON root source is invoking-folder-of-other-space", otherJson?.rootSource === "invoking-folder-of-other-space", otherJson?.rootSource);
  const unprepared = cotal(c, "team", "boot", "other.yaml", "--dry-run");
  check("in a folder prepared for no space, the preview says so and names --root . with the space filled in",
    unprepared.status === 0 && /Root source:\s+this folder, not prepared\n/.test(unprepared.stdout) && unprepared.stdout.includes(`the apply refuses until "${OTHER}" is prepared: prepare this folder with cotal space create ${OTHER} --root .`), unprepared.stdout.slice(-900));

  console.log("\nJ. the stack that took a team deploy, after a clean down");
  const stoppedS = cotal(s, "down", "--yes");
  const removeStopped = envelope(cotal(s, "team", "remove", deployment, "--dry-run", "--json").stdout)?.error;
  check("team remove on the stopped stack refuses CONFLICT, naming cotal up in its root and then the remove again",
    stoppedS.status === 0 && removeStopped?.code === "CONFLICT" && removeStopped.remedy === `no registration names ${SPACE}, as after cotal down; start the stack again with cotal up in ${realpathSync(s)}, which registers it, then run cotal team remove ${deployment} again`, { down: stoppedS.out.slice(-400), removeStopped });
  const restartedS = cotal(s, "up");
  const kept = cotal(s, "team", "show", deployment);
  check("a bare up starts that stack again and keeps the deployment's records as they are",
    restartedS.status === 0 && /Controller stack started/.test(restartedS.stdout) && /Recorded state:\s+channels created\n/.test(kept.stdout), { up: restartedS.out.slice(-800), kept: kept.out.slice(-800) });
  const edited = cotal(s, "channel", "set", "live1", "--desc", "Edited by hand.");
  const removeEdited = envelope(cotal(s, "team", "remove", deployment, "--dry-run", "--json").stdout)?.error;
  check("team remove after a card was edited refuses CONFLICT naming that card",
    edited.status === 0 && removeEdited?.code === "CONFLICT" && removeEdited.message === "the card #live1 changed after this deployment created it; changed metadata is not owned and no card was deleted", { edited: edited.out.slice(-400), removeEdited });
} finally {
  if (bUp) {
    const down = cotal(b, "down", "--yes");
    check("down --yes stops the stack in b", down.status === 0, down.out.slice(-600));
  }
  if (up) {
    const down = cotal(s, "down", "--yes");
    check("down --yes stops the stack", down.status === 0, down.out.slice(-600));
  }
  rmSync(base, { recursive: true, force: true });
}
finish();
