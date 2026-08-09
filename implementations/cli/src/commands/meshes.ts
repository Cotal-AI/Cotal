import { resolve } from "node:path";
import { isReachable, type CompletionResult, type FlagSpec, type FlagValues, type ParsedArgs } from "@cotal-ai/core";
import {
  authDir,
  clearCurrent,
  findCotalRoot,
  findMesh,
  getCurrent,
  homeCotalDir,
  listSpaceAccounts,
  loadMeshes,
  loadSpaceAuth,
  personaDir,
  preflightTarget,
  recordMesh,
  removeMesh,
  setCurrent,
  type MeshEntry,
  type MeshTarget,
  type PreflightFailure,
} from "@cotal-ai/workspace";
import { c } from "../ui.js";
import { pruneStaleMeshes } from "../lib/meshes.js";
import { completingFlagValue } from "../lib/completion.js";

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
  if (!space || positionals.length > 1) {
    console.error(c.red("usage: cotal meshes add <space> --server <url> [--root <dir>] [--mode auth|open]"));
    process.exit(1);
  }
  if (!v.server) {
    console.error(c.red("✗ --server <url> is required - a mesh you did not start here has no address to infer (e.g. --server nats://10.0.0.5:4222)"));
    process.exit(1);
  }
  const root = addRoot(v.root);
  const accounts = listSpaceAccounts(authDir(root));
  const mode = addMode(space, root, accounts, v.mode);

  const existing = findMesh(space);
  if (existing && !v.force) {
    console.error(c.red(`✗ "${space}" is already registered at ${existing.server} (${existing.root}) - \`cotal meshes rm ${space}\` first, or --force to replace it`));
    process.exit(1);
  }

  // VERIFY BEFORE RECORDING. A wrong address, a broker that wants auth, creds that don't open this
  // space, an expired cred — all of them are one probe away here, and every one of them would
  // otherwise surface as a confusing failure at the first `cotal spawn` against a record that looks
  // fine. `--force` is the explicit escape (registering a mesh that is currently down), and it says
  // so on the success line rather than pretending the mesh was checked.
  if (!v.force) {
    const target: MeshTarget = {
      root,
      server: v.server,
      space,
      mode,
      ...(mode === "auth" ? { auth: loadSpaceAuth(authDir(root), space) } : {}),
      personaRoot: personaDir(root),
      // Nothing is recorded yet, so this probe owns no registry entry: `flag-server` is the source
      // that can never classify as a prune.
      source: "flag-server",
    };
    const r = await preflightTarget(target);
    if (!r.ok) {
      console.error(c.red(addFailure(r.kind, space, v.server, root)));
      console.error(c.dim("nothing was registered - fix the above, or `--force` to register it unverified (e.g. the mesh is down right now)"));
      process.exit(1);
    }
  }

  const entry: MeshEntry = { space, server: v.server, root, mode, origin: "manual", ts: new Date().toISOString() };
  const cur = getCurrent();
  const usableCurrent = cur && findMesh(cur) ? cur : undefined; // compute before recording
  recordMesh(entry);
  console.log(
    c.green(`✓ registered "${space}"`),
    c.dim(`${v.server}  ${mode}  ${root}${v.force ? "  (unverified)" : ""}`),
  );
  // Same policy as `cotal up`: adopt the default only when there isn't a usable one, and never
  // silently redirect a default that still resolves.
  if (!usableCurrent) {
    setCurrent(space);
    console.log(c.dim(`it is now the default mesh - \`cotal spawn\` from any directory joins it`));
    return;
  }
  if (usableCurrent !== space) console.log(c.dim(`current is still "${usableCurrent}" - \`cotal use ${space}\` to switch`));
}

/** Where this mesh's local trust + personas live. Defaults to the project the command was run in
 *  (the walk-up that every other command uses); outside a project there is nothing to infer, so
 *  `--root` is required rather than silently recording the machine-home dir as a mesh root. */
function addRoot(flag: string | undefined): string {
  if (flag) return resolve(flag);
  const root = findCotalRoot(process.cwd());
  if (resolve(root, ".cotal") === resolve(homeCotalDir())) {
    console.error(c.red("✗ --root <dir> is required outside a mesh project - it is the folder whose .cotal/auth holds this mesh's credentials and whose .cotal/agents holds its personas"));
    process.exit(1);
  }
  return root;
}

/** The recorded auth mode: what the operator said, or what `--root` proves. A root holding this
 *  space's account record means auth; anything else is an open broker. Both wrong answers fail
 *  loud here rather than at connect time. */
function addMode(space: string, root: string, accounts: string[], flag: string | undefined): MeshEntry["mode"] {
  if (flag !== undefined && flag !== "auth" && flag !== "open" && flag !== "user") {
    console.error(c.red(`✗ --mode must be auth or open (got "${flag}")`));
    process.exit(1);
  }
  // A user-auth mesh is registered by the login/exchange trust it was configured with — an issuer,
  // an audience and an IdP URL that are pinned at `cotal up --user-auth`, not derivable from a
  // broker URL. Guessing them here would be inventing trust, so refuse instead of half-recording.
  if (flag === "user") {
    console.error(c.red(`✗ --mode user cannot be registered by hand - a user-auth space carries pinned IdP trust (issuer, audience, login URL) that only \`cotal up --user-auth\` establishes, in the root where its broker runs`));
    process.exit(1);
  }
  const mode = flag ?? (accounts.includes(space) ? "auth" : "open");
  if (mode === "auth" && !accounts.includes(space)) {
    console.error(c.red(`✗ --mode auth needs "${space}"'s trust material under ${authDir(root)}${accounts.length ? ` (it holds "${accounts.join('", "')}")` : " (it holds none)"} - copy the mesh's account + creds there, point --root at where they already are, or register it --mode open`));
    process.exit(1);
  }
  if (mode === "open" && accounts.includes(space))
    console.log(c.dim(`note: ${authDir(root)} holds trust for "${space}", but --mode open records a credless connect`));
  return mode;
}

/** The registration-time wording for a failed probe. Deliberately NOT the shared preflight copy:
 *  that speaks to a mesh already in the registry ("stale entry", "re-run `cotal up`"), and here
 *  nothing is recorded yet — the operator is being told what to fix in the command they just ran. */
function addFailure(kind: PreflightFailure, space: string, server: string, root: string): string {
  switch (kind) {
    case "unreachable":
      return `✗ no broker answered at ${server} - check the address and that the mesh is up on that machine`;
    case "creds-rejected":
    case "registry-creds-rejected":
      return `✗ the broker at ${server} rejected the credentials for "${space}" under ${authDir(root)} - re-mint them where the mesh runs, or check that --server points at that mesh`;
    case "open-wants-auth":
    case "registry-open-now-auth":
      return `✗ the broker at ${server} requires auth, but nothing under ${authDir(root)} covers "${space}" - copy the mesh's account + creds there and re-run with --mode auth`;
    case "stale-auth":
      return `✗ the credentials for "${space}" under ${authDir(root)} have EXPIRED - re-mint them where the mesh runs (the broker itself is up)`;
  }
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
    if (m.origin !== "manual" && !v.force && (await isReachable(m.server))) {
      console.error(c.red(`✗ "${space}" is running from ${m.root} - \`cotal down\` there stops it and drops the record; --force drops the record only, leaving the mesh running`));
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
