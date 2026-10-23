import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { listSpaces, token } from "@cotal-ai/core";
import {
  CommandFailure,
  authDir,
  canonicalRoot,
  checkDiscoveryDocument,
  clearCurrent,
  discoveryDocumentUrl,
  findMesh,
  findPreparedSpace,
  getCurrent,
  homeCotalDir,
  loadMeshes,
  pinnedFetch,
  preparedSpaceAt,
  protectedLocalDirectory,
  readPreferences,
  recordMesh,
  recordPreparedSpace,
  removeMesh,
  removePreparedSpace,
  removeSpacePreferences,
  writeResult,
  type Cell,
  type Check,
  type MeshEntry,
  type OutputWarning,
  type Presentation,
  type RefusalCode,
  type Report,
  type UserBundle,
} from "@cotal-ai/workspace";
import { liveMeshOwner, unsettledStackMembers } from "./clean.js";
import { seedDefaultPersona } from "../lib/default-persona.js";
import {
  candidateTarget,
  checkDialPolicy,
  checkEnforcement,
  checkMode,
  checkRoot,
  checkServer,
  checkTrust,
  checkUserBundle,
  probeEnforcement,
  remoteUserEntry,
  spacesAtRoot,
  tlsIntent,
  userExchangeIssuer,
  verifyTarget,
  verifyUserExchange,
} from "./meshes-add.js";
import { canPrompt, clackIO } from "./meshes-wizard.js";
import { detail, type SpaceDetail } from "./space.js";
import { MissingFlags } from "../lib/missing-flags.js";
import { readStackJournal } from "../lib/stack-journal.js";

/** The flags only `space add` takes. */
export const ADD_FLAGS = ["file", "from", "server", "root", "mode", "tls", "allow-unencrypted-overlay", "force", "yes"] as const;

export interface AddValues {
  readonly file?: string;
  readonly from?: string;
  readonly server?: string;
  readonly root?: string;
  readonly mode?: string;
  readonly tls?: boolean;
  readonly "allow-unencrypted-overlay"?: boolean;
  readonly force?: boolean;
  readonly yes?: boolean;
}

export interface SpaceAdded {
  readonly kind: "space-added";
  /** The registration as `cotal space show` reports it. */
  readonly space: SpaceDetail;
  /** Whether the broker was checked before the record was written; false under `--force`. */
  readonly verified: boolean;
  /** Whether it replaced an earlier registration of the same name. */
  readonly replaced: boolean;
}

interface AddCancelled {
  readonly kind: "space-add-cancelled";
  /** The space named on the command line, or null when it was to come from a bundle. */
  readonly space: string | null;
}

interface SpaceCreated {
  readonly kind: "space-created";
  readonly space: string;
  /** The folder `cotal up` starts the space in. */
  readonly root: string;
  readonly preparedAt: string;
  readonly current: boolean;
  /** Every file create wrote: the prepared record, and the default persona when the root had none. */
  readonly written: readonly { readonly what: string; readonly path: string }[];
}

interface SpaceForgotten {
  readonly kind: "space-forgotten";
  readonly space: string;
  /** The broker it was registered at, or null for a prepared space, which has none. */
  readonly server: string | null;
  readonly root: string;
  /** How it came to be here: a registration's origin, or `prepared` for a space `space create` made. */
  readonly origin: MeshEntry["origin"] | "prepared" | null;
  /** Whether it was the selected space, so no space is selected now. */
  readonly selectionCleared: boolean;
  /** The per-space preferences saved under its name that the forget removed, by key. */
  readonly removedPreferences: Readonly<Partial<Record<string, string>>>;
}

const usage = (message: string, remedy?: string): CommandFailure => new CommandFailure("refused", "USAGE_INVALID", message, remedy ? { remedy } : {});

/** A rule's value, or its refusal as a {@link CommandFailure} with the code the rule gives. */
function take<T>(check: Check<T>, target: unknown): T {
  if (check.ok) return check.value;
  if (!check.code) throw new Error(`internal error: a registration rule refused without a code: ${check.message}`);
  throw new CommandFailure("refused", check.code, check.message.replace(/^✗ /, ""), { target });
}

const refuse = (code: RefusalCode, message: string, target: unknown, remedy?: string): CommandFailure =>
  new CommandFailure("refused", code, message, { target, ...(remedy ? { remedy } : {}) });

/** Only a registration added by hand can be replaced; one this machine started or a catalog lists
 *  is forgotten or stopped first. */
function replaceable(name: string, force: boolean, target: unknown): boolean {
  if (findPreparedSpace(name))
    throw refuse("CONFLICT", `"${name}" is a space prepared on this machine`, target, `start it with \`cotal up\` in its root, or forget it with \`cotal space forget ${name}\``);
  const existing = findMesh(name);
  if (!existing) return false;
  // `--force` replaces only a registration added by hand, so the refusal offers it only for one.
  if (existing.origin !== "manual") {
    const owner = existing.origin === "catalog" ? "listed by a signed-in space catalog" : "a space this machine started";
    throw refuse("CONFLICT", force ? `"${name}" is ${owner}, so --force does not replace it` : `"${name}" is already registered at ${existing.server}; it is ${owner}`, target, `see it with \`cotal space show ${name}\``);
  }
  if (!force) throw refuse("CONFLICT", `"${name}" is already registered at ${existing.server}`, target, `forget it first with \`cotal space forget ${name}\`, or pass --force to replace it`);
  return true;
}

/** Shows what the registration will trust and asks before it is written. Without a terminal, or
 *  when `skip` is set (`--yes` where the question is not a guard), the command line is the consent. */
async function review(prompt: boolean, skip: boolean, rows: readonly (readonly [string, string])[], title: string, initialValue: boolean): Promise<boolean> {
  if (!prompt || skip) return true;
  const io = clackIO();
  const pad = Math.max(...rows.map(([label]) => label.length));
  io.note(rows.map(([label, value]) => `${label.padEnd(pad)}  ${value}`).join("\n"), title);
  return (await io.confirm({ message: "Add it?", initialValue })) === true;
}

/**
 * `cotal space add [<name>]` registers a space that runs elsewhere: from `--server` with the trust
 * under `--root`, or from a user-auth connection bundle (`--file`, or `--from` to fetch the
 * space's discovery document). Every check runs before anything is written: the address may carry
 * credentials, the trust composes, the broker enforces the mode, and the credentials open the
 * space. On a terminal the trust is shown and confirmed first. The selection is left as it is.
 */
export async function spaceAdd(rest: readonly string[], v: AddValues, presentation: Presentation): Promise<void> {
  if (rest.length > 1) throw usage("usage: cotal space add [<name>] --server <url> | --file <bundle.json> | --from <https url>");
  const name = rest[0];
  if (v.file !== undefined && v.from !== undefined) throw usage("pass --file or --from, not both: they are two sources for the same pinned trust");
  const bundled = v.file !== undefined || v.from !== undefined;
  if (bundled && v.mode !== undefined && v.mode !== "user") throw usage(`--file and --from add a user-auth space, so they do not take --mode ${v.mode}`);
  if (v.mode === "user" && !bundled)
    throw usage("--mode user needs the space's pinned trust", "pass --file <bundle.json> exported where the space runs, or --from <https url> to fetch its discovery document");
  const prompt = presentation !== "json" && canPrompt();
  const added = bundled ? await addFromBundle(name, v, prompt) : await addFromServer(name, v, prompt);
  if (added === undefined) {
    const target = name ? { space: name } : null;
    const result: AddCancelled = { kind: "space-add-cancelled", space: name ?? null };
    writeResult(presentation, { command: "space", target, result, noOp: true, warnings: [{ code: "USER_CANCELLED", target, message: "nothing was added" }] }, addedView);
    return;
  }
  writeResult(presentation, { command: "space", target: { space: added.result.space.space }, result: added.result, warnings: added.warnings }, addedView);
}

export type Added = { readonly result: SpaceAdded; readonly warnings: OutputWarning[] } | undefined;

async function addFromServer(name: string | undefined, v: AddValues, prompt: boolean): Promise<Added> {
  if (name === undefined) throw usage("name the space to add", "cotal space add <name> --server <url>");
  const target = { space: name };
  if (v.server === undefined) throw usage("--server <url> is required: a space that runs elsewhere has no address to infer", "pass its broker URL, for example --server nats://100.90.12.34:4222");
  const server = take(checkServer(v.server, "--server"), target);
  const tlsRequired = tlsIntent(server, v.tls === true);
  const dial = take(checkDialPolicy(server, { tlsRequired, allowUnencryptedOverlay: v["allow-unencrypted-overlay"] === true }), target);
  const rootCheck = checkRoot(v.root, process.cwd());
  // With no --root, the one way it fails is the flag left out: its line and remedy, not the help.
  if (!rootCheck.ok && v.root === undefined) throw new MissingFlags(rootCheck.message.replace(/^✗ /, ""), "pass --root <dir>: for an open space any folder will do, such as a new empty one; for an auth space, the folder whose .cotal/auth holds its trust", target);
  const root = take(rootCheck, target);
  const accounts = take(spacesAtRoot(root), target);
  const mode = take(checkMode(name, root, accounts, v.mode, false), target);
  const auth = take(checkTrust(mode, root, name), target);
  const replaced = replaceable(name, v.force === true, target);
  const verified = v.force !== true;
  if (verified) {
    take(checkEnforcement(mode, await probeEnforcement(server), server, name, root), target);
    take(await verifyTarget(candidateTarget(name, server, root, mode, auth, tlsRequired)), target);
    if (mode === "open") await servedOrThrow(server, name, target);
  }
  const warnings: OutputWarning[] = [];
  if (dial.residual) warnings.push({ code: "UNENCRYPTED_OVERLAY", target, message: dial.residual });
  if (mode === "open" && accounts.includes(name))
    warnings.push({ code: "TRUST_NOT_USED", target, message: `${authDir(root)} holds trust for "${name}", but --mode open adds a connection with no credentials` });
  const rows: [string, string][] = [
    ["space", name],
    ["broker", `${server}${tlsRequired ? " (TLS required)" : ""}`],
    ["mode", mode === "auth" ? `auth, with the trust under ${authDir(root)}` : "open, with no credentials"],
    ["root", root],
    ["checked", verified ? `the broker answers and enforces this mode${mode === "open" ? ", and serves this space" : ""}` : "nothing: --force adds it unchecked"],
  ];
  if (!(await review(prompt, v.yes === true, rows, `Add ${name}`, true))) return undefined;
  const entry: MeshEntry = { space: name, server, root, mode, origin: "manual", ...(tlsRequired ? { tlsRequired: true } : {}), ...(dial.residual ? { unencryptedOverlay: true } : {}), ts: new Date().toISOString() };
  recordMesh(entry);
  return { result: { kind: "space-added", space: detail(entry, getCurrent() ?? null, verified ? "reachable" : "not-checked"), verified, replaced }, warnings };
}

/** An open broker answers for any name, so an open space must be one it serves, or a mistyped
 *  name is recorded and every later operation on it fails without naming it. The spaces it serves
 *  are read back from their streams, which a bare connection to an open broker may list. */
async function servedOrThrow(server: string, name: string, target: unknown): Promise<void> {
  let served: string[];
  try { served = (await listSpaces({ servers: server })).map((info) => info.space); }
  catch { throw refuse("TARGET_UNAVAILABLE", `the broker at ${server} answered, but the spaces it serves could not be read`, target, `retry, or pass --force to add "${name}" unchecked`); }
  if (served.includes(token(name))) return;
  throw refuse("TARGET_NOT_FOUND", served.length ? `the broker at ${server} serves no space named "${name}"; it serves ${served.map((space) => `"${space}"`).join(", ")}` : `the broker at ${server} serves no space yet, so "${name}" is not running there`,
    target, served.length ? `add one of those names, or pass --force to add "${name}" before it starts there` : `start it there with \`cotal up --open\`, or pass --force to add "${name}" unchecked`);
}

/** A user-auth space: its pins come from a bundle exported where it runs, or from its HTTPS
 *  discovery document, which is fetched only after the operator agrees and is adopted only after
 *  they confirm the pins. Its checks run even under `--force`, which only replaces a record.
 *  `cotal setup --connection-file` registers a self-hosted space through it. */
export async function addFromBundle(name: string | undefined, v: AddValues, prompt: boolean): Promise<Added> {
  const target = name ? { space: name } : null;
  let bundle: UserBundle;
  if (v.file !== undefined) {
    bundle = readConnectionFile(v.file, "--file", target);
  } else {
    let disco: URL;
    try {
      const from = new URL(v.from!);
      disco = from.pathname.endsWith("/.well-known/cotal-mesh") ? from : discoveryDocumentUrl(from);
    } catch {
      throw usage("--from is not a URL");
    }
    if (disco.protocol !== "https:") throw usage("--from must be an https:// URL: the discovery document carries the trust pins, and a plaintext fetch lets the network choose them");
    if (!prompt) throw usage("--from needs a terminal to show and confirm the fetched pins", "in a script, export the bundle where the space runs and pass it with --file");
    const io = clackIO();
    if ((await io.confirm({ message: `Fetch trust pins from ${disco}?`, initialValue: false })) !== true) return undefined;
    let res: Response;
    try {
      res = await pinnedFetch(disco.toString(), `--from ${disco}`);
    } catch (e) {
      const m = (e as Error).message;
      throw refuse(m.startsWith("✗") ? "UNSUPPORTED" : "TARGET_UNAVAILABLE", m.startsWith("✗") ? m.slice(2) : `could not fetch ${disco} (${m})`, target);
    }
    if (!res.ok) throw refuse("TARGET_UNAVAILABLE", `${disco} answered ${res.status}: no discovery document there`, target);
    bundle = take(await checkDiscoveryDocument(res), target);
  }
  const space = name ?? bundle.space;
  const spaceTarget = { space };
  if (name !== undefined && bundle.space !== name) throw refuse("CONFLICT", `the bundle is for "${bundle.space}", not "${name}": a bundle adds the space it was exported for`, spaceTarget);
  const server = take(v.server === undefined ? checkServer(bundle.server, "the bundle's server") : checkServer(v.server, "--server"), spaceTarget);
  const tlsRequired = bundle.tlsRequired || tlsIntent(server, v.tls === true);
  const dial = take(checkDialPolicy(server, { tlsRequired, allowUnencryptedOverlay: v["allow-unencrypted-overlay"] === true }), spaceTarget);
  const root = take(checkRoot(v.root, process.cwd()), spaceTarget);
  take(checkMode(space, root, [], "user", true), spaceTarget);
  const replaced = replaceable(space, v.force === true, spaceTarget);
  take(await verifyUserExchange(bundle.userAuth.endpoints!.url!, userExchangeIssuer(bundle.space)), spaceTarget);
  take(checkEnforcement("user", await probeEnforcement(server), server, space, root), spaceTarget);
  const rows: [string, string][] = [
    ["space", space],
    ["broker", `${server}${tlsRequired ? " (TLS required)" : ""}`],
    ["IdP", bundle.userAuth.idp.url],
    ["issuer", bundle.userAuth.idp.issuer],
    ["audience", bundle.userAuth.idp.audience],
    ["exchange", bundle.userAuth.endpoints!.url!],
    ["root", root],
  ];
  // A fetched document is always confirmed: the operator, not the network, adopts its pins.
  const title = "Trust these pins only if they match what the space's operator published";
  if (!(await review(prompt, v.yes === true && v.from === undefined, rows, title, false))) return undefined;
  const entry = remoteUserEntry(space, server, root, bundle, tlsRequired, Boolean(dial.residual));
  recordMesh(entry);
  const warnings: OutputWarning[] = dial.residual ? [{ code: "UNENCRYPTED_OVERLAY", target: spaceTarget, message: dial.residual }] : [];
  return { result: { kind: "space-added", space: detail(entry, getCurrent() ?? null, "reachable"), verified: true, replaced }, warnings };
}

/** A user-auth connection bundle read from `file` and checked; `flag` names the input in a refusal. */
export function readConnectionFile(file: string, flag: string, target: unknown): UserBundle {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (e) {
    throw usage(`cannot read ${flag} ${file} (${(e as NodeJS.ErrnoException).code ?? (e as Error).message})`);
  }
  return take(checkUserBundle(raw), target);
}

/** What `cotal setup --destination self-hosted` finds for a space: a registration to use as it is,
 *  or a connection file to register it from. */
export type SelfHostedSpace = { readonly kind: "registered"; readonly entry: MeshEntry } | { readonly kind: "add"; readonly file: string };

/**
 * The checks `cotal setup` runs for a self-hosted space before it writes anything. The space must
 * be one registered here by hand or by a catalog, with `project` as its root, or come with a
 * connection file that `space add --file` would accept. A connection file for a space already
 * registered must name the same space and broker, so a rerun with the same answers changes nothing.
 */
export function checkSelfHostedSpace(space: string, project: string, connectionFile: string | undefined): SelfHostedSpace {
  const target = { space };
  if (findPreparedSpace(space)) throw refuse("CONFLICT", `"${space}" is a space prepared on this machine`, target, "set it up with --destination local");
  const entry = findMesh(space);
  if (entry?.origin === "up") throw refuse("CONFLICT", `"${space}" is a space this machine starts`, target, "set it up with --destination local");
  if (!entry) {
    if (connectionFile === undefined)
      throw refuse("TARGET_NOT_FOUND", `no space named "${space}" is registered here`, target, "register it with `cotal space add`, or pass --connection-file <bundle.json>");
    return { kind: "add", file: connectionFile };
  }
  if (canonicalRoot(entry.root) !== canonicalRoot(project))
    throw refuse("CONFLICT", `"${space}" is registered with the root ${entry.root}, not ${project}`, target, `pass --project ${entry.root}`);
  if (connectionFile !== undefined) {
    const bundle = readConnectionFile(connectionFile, "--connection-file", target);
    if (bundle.space !== space) throw refuse("CONFLICT", `the bundle is for "${bundle.space}", not "${space}": a bundle adds the space it was exported for`, target);
    const server = take(checkServer(bundle.server, "the bundle's server"), target);
    if (server !== entry.server)
      throw refuse("CONFLICT", `"${space}" is registered at ${entry.server}, and the bundle names ${server}`, target, `forget it first with \`cotal space forget ${space}\``);
  }
  return { kind: "registered", entry };
}

function addedView(r: SpaceAdded | AddCancelled): Report {
  if (r.kind === "space-add-cancelled") return { sections: [{ blocks: [{ kind: "lines", lines: [{ text: "nothing was added", tone: "hint" }] }] }] };
  const s = r.space;
  const head: Cell = { text: `${r.replaced ? "replaced" : "added"} ${s.space}`, tone: "ok", mark: "✓" };
  const fields: [string, Cell][] = [
    ["server", s.server],
    ["mode", s.mode],
    ["root", s.root],
    ["checked", r.verified ? { text: s.mode === "open" ? "broker answered and serves this space" : "broker answered", tone: "ok" } : { text: "not checked (--force)", tone: "waiting" }],
  ];
  if (s.userAuth) fields.push(["login", s.userAuth.idp.url]);
  const hints: Cell[] = s.current ? [] : [{ text: `select it with \`cotal use ${s.space}\``, tone: "hint" }];
  return { sections: [{ blocks: [{ kind: "lines", lines: [head] }, { kind: "fields", rows: fields }, ...(hints.length ? [{ kind: "lines" as const, lines: hints }] : [])] }] };
}

/**
 * `cotal space create <name>` prepares a space to start on this machine: it records the name and
 * the root, and makes `<root>/.cotal/` so `cotal up` there starts it under that name. It seeds the
 * default persona there as setup does, so a bare `cotal spawn` in the space has one to launch. It
 * starts nothing, and the selection is left as it is. The root is `--root`, else this folder.
 */
export async function spaceCreate(rest: readonly string[], rootFlag: string | undefined, presentation: Presentation): Promise<void> {
  if (rest.length !== 1 || rest[0]!.trim() === "") throw usage("usage: cotal space create <name> [--root <dir>]");
  const name = rest[0]!;
  const root = resolve(rootFlag ?? process.cwd());
  if (!isDir(root)) throw usage(`--root ${root} is not a directory`, "create the folder first, or pass an existing one");
  checkLocalSpace(name, root, "--root", false);
  const prepared = recordLocalSpace(name, root);
  const written = [{ what: "prepared space", path: prepared.file }];
  const persona = seedDefaultPersona(root);
  if (persona) written.push(persona);
  const result: SpaceCreated = { kind: "space-created", space: name, root, preparedAt: prepared.preparedAt, current: getCurrent() === name, written };
  writeResult(presentation, { command: "space", target: { space: name }, result }, createdView);
}

/** Where a space this machine starts stands at a root: prepared now, prepared before, or started
 *  there before. */
export type LocalSpaceState = "created" | "prepared" | "started";

/**
 * The checks `space create` runs before it prepares `name` at `root`; it writes nothing. `flag`
 * names the input that chose the root. With `again`, a space already prepared or started at this
 * same root is reported as its state instead of refused, so `cotal setup` run again with the same
 * answers changes nothing.
 */
export function checkLocalSpace(name: string, root: string, flag: "--root" | "--project", again: boolean): LocalSpaceState {
  const target = { space: name };
  // `cotal up` starts a space only under a name that is one native routing token.
  if (name.length > 200 || token(name) !== name)
    throw refuse("USAGE_INVALID", "a space name is 1 to 200 letters, digits, underscores or hyphens, which `cotal up` needs to start it", target);
  if (resolve(root, ".cotal") === resolve(homeCotalDir()) || canonicalRoot(root) === canonicalRoot(homedir()))
    throw refuse("CONFLICT", `${root} is your home folder, whose .cotal holds this machine's own records`, target, `create the space in a project folder, or pass ${flag} <dir>`);
  const here = (other: string): boolean => canonicalRoot(other) === canonicalRoot(root);
  const registered = findMesh(name);
  if (registered) {
    if (again && registered.origin === "up" && here(registered.root)) return "started";
    throw refuse("CONFLICT", `"${name}" is already registered at ${registered.server}`, target, `see it with \`cotal space show ${name}\``);
  }
  const prepared = findPreparedSpace(name);
  if (prepared) {
    if (again && here(prepared.root)) return "prepared";
    throw refuse("CONFLICT", `"${name}" is already prepared in ${prepared.root}`, target, `start it with \`cotal up\` there, or forget it with \`cotal space forget ${name}\``);
  }
  const held = [...new Set([...take(spacesAtRoot(root), target), ...loadMeshes().filter((m) => here(m.root)).map((m) => m.space), ...[preparedSpaceAt(root)?.space].filter((s): s is string => s !== undefined)])];
  // A space started here before and stopped since keeps its trust in this root.
  if (again && held.length === 1 && held[0] === name) return "started";
  if (held.length > 0) {
    // This root's stack journal: its space, undefined when there is none, null when it cannot be read.
    let journaled: string | null | undefined = null;
    try { journaled = readStackJournal(root)?.journal.space; } catch { journaled = null; }
    // A controller stack whose registration is gone, after a refused first start or a forget, keeps
    // its trust and stack journal for this same space here. Preparing it again restores what its
    // next start needs; any other space's trust still refuses.
    if (held.length === 1 && held[0] === name && journaled === name) return "created";
    // A space stopped here keeps its trust in this root after its registration is gone, and a plain
    // `cotal up` from this root starts it again on its own launcher. Only that one space can run here.
    // A root with a controller stack journal is not offered that, because its start needs a prepared
    // or locally started registration.
    const stopped = held.length === 1 && journaled === undefined && !loadMeshes().some((m) => here(m.root)) && preparedSpaceAt(root) === undefined;
    throw refuse("CONFLICT", `${root} is already the root of "${held.join('", "')}"`, target, stopped
      ? `start "${held[0]}" again with \`cotal up\` from ${root}${held[0] === name ? "" : `, or create "${name}" in another folder with ${flag} <dir>`}`
      : `create the space in another folder, or pass ${flag} <dir>`);
  }
  return "created";
}

/** Prepares a space {@link checkLocalSpace} cleared: makes `<root>/.cotal/` and records the space.
 *  Returns the record it wrote and when. */
export function recordLocalSpace(name: string, root: string): { file: string; preparedAt: string } {
  protectedLocalDirectory(root, "the project root");
  mkdirSync(join(root, ".cotal"), { recursive: true, mode: 0o700 });
  protectedLocalDirectory(join(root, ".cotal"), "the project's .cotal directory");
  const preparedAt = new Date().toISOString();
  return { file: recordPreparedSpace({ space: name, root, ts: preparedAt }), preparedAt };
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function createdView(r: SpaceCreated): Report {
  const lines: Cell[] = [
    { text: `prepared ${r.space}`, tone: "ok", mark: "✓" },
    ...r.written.map((w): Cell => ({ text: `  wrote ${w.what}: ${w.path}`, tone: "hint" })),
    { text: `  start it with \`cotal up\` in ${r.root}`, tone: "hint" },
  ];
  if (!r.current) lines.push({ text: `  select it with \`cotal use ${r.space}\``, tone: "hint" });
  return { sections: [{ blocks: [{ kind: "lines", lines }] }] };
}

/**
 * `cotal space forget <name>` removes a registration this machine keeps. It stops nothing and
 * deletes nothing on a broker, and the root's files stay. A space this machine is running is
 * stopped with `cotal down`, which also drops its record, and a discovered space follows its
 * catalog. A stack member whose process is gone without its stop receipt does not block, and the
 * result warns about each one. Forgetting the selected space clears the selection. A prepared space
 * is forgotten the same way, and the `.cotal/` folder `space create` made stays.
 */
export async function spaceForget(rest: readonly string[], presentation: Presentation): Promise<void> {
  if (rest.length !== 1) throw usage("usage: cotal space forget <name>");
  const name = rest[0]!;
  const target = { space: name };
  // Read before any effect: a preferences file that cannot be read refuses the forget as it is.
  const preferencesRevision = readPreferences().revision;
  const m = findMesh(name);
  if (!m) {
    const p = findPreparedSpace(name);
    if (!p) throw refuse("TARGET_NOT_FOUND", `no space named "${name}" is registered here`, target, "see the registered spaces with `cotal space`");
    removePreparedSpace(name);
    return forgotten(presentation, { space: name, server: null, root: p.root, origin: "prepared" }, preferencesRevision);
  }
  if (m.origin === "catalog")
    throw refuse("CONFLICT", `"${name}" is listed by a signed-in space catalog, so this machine does not own its registration`, target, "it is removed when the catalog no longer lists it and `cotal sync` runs");
  let unsettled: string[] = [];
  if (m.origin !== "manual") {
    let running: string | undefined;
    try {
      running = liveMeshOwner(m.root, m.space);
      unsettled = unsettledStackMembers(m.root, m.space);
    } catch (e) {
      throw refuse("LIFECYCLE_BLOCKED", `could not tell whether "${name}" is running from ${m.root}: ${(e as Error).message}`, target, "check it with `cotal status`");
    }
    if (running) throw refuse("LIFECYCLE_BLOCKED", `"${name}" is running from ${m.root} (${running})`, target, `stop it with \`cotal down\` in ${m.root}, which also drops its record`);
  }
  removeMesh(name);
  const warnings = unsettled.map((member) => ({ code: "STACK_MEMBER_UNSETTLED", target, message: `the stack member ${member} is gone but was never stopped cleanly: its record has no stop receipt` }));
  forgotten(presentation, { space: name, server: m.server, root: m.root, origin: m.origin ?? null }, preferencesRevision, warnings);
}

/** The space's per-space preferences go with it, so a later space of the same name starts without
 *  them. The registration is already gone when their removal fails, which leaves the run partial. */
function forgotten(presentation: Presentation, r: Omit<SpaceForgotten, "kind" | "selectionCleared" | "removedPreferences">, preferencesRevision: number, warnings: OutputWarning[] = []): void {
  const selectionCleared = getCurrent() === r.space;
  if (selectionCleared) clearCurrent();
  let removedPreferences: Partial<Record<string, string>> = {};
  let partial: { message: string; remedy: string } | undefined;
  try {
    removedPreferences = removeSpacePreferences(r.space, preferencesRevision).removed;
  } catch (e) {
    partial = { message: `forgot ${r.space}, but its per-space preferences were not removed: ${(e as Error).message}`, remedy: `see them with \`cotal config --space ${r.space}\` and remove each with \`cotal config unset <key> --space ${r.space}\`` };
  }
  const result: SpaceForgotten = { kind: "space-forgotten", ...r, selectionCleared, removedPreferences };
  writeResult(presentation, { command: "space", target: { space: r.space }, result, warnings, ...(partial ? { completeness: "partial" as const, partial } : {}) }, forgottenView);
}

function forgottenView(r: SpaceForgotten): Report {
  const lines: Cell[] = [
    { text: `forgot ${r.space}`, tone: "ok", mark: "✓" },
    { text: `  ${r.server === null ? "prepared, not running" : r.server}; ${existsSync(r.root) ? `the files under ${r.root} are kept` : `its folder ${r.root} no longer exists`}`, tone: "hint" },
  ];
  const removed = Object.entries(r.removedPreferences).filter(([, value]) => value !== undefined);
  if (removed.length) lines.push({ text: `  removed its per-space preferences: ${removed.map(([key, value]) => `${key}=${value}`).join(", ")} - \`cotal config set <key> <value> --space ${r.space}\` sets one again`, tone: "hint" });
  if (r.selectionCleared) lines.push({ text: "no space is selected now - select one with `cotal use <name>`", tone: "hint" });
  return { sections: [{ blocks: [{ kind: "lines", lines }] }] };
}
