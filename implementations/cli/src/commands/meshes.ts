import { readFileSync } from "node:fs";
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
import { liveMeshOwner } from "./clean.js";
import {
  candidateTarget,
  checkDialPolicy,
  checkEnforcement,
  checkMode,
  checkRoot,
  checkServer,
  checkTrust,
  checkUserBundle,
  persistRemoteUserEntry,
  probeEnforcement,
  spacesAtRoot,
  tlsIntent,
  userExchangeIssuer,
  verifyUserExchange,
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
  { name: "mode", type: "string", value: "<auth|open|user>", description: "add: how the broker authenticates (default: inferred from --root; user needs --user-auth-file or --from)" },
  { name: "user-auth-file", type: "string", value: "<bundle.json>", description: "add --mode user: the pinned-trust bundle exported where the mesh runs" },
  { name: "from", type: "string", value: "<https url>", description: "add --mode user: fetch the mesh's /.well-known/cotal-mesh discovery document (pins are shown and confirmed)" },
  { name: "force", type: "boolean", description: "add: record without verifying, replacing any existing record · rm: drop a running mesh's record" },
  { name: "tls", type: "boolean", description: "add: require TLS on every connection resolved through this record (a tls:// --server implies it)" },
  { name: "allow-unencrypted-overlay", type: "boolean", description: "add: accept that an overlay address is protected only while its tunnel is up (recorded on the entry)" },
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
    console.error(c.red("usage: cotal meshes add <space> --server <url> [--root <dir>] [--mode auth|open|user]"));
    process.exit(1);
  }
  // THE USER ARM — its own path because everything about it inverts the static flow: the server
  // comes from the supplied bundle rather than --server, trust composes against a pinned exchange
  // rather than on-disk material, and the enforcement PASS is the broker's refusal.
  if (v.mode === "user" || v["user-auth-file"] || v.from) return addUserMesh(space, v);
  // GUIDED FORM. A registration needs four facts, three of which the machine can find out — so a
  // command missing either irreducible one, on a real terminal, is an operator who would rather be
  // asked than read a usage line. Scripts and agents are unaffected: without a TTY (or with
  // COTAL_NO_PROMPT=1) the flag form's fail-loud sentences stand, which is what every smoke asserts.
  if ((!space || !v.server) && canPrompt()) {
    const done = await addWizard(
      { ...(space ? { space } : {}), ...(v.server ? { server: v.server } : {}), ...(v.root ? { root: v.root } : {}),
        ...(v.mode ? { mode: v.mode } : {}), ...(v.force ? { force: true } : {}),
        ...(v["allow-unencrypted-overlay"] ? { allowUnencryptedOverlay: true } : {}) },
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
    console.error(c.red("✗ --server <url> is required - a mesh you did not start here has no address to infer (e.g. --server nats://100.90.12.34:4222, its address on your private overlay)"));
    process.exit(1);
  }
  const server = take(checkServer(v.server));
  // The strictness this registration RECORDS — from --tls or a tls:// scheme — and therefore what
  // every dial through the record will enforce. Sourced once, so the dial policy, the candidate
  // probe and the written entry cannot disagree.
  const tlsRequired = tlsIntent(server, Boolean(v.tls));
  // Above the `--force` branch on purpose: this decides whether credentials may cross the network
  // to that address at all, which `--force` ("the mesh is down right now") must never waive.
  const dial = take(checkDialPolicy(server, { tlsRequired, allowUnencryptedOverlay: Boolean(v["allow-unencrypted-overlay"]) }));
  // A permitted-but-not-guaranteed target is SAID OUT LOUD, never recorded quietly. Today that is
  // the overlay literal whose protection depends on a tunnel we cannot verify from here; the
  // operator is the only one who can know whether it is up, so the operator is told.
  if (dial.residual) console.error(c.yellow(`! ${dial.residual}`));
  const root = take(checkRoot(v.root, process.cwd()));
  const accounts = take(spacesAtRoot(root));
  const mode = take(checkMode(space, root, accounts, v.mode, false));
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
    const verified = await verifyTarget(candidateTarget(space, server, root, mode, auth, tlsRequired));
    if (!verified.ok) {
      console.error(c.red(verified.message));
      console.error(c.dim("nothing was registered - fix the above, or `--force` to record it without verifying (e.g. the mesh is down right now)"));
      process.exit(1);
    }
  }

  const result = writeRecord({ space, server, root, mode, origin: "manual", ...(tlsRequired ? { tlsRequired: true } : {}), ...(dial.residual ? { unencryptedOverlay: true } : {}), ts: new Date().toISOString() });
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

/** `cotal meshes add <space> --mode user` — register a REMOTE user-auth mesh from supplied pinned
 *  trust. The pins are never guessed: they arrive in a bundle exported where the mesh runs
 *  (`--user-auth-file`), or in its HTTPS discovery document (`--from`), which is fetched, shown,
 *  and explicitly confirmed. Verification is the user arm's own: the pinned exchange must answer
 *  `/health` + `/jwks` as the pinned issuer, and the broker's auth-required refusal of a credless
 *  probe is the PASS. The registration still goes THROUGH the dial-policy fence — never around
 *  it — with the bundle's recorded strictness as the policy input. */
async function addUserMesh(spaceArg: string | undefined, v: Values): Promise<void> {
  if (v.mode !== undefined && v.mode !== "user") {
    console.error(c.red(`✗ --user-auth-file/--from register a user-auth mesh - they cannot be combined with --mode ${v.mode}`));
    process.exit(1);
  }
  if (v["user-auth-file"] && v.from) {
    console.error(c.red("✗ pass either --user-auth-file or --from, not both - they are two sources for the same pinned trust"));
    process.exit(1);
  }
  // No source supplied at all: this is the old blanket refusal's successor, and it must carry the
  // way through. checkMode owns the sentence so both front ends refuse identically.
  if (!v["user-auth-file"] && !v.from) {
    const refusal = checkMode(spaceArg ?? "", "", [], "user", false);
    console.error(c.red(refusal.ok ? "✗ --mode user needs --user-auth-file <bundle.json> or --from <https url>" : refusal.message));
    process.exit(1);
  }

  // ── the pins ────────────────────────────────────────────────────────────────────────────────
  let raw: string;
  if (v["user-auth-file"]) {
    try {
      raw = readFileSync(v["user-auth-file"], "utf8");
    } catch (e) {
      console.error(c.red(`✗ cannot read --user-auth-file ${v["user-auth-file"]} (${(e as Error).message})`));
      process.exit(1);
    }
  } else {
    // HTTPS ONLY. The document IS the trust being adopted; fetching it in plaintext would let the
    // network choose the pins, which is the exact failure pinning exists to prevent.
    let disco: URL;
    try {
      disco = new URL(v.from as string);
    } catch {
      console.error(c.red(`✗ --from is not a URL`));
      process.exit(1);
    }
    if (disco.protocol !== "https:") {
      console.error(c.red(`✗ --from must be an https:// URL - the discovery document carries the trust pins this registration adopts, and a plaintext fetch lets the network choose them`));
      process.exit(1);
    }
    // CONSENT BEFORE THE NETWORK. Fetching first meant a bare `--from <url>` reached out to a
    // host the operator had not yet agreed to talk to, and on a pipe it did so with no way to
    // agree at all. Ask for the address itself first; the pins fetched from it are confirmed
    // separately below.
    {
      const { canPrompt, clackIO } = await import("./meshes-wizard.js");
      if (!canPrompt()) {
        console.error(c.red("✗ --from needs a terminal to display and confirm the fetched pins - in a script, export the bundle where the mesh runs and pass it with --user-auth-file"));
        process.exit(1);
      }
      const goFetch = await clackIO().confirm({ message: `Fetch trust pins from ${disco.origin}?`, initialValue: false });
      if (!goFetch) {
        console.error(c.dim("nothing was fetched, nothing was registered"));
        process.exit(1);
      }
    }
    try {
      // `redirect: "manual"`: a 302 can walk an https fetch down to http or onto another host,
      // and the document IS the trust. A redirect is refused, never followed.
      const res = await fetch(disco, { redirect: "manual", signal: AbortSignal.timeout(10_000) });
      if (res.status >= 300 && res.status < 400) {
        console.error(c.red(`✗ ${disco} answered ${res.status} (a redirect to ${JSON.stringify(res.headers.get("location") ?? "")}) - a redirect can move the fetch onto plaintext or onto another host, so it is refused rather than followed; publish the discovery document at the URL you pass`));
        process.exit(1);
      }
      if (!res.ok) {
        console.error(c.red(`✗ ${disco} answered ${res.status} - no discovery document there`));
        process.exit(1);
      }
      raw = await res.text();
    } catch (e) {
      console.error(c.red(`✗ could not fetch ${disco} (${(e as Error).message})`));
      process.exit(1);
    }
  }
  const bundle = take(checkUserBundle(raw));
  const space = spaceArg ?? bundle.space;
  if (spaceArg && bundle.space !== spaceArg) {
    console.error(c.red(`✗ the bundle is for space "${bundle.space}" but the command names "${spaceArg}" - a bundle registers the space it was exported for`));
    process.exit(1);
  }

  // A FETCHED document is displayed and explicitly confirmed before anything trusts it: the
  // operator, not the network, adopts the pins. A file the operator already holds needs no
  // confirmation — supplying it is the consent.
  if (v.from) {
    const { canPrompt, clackIO } = await import("./meshes-wizard.js");
    if (!canPrompt()) {
      console.error(c.red("✗ --from needs a terminal to display and confirm the fetched pins - in a script, export the bundle where the mesh runs and pass it with --user-auth-file"));
      process.exit(1);
    }
    const io = clackIO();
    io.note(
      [
        `space     ${bundle.space}`,
        `broker    ${bundle.server}${bundle.tlsRequired ? "  (TLS required)" : ""}`,
        `IdP       ${bundle.userAuth.idp.url}`,
        `issuer    ${bundle.userAuth.idp.issuer}`,
        `audience  ${bundle.userAuth.idp.audience}`,
        `exchange  ${bundle.userAuth.endpoints?.url}`,
      ].join("\n"),
      "Pins fetched - trust them only if they match what the mesh's operator published",
    );
    const goOn = await io.confirm({ message: "Adopt these pins and register the mesh?", initialValue: false });
    if (!goOn) {
      console.error(c.dim("nothing was registered"));
      return;
    }
  }

  // ── the same fences as every other registration ──────────────────────────────────────────
  const server = take(checkServer(v.server ?? bundle.server));
  // The bundle's recorded strictness is a TLS-intent source of its own, alongside --tls and the
  // scheme: the export states what the mesh's transport requires, and the record must carry it.
  const tlsRequired = bundle.tlsRequired || tlsIntent(server, Boolean(v.tls));
  const dial = take(checkDialPolicy(server, { tlsRequired, allowUnencryptedOverlay: Boolean(v["allow-unencrypted-overlay"]) }));
  if (dial.residual) console.error(c.yellow(`! ${dial.residual}`));
  const root = take(checkRoot(v.root, process.cwd()));
  take(checkMode(space, root, [], "user", true));

  const existing = findMesh(space);
  if (existing && !v.force) {
    console.error(c.red(`✗ "${space}" is already registered at ${existing.server} (${existing.root}) - \`cotal meshes rm ${space}\` first, or --force to replace it`));
    process.exit(1);
  }

  // ── the user arm's verification ────────────────────────────────────────────────────────────────
  // Trust: the pinned exchange must answer as itself. Enforcement: the broker must REFUSE a bare
  // connect — auth-required is the pass, because a user-mode target has no probe credential by
  // design (preflightTarget refuses user targets outright for exactly that reason). Both run even
  // under --force: unlike a static mesh, there is no "register it while it is down" story here —
  // an unverifiable pin set is not a record worth writing.
  take(await verifyUserExchange(bundle.userAuth.endpoints!.url!, userExchangeIssuer(bundle.space)));
  take(checkEnforcement("user", await probeEnforcement(server), server, space, root));

  const result = persistRemoteUserEntry(space, server, root, bundle, tlsRequired, Boolean(dial.residual));
  console.log(c.green(`✓ registered "${space}"`), c.dim(`${server}  user  ${root}`));
  console.log(c.dim(`  pinned issuer ${bundle.userAuth.idp.issuer} · exchange ${bundle.userAuth.endpoints?.url}`));
  if (result.adoptedCurrent) console.log(c.dim(`it is now the default mesh - \`cotal spawn\` from any directory joins it`));
  else if (result.keptCurrent) console.log(c.dim(`current is still "${result.keptCurrent}" - \`cotal use ${space}\` to switch`));
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
    const running = m.origin === "manual" || v.force ? undefined : liveMeshOwner(m.root, m.space);
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
  if (flag?.name === "mode") return { items: [{ value: "auth" }, { value: "open" }, { value: "user" }], directive: "nofiles" };
  if (flag?.name === "user-auth-file") return { items: [], directive: "default" }; // a file
  if (flag?.name === "from") return { items: [], directive: "nofiles" };
  if (flag?.name === "root") return { items: [], directive: "default" }; // a directory
  if (flag?.name === "server") return { items: [], directive: "nofiles" };
  const sub = argv[0];
  if (argv.length <= 1) return { items: SUBCOMMANDS.map((value) => ({ value })), directive: "nofiles" };
  // `rm` completes on what's registered; `add` names a mesh that by definition isn't.
  if (sub === "rm" || sub === "remove")
    return { items: loadMeshes().map((m) => ({ value: m.space })), directive: "nofiles" };
  return { items: [], directive: "nofiles" };
}
