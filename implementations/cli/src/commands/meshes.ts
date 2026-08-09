import { type CompletionResult, type FlagSpec, type FlagValues, type ParsedArgs } from "@cotal-ai/core";
import {
  authDir,
  clearCurrent,
  findMesh,
  getCurrent,
  loadMeshes,
  removeMesh,
  type MeshEntry,
} from "@cotal-ai/workspace";
import { c } from "../ui.js";
import { pruneStaleMeshes } from "../lib/meshes.js";
import { completingFlagValue } from "../lib/completion.js";
import { liveMeshProcess } from "./clean.js";
import {
  candidateTarget,
  checkEnforcement,
  checkMode,
  checkRoot,
  checkServer,
  checkTrust,
  probeEnforcement,
  spacesAtRoot,
  verifyTarget,
  writeRecord,
  type Check,
} from "./meshes-add.js";
import { addWizard, canPrompt } from "./meshes-wizard.js";

/**
 * `cotal meshes` — the registry of meshes this machine can reach, and the two verbs that maintain
 * it by hand.
 *
 *   cotal meshes                       list (the kubectl `get-contexts` analogue)
 *   cotal meshes add <space> --server  register a mesh this machine did NOT start
 *   cotal meshes rm <space> …          drop records (never stops anything)
 *
 * `up` and `down` still write and clear their own records; `add`/`rm` exist for the meshes they
 * cannot speak for — one running on another machine, a shared broker, a hosted space. Those records
 * are marked `manual` and are never auto-pruned (see `pruneMesh`), because this machine has no way
 * to write them back: a dead broker under one is reported `offline`, not deleted.
 */

const SUBCOMMANDS = ["list", "add", "rm", "remove"] as const;

export const meshesFlags = [
  { name: "server", type: "string", value: "<url>", description: "add: the mesh's broker URL (required)" },
  { name: "root", type: "string", value: "<dir>", description: "add: folder holding this mesh's .cotal/auth + .cotal/agents (default: this project)" },
  { name: "mode", type: "string", value: "<auth|open>", description: "add: how the broker authenticates (default: inferred from --root)" },
  { name: "force", type: "boolean", description: "add: record without verifying, replacing any existing record · rm: drop a running mesh's record" },
] as const satisfies readonly FlagSpec[];

type Values = FlagValues<typeof meshesFlags>;

export async function meshes(args: ParsedArgs): Promise<void> {
  const sub = args.positionals[0];
  const v = args.values as Values;
  if (sub === "add") return addMesh(args.positionals.slice(1), v);
  if (sub === "rm" || sub === "remove") return removeMeshes(args.positionals.slice(1), v);
  if (sub !== undefined && sub !== "list") {
    console.error(c.red(`✗ unknown subcommand "${sub}" - usage: cotal meshes [list | add <space> --server <url> | rm <space> …]`));
    process.exit(1);
  }
  return listMeshes();
}

// ---- list -----------------------------------------------------------------------------------

/** The registered meshes, one per line, with a `*` on the `current` default. This is how you see
 *  what a bare `cotal spawn` would join and which `--space` names exist. The sweep runs first, so
 *  a mesh this machine started and lost is gone from the list; an operator-registered one whose
 *  broker is down stays, tagged `offline` — it is still the mesh you meant, just not up. */
async function listMeshes(): Promise<void> {
  const sweep = await pruneStaleMeshes();
  const all = loadMeshes();
  if (all.length === 0) {
    console.log(c.dim("no meshes registered - `cotal up` starts one here, `cotal meshes add <space> --server <url>` registers one running elsewhere"));
    return;
  }
  const current = getCurrent();
  const offline = new Set(sweep.offline);
  const width = (pick: (m: MeshEntry) => string, header: string) =>
    Math.max(header.length, ...all.map((m) => pick(m).length));
  const wSpace = width((m) => m.space, "SPACE");
  const wServer = width((m) => m.server, "SERVER");
  const wMode = width((m) => m.mode, "MODE");
  console.log(c.dim(`  ${"SPACE".padEnd(wSpace)}  ${"SERVER".padEnd(wServer)}  ${"MODE".padEnd(wMode)}  ROOT`));
  for (const m of all) {
    const marker = m.space === current ? c.green("*") : " ";
    const tags = [
      ...(m.origin === "manual" ? [c.dim("registered")] : []),
      ...(offline.has(m.space) ? [c.yellow("offline")] : []),
    ];
    console.log(
      `${marker} ${m.space.padEnd(wSpace)}  ${c.dim(`${m.server.padEnd(wServer)}  ${m.mode.padEnd(wMode)}  ${m.root}`)}` +
        (tags.length ? `  ${tags.join(c.dim(" · "))}` : ""),
    );
  }
  // A `current` that no longer matches any recorded mesh (its broker went down) shows no `*` — say
  // why, so a bare `cotal spawn` still reporting "multiple meshes" isn't a mystery.
  if (current && !all.some((m) => m.space === current))
    console.log(c.dim(`\nnote: default "${current}" is not running - \`cotal use <name>\` to set a live one`));
}

// ---- add ------------------------------------------------------------------------------------

/** `cotal meshes add <space> --server <url>` — register a mesh this machine did not start, so
 *  `--space`, `cotal use` and a bare `cotal spawn` can reach it from any directory. The record
 *  holds a broker URL, a local root and a mode; trust material itself stays in that root's
 *  `.cotal/auth`, exactly as it does for a mesh started here. */
async function addMesh(positionals: string[], v: Values): Promise<void> {
  const space = positionals[0];
  if (positionals.length > 1) {
    console.error(c.red("usage: cotal meshes add <space> --server <url> [--root <dir>] [--mode auth|open]"));
    process.exit(1);
  }
  // GUIDED FORM. A registration needs four facts, three of which the machine can find out — so a
  // command missing either irreducible one, on a real terminal, is an operator who would rather be
  // asked than read a usage line. Scripts and agents are unaffected: without a TTY (or with
  // COTAL_NO_PROMPT=1) the flag form's fail-loud sentences stand, which is what every smoke asserts.
  if ((!space || !v.server) && canPrompt()) {
    const done = await addWizard(
      { ...(space ? { space } : {}), ...(v.server ? { server: v.server } : {}), ...(v.root ? { root: v.root } : {}),
        ...(v.mode ? { mode: v.mode } : {}), ...(v.force ? { force: true } : {}) },
      process.cwd(),
    );
    if (!done) process.exitCode = 0; // backing out of a wizard is not a failure
    return;
  }
  if (!space) {
    console.error(c.red("usage: cotal meshes add <space> --server <url> [--root <dir>] [--mode auth|open]"));
    process.exit(1);
  }
  if (!v.server) {
    console.error(c.red("✗ --server <url> is required - a mesh you did not start here has no address to infer (e.g. --server nats://10.0.0.5:4222)"));
    process.exit(1);
  }
  const server = take(checkServer(v.server));
  const root = take(checkRoot(v.root, process.cwd()));
  const accounts = take(spacesAtRoot(root));
  const mode = take(checkMode(space, root, accounts, v.mode));
  if (mode === "open" && accounts.includes(space))
    console.log(c.dim(`note: ${authDir(root)} holds trust for "${space}", but --mode open records a credless connect`));
  const auth = take(checkTrust(mode, root, space));

  const existing = findMesh(space);
  if (existing && !v.force) {
    console.error(c.red(`✗ "${space}" is already registered at ${existing.server} (${existing.root}) - \`cotal meshes rm ${space}\` first, or --force to replace it`));
    process.exit(1);
  }

  // VERIFY BEFORE RECORDING. A wrong address, a broker that wants auth, creds that don't open this
  // space, an expired cred — all one probe away here, and every one of them would otherwise surface
  // as a confusing failure at the first `cotal spawn` against a record that looks fine. `--force`
  // is the explicit escape (registering a mesh that is currently down), and it says so on the
  // success line rather than pretending the mesh was checked.
  if (!v.force) {
    take(checkEnforcement(mode, await probeEnforcement(server), server, space, root));
    const verified = await verifyTarget(candidateTarget(space, server, root, mode, auth));
    if (!verified.ok) {
      console.error(c.red(verified.message));
      console.error(c.dim("nothing was registered - fix the above, or `--force` to record it without verifying (e.g. the mesh is down right now)"));
      process.exit(1);
    }
  }

  const result = writeRecord({ space, server, root, mode, origin: "manual", ts: new Date().toISOString() });
  console.log(
    c.green(`✓ registered "${space}"`),
    // "recorded without verifying" describes THIS registration, not a durable property of the
    // record: verification is point-in-time — a verified record loses it the moment a port is
    // reused — so it is reported as what just happened rather than persisted as a stored claim
    // that would quietly decay into a false one.
    c.dim(`${server}  ${mode}  ${root}${v.force ? "  (recorded without verifying)" : ""}`),
  );
  if (result.adoptedCurrent) {
    console.log(c.dim(`it is now the default mesh - \`cotal spawn\` from any directory joins it`));
    return;
  }
  if (result.keptCurrent) console.log(c.dim(`current is still "${result.keptCurrent}" - \`cotal use ${space}\` to switch`));
}

/** Take a rule's value, or print its sentence and exit — the flag form's whole error posture. */
function take<T>(r: Check<T>): T {
  if (r.ok) return r.value;
  console.error(c.red(r.message));
  process.exit(1);
}

// ---- rm -------------------------------------------------------------------------------------

/** `cotal meshes rm <space> …` — drop records. This never stops a mesh: it removes what THIS
 *  machine remembers about one. For a mesh running here that distinction is a footgun (the broker
 *  keeps running with nothing pointing at it), so those are refused in favour of `cotal down`. */
async function removeMeshes(names: string[], v: Values): Promise<void> {
  if (names.length === 0) {
    console.error(c.red("usage: cotal meshes rm <space> [<space> …]"));
    process.exit(1);
  }
  let failed = false;
  let clearedCurrent = false;
  for (const space of names) {
    const m = findMesh(space);
    if (!m) {
      console.error(c.red(`✗ no mesh named "${space}" is registered - see \`cotal meshes\``));
      failed = true;
      continue;
    }
    // Refuse only when THIS MACHINE demonstrably runs the mesh — a live recorded pid under its
    // root. Reachability was the wrong test: any broker on that address answers, including a
    // reused port or a foreign NATS, which produced a refusal plus a `cotal down` instruction that
    // would stop nothing. Local process ownership is the fact the refusal actually claims.
    //
    // It is asked only of records this machine started. Pidfiles are ROOT-scoped, and a root is
    // shared on purpose here: `add` defaults `--root` to the project you run it in, so a local mesh
    // and a registration for a remote one routinely live under one root. A pid there belongs to
    // whichever mesh owns the root — never to the remote broker — so asking this of a hand-registered
    // record can only produce a false "it is running here". That is safe to skip precisely because
    // provenance is now decided at the call site that started the broker: anything this machine
    // actually runs is stamped `up` and does reach the check.
    //
    // Skipped entirely under `--force`: the probe itself throws on a multi-tenant or unreadable
    // root, which must not defeat the documented override. Keyed on the entry's OWN space rather
    // than one re-resolved from the root, which on a multi-tenant root can name another tenant.
    const running = m.origin === "manual" || v.force ? undefined : liveMeshProcess(m.root, m.space);
    if (running) {
      console.error(c.red(`✗ "${space}" is running from ${m.root} (${running}) - \`cotal down\` there stops it and drops the record; --force drops the record only, leaving the mesh running`));
      failed = true;
      continue;
    }
    removeMesh(space);
    if (getCurrent() === space) {
      clearCurrent();
      clearedCurrent = true;
    }
    console.log(c.green(`✓ unregistered "${space}"`), c.dim(m.server));
  }
  if (clearedCurrent) console.log(c.dim("there is no default mesh now - `cotal use <name>` to set one"));
  if (failed) process.exit(1);
}

// ---- completion -----------------------------------------------------------------------------

export function meshesComplete(argv: string[]): CompletionResult {
  const flag = completingFlagValue(argv, meshesFlags);
  if (flag?.name === "mode") return { items: [{ value: "auth" }, { value: "open" }], directive: "nofiles" };
  if (flag?.name === "root") return { items: [], directive: "default" }; // a directory
  if (flag?.name === "server") return { items: [], directive: "nofiles" };
  const sub = argv[0];
  if (argv.length <= 1) return { items: SUBCOMMANDS.map((value) => ({ value })), directive: "nofiles" };
  // `rm` completes on what's registered; `add` names a mesh that by definition isn't.
  if (sub === "rm" || sub === "remove")
    return { items: loadMeshes().map((m) => ({ value: m.space })), directive: "nofiles" };
  return { items: [], directive: "nofiles" };
}
