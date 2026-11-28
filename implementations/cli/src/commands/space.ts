import { accessSync, constants } from "node:fs";
import { dirname } from "node:path";
import type { CompletionResult, FlagSpec, FlagValues, ParsedArgs } from "@cotal-ai/core";
import {
  CommandFailure,
  MeshTargetError,
  authDir,
  brokerCheck,
  canonicalRoot,
  codeSpan,
  cotalDir,
  cotalDirLink,
  findCotalRoot,
  findMesh,
  findPreparedSpace,
  folderSpace,
  folderSpaceHeld,
  folderSpaceOverSelection,
  getCurrent,
  isGenuineSpace,
  isMeshRegistryError,
  jsonFlag,
  listSpaceAccounts,
  loadMeshes,
  loadPreparedSpaces,
  noteFolderSpace,
  noteFolderSpaceShown,
  oneLine,
  plainFlag,
  preparedLifecycle,
  preparedRootRemedy,
  presentationOf,
  projectRootDisplaced,
  projectRootProblem,
  projectRootProblemText,
  readCurrent,
  readCurrentSelection,
  recordOperationSpaceNote,
  spaceKey,
  stackElsewhereRemedy,
  stackJournalPath,
  stackJournalRoot,
  stoppedStack,
  writeResult,
  type Cell,
  type BrokerCheck,
  type MeshEntry,
  type OutputWarning,
  type Presentation,
  type PreparedSpace,
  type ProjectRootProblem,
  type Report,
  type Section,
} from "@cotal-ai/workspace";
import { spaceInventoryCommand } from "../lib/choose-target.js";
import { completingFlagValue } from "../lib/completion.js";
import { shellWord } from "../lib/endpoint-errors.js";
import { registryFailure } from "../lib/registry-errors.js";
import { displayCmd, displayRemedy } from "../lib/self-exec.js";
import { checkRoot, SPACE_MODES } from "./meshes-add.js";
import { ADD_FLAGS, spaceAdd, spaceCreate, spaceForget, validateLocalSpaceName } from "./space-registration.js";
import { spaceDelete } from "./space-delete.js";
import { spaceExport } from "./space-export.js";
import { journalRecordedElsewhere, stackRootGone } from "../lib/stack-journal.js";

export const spaceFlags = [
  jsonFlag,
  plainFlag,
  { name: "out", type: "string", value: "<private-file>", description: "export: create a private connection-bundle file without overwriting", completion: "files" },
  { name: "server", type: "string", value: "<url>", description: "add: the space's broker URL" },
  { name: "root", type: "string", value: "<dir>", description: "add: the folder for the space's personas and, for an auth space, its .cotal/auth trust (default: this project; required outside one); create: the folder it starts in (default: this one)" },
  { name: "mode", type: "string", value: "<auth|open|user>", description: "add: how the broker authenticates (default: auth when --root holds the space's trust, else open)" },
  { name: "file", short: "f", type: "string", value: "<bundle.json>", description: "add: a user-auth connection bundle exported where the space runs" },
  { name: "from", type: "string", value: "<https url>", description: "add: fetch the space's discovery document; its pins are shown and confirmed" },
  { name: "tls", type: "boolean", description: "add: require TLS on every connection to the space (a tls:// or wss:// --server implies it)" },
  { name: "allow-unencrypted-overlay", type: "boolean", description: "add: accept that an overlay address is protected only while its tunnel is up" },
  { name: "force", type: "boolean", description: "add: replace a registration added by hand, and add a --server space without checking its broker" },
  { name: "yes", short: "y", type: "boolean", description: "confirm without the terminal question; a delete must name the exact space, and an add still confirms fetched pins" },
  { name: "dry-run", type: "boolean", description: "delete: read native first-party impact without deleting anything" },
  { name: "adopt", type: "boolean", description: "create: take over the stack journal a copied or moved project folder holds, so the space starts from this folder" },
] as const satisfies readonly FlagSpec[];

const usage = (message: string): CommandFailure => new CommandFailure("refused", "USAGE_INVALID", message);

/** Whether a registration's broker answered. A discovered catalog entry is never dialed by a read, so
 *  its broker is `not-checked` rather than a guessed answer. */
export type Check = BrokerCheck | "not-checked";

/** One registered space, as `cotal space` lists it: the same row `cotal status --json` gives under
 *  `meshes.items`. */
export interface SpaceRow {
  readonly space: string;
  readonly server: string;
  readonly mode: MeshEntry["mode"];
  readonly root: string;
  /** `up` when this machine started it, `manual` when it was registered by hand, `catalog` when a
   *  signed-in catalog lists it, null for a record written before origins were recorded. */
  readonly origin: MeshEntry["origin"] | null;
  readonly tlsRequired: boolean;
  readonly eventsRequired: boolean;
  /** False when `space add --force` registered it unchecked, so its `mode` was never seen enforced. */
  readonly modeChecked: boolean;
  /** Whether it is the space `cotal use` selected. */
  readonly current: boolean;
  readonly check: Check;
  /** A discovered space's catalog name when it differs from the space, and the last fetch. */
  readonly catalog: { readonly name: string | null; readonly fetchedAt: string | null; readonly error: string | null } | null;
}

interface SpacesResult {
  readonly kind: "spaces";
  /** The space `cotal use` selected, or null. It can name a space that is no longer registered. */
  readonly current: string | null;
  readonly currentRecorded: boolean;
  /** This folder's space when a command without `--space` targets it here instead of `current`, or null. */
  readonly folder: string | null;
  readonly items: readonly SpaceRow[];
  /** Spaces `cotal space create` prepared and no `cotal up` has started. They have no broker yet. */
  readonly prepared: readonly PreparedRow[];
}

/** A prepared space, as `cotal space` lists it and `cotal space show` shows it. */
export interface PreparedRow {
  readonly space: string;
  readonly root: string;
  readonly preparedAt: string;
  readonly current: boolean;
  /** No project directory is available at its recorded root. */
  readonly rootMissing: boolean;
  /** What its root's stack records, as `status` reports it: never started, stopped, or a last
   *  `up` or `down` with no recorded outcome. */
  readonly state: "prepared" | "stopped" | "unsettled";
  /** That last operation and how it ended, such as `` `cotal down`, completed ``; null when it never started. */
  readonly lastOperation: string | null;
}

interface PreparedDetail extends PreparedRow {
  readonly kind: "prepared-space";
}

/** One registration in full. Pins and endpoints are public; credential paths are left out. */
export interface SpaceDetail extends Omit<SpaceRow, "catalog"> {
  readonly kind: "space";
  /** The local stack's journal and broker configuration are no longer at its recorded root. */
  readonly rootGone: boolean;
  readonly recordedAt: string;
  readonly attachHost: string | null;
  readonly maxSessions: number | null;
  readonly storeDir: string | null;
  readonly unencryptedOverlay: boolean;
  readonly userAuth: { readonly provider: string; readonly idp: { readonly url: string; readonly issuer: string; readonly audience: string }; readonly remote: boolean } | null;
  readonly catalog: (NonNullable<SpaceRow["catalog"]> & { readonly id: string | null; readonly slug: string | null; readonly kind: string | null; readonly role: string | null }) | null;
}

/** Refuse invalid create names and empty names or directory flags before changing space records. */
export function validateSpaceArguments(args: ParsedArgs): void {
  const values = args.values as FlagValues<typeof spaceFlags>;
  presentationOf(values);
  const [sub, name] = args.positionals;
  if ((sub === "show" || sub === "forget") && name !== undefined && !name.trim())
    throw usage(`space ${sub} takes a nonempty space name`);
  if (sub === "forget" && name !== undefined) {
    try { spaceKey(name); } catch {
      throw new CommandFailure("refused", "USAGE_INVALID", `${JSON.stringify(name)} cannot name a space. Nothing was forgotten.`, {
        remedy: "list the registered and prepared space names with `cotal space`",
        selfContained: true,
      });
    }
  }
  if ((sub === "add" || sub === "create") && values.root !== undefined && !values.root.trim())
    throw usage("--root cannot be empty");
  if (sub === "create") {
    if (args.positionals.length !== 2 || !name?.trim())
      throw usage("usage: cotal space create <name> [--root <dir>] [--adopt]");
    validateLocalSpaceName(name);
  }
}

/**
 * `cotal space` lists the spaces this machine can reach, and `cotal space show [<name>]` shows one in
 * full. Both read the local registry and probe brokers; neither writes anything. A broker that does
 * not answer leaves its registration in place, with timeouts distinct from refused connections. Spaces `space create`
 * prepared are listed apart, with no broker to probe. `space add`, `space create` and
 * `space forget` change what is recorded (see `space-registration.ts`).
 */
export async function space(args: ParsedArgs): Promise<void> {
  validateSpaceArguments(args);
  const values = args.values as FlagValues<typeof spaceFlags>;
  const presentation = presentationOf(values);
  const [sub, ...rest] = args.positionals;
  if (values.adopt !== undefined && sub !== "create") throw usage("--adopt belongs to space create");
  if (values.out !== undefined && sub !== "export") throw usage("--out belongs to space export");
  if (sub === "export") {
    const invalid = ADD_FLAGS.find((flag) => values[flag] !== undefined);
    if (invalid || values["dry-run"] !== undefined) throw usage("space export takes only --out and output formatting flags");
    return spaceExport(rest, values.out, presentation);
  }
  if (sub === "delete") {
    const invalid = ADD_FLAGS.find((flag) => flag !== "yes" && values[flag] !== undefined);
    if (invalid) throw usage(`--${invalid} belongs to space add, not delete`);
    return spaceDelete(args);
  }
  if (values["dry-run"] !== undefined) throw usage("--dry-run belongs to space delete");
  if (sub === "add") return spaceAdd(rest, values, presentation);
  const addOnly = ADD_FLAGS.find((flag) => values[flag] !== undefined && !(sub === "create" && flag === "root"));
  if (addOnly) throw usage(addOnly === "yes" ? "--yes is taken by `cotal space add` and `cotal space delete` only" : `--${addOnly} is taken by \`cotal space add\` only`);
  if (sub === "forget") return spaceForget(rest, presentation);
  if (sub === "create") return spaceCreate(rest[0]!, values.root, values.adopt === true, presentation);
  if (sub !== undefined && sub !== "show") throw usage(`cotal space has no subcommand "${sub}" - run \`cotal help space\``);
  // Listing and show read the registry before anything else and write nothing, so a record that
  // cannot be read refuses them.
  try { await read(sub, rest, presentation); }
  catch (e) { throw isMeshRegistryError(e) ? registryFailure(e) : e; }
}

function spaceShownAt(cwd: string): string | undefined {
  const registeredRoots = loadMeshes().map((mesh) => ({ mesh, root: canonicalRoot(mesh.root) }));
  for (let root = canonicalRoot(cwd); !isGenuineSpace(root); root = dirname(root)) {
    const matches = registeredRoots.filter((entry) => entry.root === root).map((entry) => entry.mesh);
    if (matches.length > 1) {
      const spaces = matches.map((m) => m.space);
      throw new MeshTargetError("ambiguous-target", `this folder has ${spaces.length} registered spaces: ${spaces.join(", ")}`, {
        available: matches.map((m) => `${m.space} (${m.root})`), spaces,
      });
    }
    if (matches[0]) return matches[0].space;
    if (dirname(root) === root) break;
  }
  return folderSpace(cwd, { refuseAmbiguous: true });
}

async function read(sub: "show" | undefined, rest: string[], presentation: Presentation): Promise<void> {
  if (sub === "show" && rest.length > 1) throw usage("usage: cotal space show [<name>]");
  const project = canonicalRoot(findCotalRoot(process.cwd()));
  const recordedRoot = cotalDirLink(project) === undefined ? stackJournalRoot(project) : undefined;
  let moved: ReturnType<typeof journalRecordedElsewhere>;
  if (recordedRoot !== undefined && projectRootDisplaced(projectRootProblem(recordedRoot))) {
    try { moved = journalRecordedElsewhere(project); } catch { /* An unusable journal does not identify a moved project. */ }
  }
  if (sub === undefined) {
    let current: string | null = null;
    let selectionWarning: OutputWarning | undefined;
    try { current = readCurrent() ?? null; }
    catch (e) {
      if (!isMeshRegistryError(e)) throw e;
      const { message, remedy } = registryFailure(e);
      selectionWarning = { code: "MESH_REGISTRY_UNREADABLE", target: { file: e.file }, message: `${message}; ${remedy}` };
    }
    const items = await Promise.all(loadMeshes().map(async (m) => row(m, current, m.origin === "catalog" ? "not-checked" : await brokerCheck(m.server, m.tlsRequired))));
    const offline = items.filter((m) => m.check !== "reachable" && m.check !== "not-checked").map((m) => m.space);
    const prepared = loadPreparedSpaces().map((p) => preparedRow(p, current, moved?.recordedRoot === p.root && moved.journal.space === p.space ? project : undefined));
    const folder = folderSpaceOverSelection(process.cwd(), current, offline) ?? null;
    const result: SpacesResult = { kind: "spaces", current, currentRecorded: !selectionWarning && (current === null || items.some((s) => s.current)), folder, items, prepared };
    writeResult(presentation, { command: "space", target: null, result, warnings: selectionWarning ? [selectionWarning] : selectionWarnings(result) }, (rows) => spacesView(rows, project, moved, presentation));
    return;
  }
  if (sub === "show") {
    // With no name it is about this folder: the space it has registered, or the one it holds
    // prepared or stopped, which `show` names even though every other command here targets the
    // selection. Then the selection.
    const registered = rest[0] === undefined ? spaceShownAt(process.cwd()) : undefined;
    // A journal without a matching local record does not name a space to show.
    const held = rest[0] === undefined && registered === undefined ? folderSpaceHeld(process.cwd()) : undefined;
    const recorded = held !== undefined && (findMesh(held.space) ?? findPreparedSpace(held.space)) !== undefined ? held : undefined;
    const folder = registered ?? recorded?.space;
    let movedSpace: string | undefined;
    if (rest[0] === undefined && folder === undefined && moved !== undefined) {
      const { journal, recordedRoot } = moved;
      const mesh = findMesh(journal.space);
      if (mesh !== undefined
        ? mesh.origin !== "manual" && mesh.origin !== "catalog" && mesh.root === recordedRoot && mesh.server === journal.server
        : findPreparedSpace(journal.space)?.root === recordedRoot) movedSpace = journal.space;
    }
    const shown = rest[0] ?? folder ?? movedSpace;
    const current = (shown === undefined ? readCurrent() : getCurrent()) ?? null;
    const explicit = folder !== undefined && current !== null && folder !== current && readCurrentSelection()?.source === "explicit";
    const name = shown ?? current;
    if (name === null) {
      if (moved !== undefined) {
        const { journal, recordedRoot } = moved;
        throw new CommandFailure("refused", "TARGET_NOT_FOUND", `this folder (${project}) holds the stack journal of "${journal.space}" and was moved from ${recordedRoot}, but no matching local space record was found`, { remedy: `see the spaces recorded here with ${codeSpan(`${displayCmd()} space`)}` });
      }
      throw new CommandFailure("refused", "TARGET_NOT_FOUND", "no space is selected", { remedy: "name one with `cotal space show <name>`, or select one with `cotal use <name>`" });
    }
    const m = findMesh(name);
    const unmarked = registered !== undefined && m !== undefined && !isGenuineSpace(m.root);
    if (unmarked) {
      const selected = current !== null && current !== name ? `; the selected space "${current}" applies here to commands such as \`cotal who\`` : "";
      recordOperationSpaceNote(name, `this folder's space${selected}`);
    } else if (explicit) {
      recordOperationSpaceNote(folder, `this folder's space; the selected space "${current}" applies here to commands such as \`cotal who\`. Use --space ${shellWord(folder)} or \`cotal use --clear\` to target this folder's space`);
    } else if (current !== null && recorded !== undefined && recorded.space !== current) {
      noteFolderSpaceShown(recorded.space, recorded.state, current);
    }
    if (!m) {
      const p = findPreparedSpace(name);
      // No space has the name, so the refusal is not headed with it.
      if (!p) throw new CommandFailure("refused", "TARGET_NOT_FOUND", `no space named "${name}" is registered here`, { target: { requested: name }, remedy: `see the registered spaces with ${spaceInventoryCommand(presentation)}` });
      const matching = moved?.recordedRoot === p.root && moved.journal.space === p.space ? moved : undefined;
      const result: PreparedDetail = { kind: "prepared-space", ...preparedRow(p, current, matching && project) };
      writeResult(presentation, { command: "space", target: { space: p.space }, result }, (row) => preparedView(row, project, matching));
      return;
    }
    const check: Check = m.origin === "catalog" ? "not-checked" : await brokerCheck(m.server, m.tlsRequired);
    // A running registered folder takes precedence over an automatically adopted selection only.
    if (!unmarked && !explicit && current !== null && registered !== undefined && registered !== current) {
      if (check !== "reachable" && check !== "not-checked") noteFolderSpaceShown(registered, "stopped", current);
      else noteFolderSpace(registered, current);
    }
    const warning = stackRecordsPermissionWarning(m);
    writeResult(presentation, { command: "space", target: { space: m.space }, result: detail(m, current, check, warning !== undefined), warnings: warning ? [warning] : [] }, spaceView);
    return;
  }
}

function preparedRow(p: PreparedSpace, current: string | null, moved?: string): PreparedRow {
  const rootProblem = projectRootProblem(p.root);
  const rootMissing = rootProblem !== undefined;
  const lifecycle = moved !== undefined ? preparedLifecycle(moved, p.space) : rootMissing ? undefined : preparedLifecycle(p.root, p.space);
  return { space: p.space, root: p.root, preparedAt: p.ts, current: p.space === current, rootMissing, state: lifecycle?.state ?? "prepared", lastOperation: lifecycle?.lastOperation ?? null };
}

/** How a prepared space's own root left it, as a cell. */
function lifecycleCell(p: Pick<PreparedRow, "state" | "lastOperation">): Cell {
  if (p.state === "stopped") return { text: `stopped · ${p.lastOperation}`, tone: "waiting" };
  if (p.state === "unsettled") return { text: `last ${p.lastOperation}`, tone: "waiting" };
  return { text: "not started", tone: "waiting" };
}

function row(m: MeshEntry, current: string | null, check: Check): SpaceRow {
  return {
    space: m.space,
    server: m.server,
    mode: m.mode,
    root: m.root,
    origin: m.origin ?? null,
    tlsRequired: m.tlsRequired === true,
    eventsRequired: m.policy?.events === "required",
    modeChecked: m.unchecked !== true,
    current: m.space === current,
    check,
    catalog: m.origin === "catalog" ? { name: m.catalogName && m.catalogName !== m.space ? m.catalogName : null, fetchedAt: m.catalogFetchedAt ?? null, error: m.catalogError ?? null } : null,
  };
}

/** The journal lookup requires search permission, not permission to read the journal itself. */
function stackRecordsPermissionWarning(m: MeshEntry): OutputWarning | undefined {
  if (m.origin === "manual" || m.origin === "catalog") return undefined;
  try {
    accessSync(stackJournalPath(m.root), constants.F_OK);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EACCES" || code === "EPERM") {
      const path = cotalDir(m.root);
      return { code: "PERMISSION_DENIED", target: { space: m.space, path }, message: `Cannot check stack records in ${oneLine(path)}. Restore search permission before retrying.` };
    }
  }
  return undefined;
}

/** One registration in full, as `space show` reports it. */
export function detail(m: MeshEntry, current: string | null, check: Check, rootSearchDenied = false): SpaceDetail {
  const base = row(m, current, check);
  return {
    kind: "space",
    ...base,
    rootGone: !rootSearchDenied && ((m.origin === "up" && projectRootProblem(m.root) === "not-directory") || stackRootGone(m.space, m.root)),
    recordedAt: m.ts,
    attachHost: m.attachHost ?? null,
    maxSessions: m.maxSessions ?? null,
    storeDir: m.storeDir ?? null,
    unencryptedOverlay: m.unencryptedOverlay === true,
    userAuth: m.userAuth ? { provider: m.userAuth.provider, idp: { ...m.userAuth.idp }, remote: m.userAuth.remote === true } : null,
    catalog: base.catalog ? { ...base.catalog, id: m.catalogId ?? null, slug: m.catalogSlug ?? null, kind: m.catalogKind ?? null, role: m.catalogRole ?? null } : null,
  };
}

/** A selection that names no registration still selects it: the command that targets it refuses
 *  rather than reaching another space. A prepared space is selected, not missing. */
function selectionWarnings(result: SpacesResult): OutputWarning[] {
  if (result.current === null || result.currentRecorded || result.prepared.some((p) => p.current)) return [];
  return [{ code: "SELECTION_NOT_REGISTERED", target: { space: result.current }, message: `the selected space "${result.current}" is not registered here - select another with \`cotal use <name>\`` }];
}

/** A record with no origin was written by `up` before origins were recorded. */
const originText = (origin: SpaceRow["origin"]): string => (origin === "manual" ? "registered" : origin === "catalog" ? "discovered" : "started here");

function checkCell(s: Pick<SpaceRow, "check">): Cell {
  if (s.check === "slow-link") return { text: "not answering", tone: "waiting", mark: "●" };
  if (s.check === "broker-stopped") return { text: "broker process is stopped", tone: "waiting", mark: "●" };
  if (s.check === "reachable") return { text: "reachable", tone: "ok", mark: "●" };
  if (s.check === "unreachable") return { text: "unreachable", tone: "waiting", mark: "●" };
  return { text: "not checked", tone: "hint", mark: "○" };
}

const nameCell = (s: Pick<SpaceRow, "space" | "current">, folder: string | null = null): Cell =>
  s.current ? { text: `${s.space} (selected)`, tone: "selected" } : s.space === folder ? { text: `${s.space} (this folder's)`, tone: "selected" } : s.space;

function movedPreparedRemedy(project: string, moved: NonNullable<ReturnType<typeof journalRecordedElsewhere>>): string {
  return displayRemedy(stackElsewhereRemedy(project, moved.recordedRoot, moved.journal.space, moved.journal.members, moved.journal.operation));
}

function preparedRootCell(p: PreparedRow, problem: ProjectRootProblem | undefined, moved: boolean, project: string): Cell {
  const root = oneLine(p.root);
  if (moved) return { text: `${project} (moved from ${root})`, tone: "waiting" };
  if (!problem) return { text: root, tone: "hint" };
  const reason = problem === "not-directory" ? "not a directory" : projectRootProblemText(problem);
  return { text: `${root} (${reason})`, tone: "waiting" };
}

function spacesView(result: SpacesResult, project: string, moved: ReturnType<typeof journalRecordedElsewhere>, presentation: Presentation): Report {
  const cmd = displayCmd();
  const addBroker = checkRoot(undefined, process.cwd()).ok
    ? { command: "cotal space add <name> --server <url>", description: "Register an existing broker" }
    : { command: "cotal space add <name> --server <url> --root <dir>", description: "Register an existing broker. Use any existing folder for an open space, or the folder whose .cotal/auth holds the space's trust for an auth space." };
  const movedRow = result.prepared.find((p) => moved?.recordedRoot === p.root && moved.journal.space === p.space);
  const problems = new Map(result.prepared.filter((p) => p.rootMissing).map((p) => [p.space, projectRootProblem(p.root)]));
  // A space that ran and was stopped says so, as `status` does, rather than reading as never started.
  const ran = result.prepared.some((p) => p.state !== "prepared");
  const prepared: Section[] = result.prepared.length === 0 ? [] : [{
    title: ran ? "Prepared spaces" : "Prepared, not started",
    blocks: [
      {
        kind: "table",
        columns: [{ key: "space", label: "Space" }, ...(ran ? [{ key: "state", label: "State" }] : []), { key: "root", label: "Project" }],
        rows: result.prepared.map((p) => ({ space: nameCell(p, result.folder), state: lifecycleCell(p), root: preparedRootCell(p, problems.get(p.space), p === movedRow, project) })),
      },
      { kind: "commands", items: [
        ...(result.prepared.some((p) => !p.rootMissing) ? [{ command: `${cmd} up`, description: "Start a prepared space from its project folder" }] : []),
        ...(result.prepared.some((p) => !p.rootMissing && p.state === "unsettled") ? [{ command: `${cmd} status`, description: "Run in its project folder, it names the step that finishes or settles its last operation" }] : []),
        ...result.prepared.flatMap((p) => {
          const problem = problems.get(p.space);
          if (!problem || p === movedRow) return [];
          const name = shellWord(p.space);
          return [{ command: `${cmd} space show ${presentation === "plain" ? "--plain " : ""}${p.space.startsWith("-") ? "-- " : ""}${name}`, description: displayRemedy(preparedRootRemedy(p.space, problem), cmd) }];
        }),
      ] },
      ...(movedRow && moved ? [{ kind: "lines" as const, lines: [{ text: movedPreparedRemedy(project, moved), tone: "hint" as const }] }] : []),
    ],
  }];
  // A prepared space is listed below, so the empty line names what is missing without denying it.
  if (result.items.length === 0)
    return { sections: [{ title: "Spaces", blocks: [{ kind: "lines", lines: result.prepared.length ? [ran ? "No space is running or registered." : "No space has been started or registered yet."] : ["No spaces registered.", { text: "Sign in to Cotal Cloud with `cotal login`, or prepare a local space.", tone: "hint" }] }] }, ...prepared, { title: "Next", blocks: [{ kind: "commands", items: [...(result.prepared.length ? [] : [{ command: "cotal login", description: "Sign in to Cotal Cloud" }]), { command: "cotal setup", description: "Choose a local or self-hosted space" }, addBroker] }] }] };
  const root = canonicalRoot(process.cwd());
  const occupied = movedRow !== undefined || [...result.items, ...result.prepared].some((s) => canonicalRoot(s.root) === root) || listSpaceAccounts(authDir(root)).length > 0;
  return {
    sections: [{
      title: "Spaces",
      blocks: [{
        kind: "table",
        columns: [
          { key: "space", label: "Space" },
          { key: "broker", label: "Connection" },
          { key: "server", label: "Broker" },
          { key: "mode", label: "Access" },
          { key: "origin", label: "Source" },
          { key: "root", label: "Project" },
        ],
        rows: result.items.map((s) => ({
          space: nameCell(s, result.folder),
          broker: checkCell(s),
          server: s.server,
          mode: s.modeChecked ? s.mode : { text: `${s.mode}, not checked`, tone: "waiting" },
          origin: s.catalog?.name ? `${originText(s.origin)} as ${s.catalog.name}` : originText(s.origin),
          root: { text: s.root, tone: "hint" },
        })),
      }],
    }, ...prepared, { title: "Next", blocks: [{ kind: "commands", items: [
      { command: "cotal use <name>", description: "Select the space commands use" },
      { command: "cotal space show <name>", description: "Inspect its connection and project" },
      occupied
        ? { command: "cotal space create <name> --root <dir>", description: "Prepare another local space in another folder" }
        : { command: "cotal space create <name>", description: "Prepare another local space in this folder" },
      addBroker,
    ] }] }],
  };
}

function preparedView(p: PreparedDetail, project: string, moved: ReturnType<typeof journalRecordedElsewhere>): Report {
  const cmd = displayCmd();
  const hints: Cell[] = [];
  const problem = p.rootMissing ? projectRootProblem(p.root) : undefined;
  if (moved && problem === "not-directory") hints.push(`${p.root} ${projectRootProblemText(problem)}`);
  if (moved !== undefined) {
    hints.push(
      { text: `this folder holds the stack journal of "${p.space}" and was moved from ${p.root}`, tone: "waiting" },
      { text: movedPreparedRemedy(project, moved), tone: "hint" });
  } else if (problem !== undefined) {
    hints.push(
      { text: `prepared in ${p.root}, which ${projectRootProblemText(problem)}`, tone: "waiting" },
      { text: displayRemedy(preparedRootRemedy(p.space, problem), cmd), tone: "hint" });
  } else if (p.state === "unsettled") {
    hints.push({ text: `run ${codeSpan(`${cmd} status`)} in ${p.root}, which names the step that finishes or settles it`, tone: "hint" });
  } else {
    const stopped = p.state === "stopped";
    const up = `${cmd} up${stopped && stoppedStack(p.root, p.space)?.noManager ? " --no-manager" : ""}`;
    hints.push({ text: `start it${stopped ? " again" : ""} with ${codeSpan(up)} in ${p.root}`, tone: "hint" });
  }
  if (!p.current && !p.rootMissing) hints.push({ text: `select it with ${codeSpan(`${cmd} use ${shellWord(p.space)}`)}`, tone: "hint" });
  return {
    sections: [{
      blocks: [
        { kind: "fields", rows: [["space", nameCell(p)], ["broker", lifecycleCell(p)], ["root", p.root], ["prepared", p.preparedAt]] },
        { kind: "lines", lines: hints },
      ],
    }],
  };
}

function spaceView(s: SpaceDetail): Report {
  const obstructed = s.rootGone && projectRootProblem(s.root) === "not-directory";
  const fields: [string, Cell][] = [
    ["space", nameCell(s)],
    ["broker", checkCell(s)],
    ["server", s.server],
    ["mode", s.modeChecked ? s.mode : { text: `${s.mode}, not checked: added with --force`, tone: "waiting" }],
    ["origin", originText(s.origin)],
    ["root", s.rootGone ? { text: `${s.root} · ${obstructed ? "not a directory" : "folder was moved or deleted"}`, tone: "failed" } : s.root],
    ["recorded", s.recordedAt],
  ];
  if (s.tlsRequired) fields.push(["tls", "required"]);
  if (s.eventsRequired) fields.push(["events", "required"]);
  if (s.unencryptedOverlay) fields.push(["overlay", { text: "unencrypted, accepted at registration", tone: "waiting" }]);
  if (s.attachHost) fields.push(["attach host", s.attachHost]);
  if (s.maxSessions !== null) fields.push(["max sessions", String(s.maxSessions)]);
  if (s.storeDir) fields.push(["store", s.storeDir]);
  if (s.userAuth) fields.push(["login", `${s.userAuth.idp.url}${s.userAuth.remote ? " (registered from elsewhere)" : ""}`]);
  if (s.catalog) {
    if (s.catalog.name) fields.push(["catalog name", s.catalog.name]);
    if (s.catalog.fetchedAt) fields.push(["catalog fetched", s.catalog.fetchedAt]);
    if (s.catalog.error) fields.push(["catalog error", { text: s.catalog.error, tone: "failed" }]);
  }
  const space = shellWord(s.space);
  const hints: Cell[] = s.current ? [] : [{ text: `select it with ${codeSpan(`${displayCmd()} use ${s.space.startsWith("-") ? "-- " : ""}${space}`)}`, tone: "hint" }];
  if (obstructed) hints.unshift({ text: displayRemedy(preparedRootRemedy(s.space, "not-directory")), tone: "waiting" });
  else if (s.rootGone) hints.unshift({ text: `stop the stack whose folder was moved or deleted with ${codeSpan(`${displayCmd()} down --space ${space} --yes`)}`, tone: "waiting" });
  if (!s.modeChecked && s.origin === "manual" && s.mode !== "user") {
    if (s.check === "reachable") {
      const flags = `${s.tlsRequired ? " --tls" : ""}${s.unencryptedOverlay ? " --allow-unencrypted-overlay" : ""}`;
      hints.push({ text: `check its mode without removing the registration: ${codeSpan(`cotal space add ${space} --server ${shellWord(s.server)} --root ${shellWord(s.root)} --mode ${s.mode}${flags}`)}`, tone: "hint" });
    } else {
      hints.push({ text: `wait for the broker to answer, then run ${codeSpan(`cotal space show ${space}`)} again to see how to check its mode`, tone: "hint" });
    }
  }
  return { sections: [{ title: `Space · ${s.space}`, blocks: [{ kind: "fields", rows: fields }, ...(hints.length ? [{ kind: "lines" as const, lines: hints }] : [])] }] };
}

/** Argument completion: the subcommand, then registered names, the modes `--mode` takes, and a path
 *  for `--root` and `--file`. */
export function spaceComplete(argv: string[]): CompletionResult {
  const flag = completingFlagValue(argv, spaceFlags);
  if (flag?.name === "mode") return { items: SPACE_MODES.map((value) => ({ value })), directive: "nofiles" };
  if (flag?.name === "root" || flag?.name === "file" || flag?.name === "out") return { items: [], directive: "default" };
  if (argv.length <= 1) return { items: [{ value: "show" }, { value: "add" }, { value: "create" }, { value: "forget" }, { value: "delete" }, { value: "export" }], directive: "nofiles" };
  if ((argv[0] === "show" || argv[0] === "forget" || argv[0] === "delete" || argv[0] === "export") && argv.length === 2)
    return { items: [...loadMeshes().map((m) => ({ value: m.space })), ...loadPreparedSpaces().map((p) => ({ value: p.space }))], directive: "nofiles" };
  return { items: [], directive: "nofiles" };
}
