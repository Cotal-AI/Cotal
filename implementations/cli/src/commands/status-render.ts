import { homedir } from "node:os";
import { join } from "node:path";
import { formatAge } from "@cotal-ai/core";
import {
  brokerUrlKey,
  canonicalRoot,
  CLI_USER_ACTOR,
  codeSpan,
  CommandFailure,
  homeCotalDir,
  OFFICIAL_CONNECTORS,
  type Cell,
  type Report,
  type Section,
  type Tone,
  spaceStreamsAbsent,
} from "@cotal-ai/workspace";
import { storeWriteRepair } from "../lib/broker-store-health.js";
import { displayCmd, serviceHiddenApplicationSuffix } from "../lib/self-exec.js";
import { shellWord } from "../lib/endpoint-errors.js";
import { onRerun } from "../lib/control.js";
import { rolledBackNotes } from "../lib/restore.js";
import { STACK_DEFINITION, type StackRole } from "../lib/stack-journal.js";
import { homeHoldsStack } from "../lib/paths.js";
import { channelSeedRestartBlock } from "../lib/channel-seed.js";
import { rootStoreProblem } from "../lib/store-dir.js";
import { natsServerLabel } from "../lib/nats-bin.js";
import { defaultLaunchBlock } from "../lib/status.js";
import { readCursor } from "../seed/lock.js";
import { responderText } from "./status-delivery.js";
import { type PersonaCatalog, type ProcessRow, type OwnedServiceStatus, type StatusResult, type SelectedResult } from "./status-model.js";

// ---- the report ------------------------------------------------------------------------------

const cell = (text: string, tone?: Tone): Cell => (tone ? { text, tone } : text);

function personaText(p: PersonaCatalog): string {
  if (p.default === "unreadable") return `unreadable: ${p.error}`;
  const parts = [p.default === "valid" ? "default" : p.default === "invalid" ? "invalid default" : "no default"];
  if (p.demo) parts.push(`demo team ${p.demo}/3`);
  return parts.join(" · ");
}

function personaTone(p: PersonaCatalog): Tone {
  return p.default === "valid" ? "ok" : p.default === "invalid" || p.default === "unreadable" ? "failed" : "hint";
}

/** A catalog's summary and root. Green only for a `default` that loads, and never for a catalog
 *  `dim` marks as not the one spawn launches from. */
function personaCell(p: PersonaCatalog, dim = false): Cell {
  const tone: Tone = dim ? "hint" : personaTone(p);
  return cell(`${personaText(p)} · ${p.root}`, tone);
}

function processCell(p: ProcessRow): Cell {
  const detail = p.detail ? ` · ${p.detail}` : "";
  if (p.state === "unreadable" || p.state === "unknown") return cell(p.detail ?? "process state unknown", "failed");
  if (p.state === "not-serving") return cell(`not serving (pid ${p.pid})${detail}`, "failed");
  if (p.state === "running") return cell(`running (pid ${p.pid})${detail}`, /NOT BOUND|unreadable/.test(detail) ? "failed" : "ok");
  return cell(p.pid ? `${p.detail ?? "stopped"} (${p.pid})` : (p.detail ?? "down"), "hint");
}

function skillsCell(s: StatusResult["machine"]["skills"]): Cell {
  const remedy = `${displayCmd()} setup --skills`;
  if (s.state === "unreadable") return cell(`bundle error: ${s.error}`, "failed");
  if (s.state === "current") return cell(`current (${s.total})`, "ok");
  if (s.state === "not-installed") return cell(`not installed · ${remedy}`, "hint");
  return cell(`${s.retired ? `${s.behind} to reconcile (${s.retired} retired)` : `${s.behind}/${s.total} out of date`} · ${remedy}`, "waiting");
}

/** The nats-server a broker start would run, or why it refuses the one it found. */
function brokerExecutable(m: StatusResult["machine"]): string {
  if (m.natsProblem) return m.natsProblem;
  return natsServerLabel({ ...m.natsServer!, source: m.nats === "path" ? "path" : "bundled" });
}

function machineSection(m: StatusResult["machine"]): Section {
  const tone = { ok: "ok", warn: "waiting", error: "failed", off: "hint" } as const;
  const rows: [string, Cell][] = [
    ["cotal-ai", cell(`v${m.version} (${m.install.kind === "source" ? "source checkout" : m.install.kind}: ${m.install.root}${m.install.note ? ` · ${m.install.note}` : ""})`, "ok")],
    ["NATS", m.nats === "missing" ? cell("missing", "failed") : cell(brokerExecutable(m), m.natsProblem ? "failed" : "ok")],
    ...m.integrations.map((r): [string, Cell] => [r.name, cell(r.text, tone[r.state])]),
  ];
  if (m.connectors === null) rows.push(["Connectors", cell("unreadable - see the warning below", "failed")]);
  else if (!m.connectors.length) rows.push(["Connectors", cell(`none installed · \`${displayCmd()} setup\``, "hint")]);
  for (const h of m.connectors ?? [])
    rows.push([h.name, h.missing.length ? cell(`${h.missing.join(", ")} not on PATH`, "hint") : cell(h.requires.length ? `${h.requires.join(", ")} on PATH` : "in-process", "ok")]);
  rows.push(["Skills (.agents)", skillsCell(m.skills)]);
  rows.push(["Web extension", m.web.installed === null ? cell(m.web.installedError ?? "unreadable", "failed") : m.web.installed ? cell("installed", "ok") : cell("not installed", "hint")]);
  // An install state that could not be read reads `down`, since only a known absence is `not installed`.
  rows.push(["Web process", m.web.url ? cell(m.web.url, "ok") : m.web.urlError ? cell(m.web.urlError, "failed") : cell(m.web.installed === false ? "not installed" : "down", "hint")]);
  return { title: "Machine", blocks: [{ kind: "fields", rows }] };
}

function extensionsSection(e: StatusResult["extensions"]): Section {
  const rows: [string, Cell][] = [["root", e.root]];
  if (e.items === null) rows.push(["installed", cell("manifest unreadable - see the warning below", "failed")]);
  else if (!e.items.length) rows.push(["installed", cell("none", "hint")]);
  for (const x of e.items ?? []) rows.push([x.label, cell(`v${x.version}${x.package === x.label ? "" : ` · ${x.package}`}`, "ok")]);
  return { title: "Extensions", blocks: [{ kind: "fields", rows }] };
}

function folderSection(f: StatusResult["folder"], selected: SelectedResult): Section {
  const rows: [string, Cell][] = [["root", f.root]];
  const cwd = canonicalRoot(process.cwd());
  if (cwd !== canonicalRoot(f.root) && (canonicalRoot(f.root) === canonicalRoot(homedir()) || canonicalRoot(join(f.root, ".cotal")) === canonicalRoot(homeCotalDir())))
    rows.push(["root selection", homeHoldsStack(f.root)
      ? cell("inherited the machine's home .cotal, which holds a stack; commands here reach that stack until up here makes this folder its own project root", "hint")
      : cell("inherited the machine's home .cotal; up here makes this folder its own project root", "hint")]);
  const auth = f.auth;
  if (auth.state === "unreadable") rows.push(["auth", cell(auth.error ?? "unreadable", "failed")]);
  else if (auth.state === "spaces") rows.push(["auth", cell(`${auth.spaces.length} spaces · ${auth.spaces.join(", ")}`, "ok")]);
  else if (auth.state === "space") rows.push(["auth", cell(`space ${auth.spaces[0]}${auth.userAuth ? " · user-auth" : ""}`, "ok")]);
  else rows.push(["auth", cell("none (open/local only)", "hint")]);
  if (f.launches === null) {
    rows.push(["personas", personaCell(f.personas)]);
    rows.push(["spawn root", cell("unresolved - see Selected Mesh below; until it resolves, no persona here is launchable", "waiting")]);
  } else if (f.launches) rows.push(["personas", personaCell(f.personas)]);
  else {
    // The divergence. The folder's catalog is real and worth reporting, but it is NOT the spawn
    // catalog, so its `default` must not be green: green here is the false capability claim.
    rows.push(["personas", personaCell(f.personas, true)]);
    if (selected.resolved) {
      rows.push(["spawn root", cell(`differs · ${selected.personas.root}`, "waiting")]);
      rows.push(["→ launches", cell(`${personaText(selected.personas)} · space ${selected.space} · via ${selected.source}`, personaTone(selected.personas))]);
    }
  }
  if (auth.state === "spaces") rows.push(["processes", cell("not reported per space on a multi-space root", "hint")]);
  for (const p of f.processes ?? []) rows.push([p.name, processCell(p)]);
  if (f.storedState) rows.push(["stored state", cell("JetStream store persists across down/up", "hint")]);
  return { title: "This Folder", blocks: [{ kind: "fields", rows }] };
}

function currentMeshState(m: StatusResult["meshes"], journalUnreadable: boolean): string {
  return journalUnreadable ? "has an unknown stack lifecycle" : m.currentStopped ? "is stopped" : m.currentPrepared ? "is prepared, not started" : "is not recorded";
}

function meshesSections(m: StatusResult["meshes"], currentJournalUnreadable: boolean): Section[] {
  const check = { reachable: cell("reachable", "ok"), unreachable: cell("down", "failed"), "slow-link": cell("not answering", "failed"), "broker-stopped": cell("broker process is stopped", "failed"), "not-checked": cell("not checked", "hint") } as const;
  const blocks: Section["blocks"][number][] = [];
  if (!m.items.length && !m.unreadable.length) blocks.push({ kind: "lines", lines: [cell("none", "hint")] });
  else
    blocks.push({
      kind: "table",
      columns: [
        { key: "space", label: "SPACE" },
        { key: "check", label: "CHECK" },
        { key: "mode", label: "MODE" },
        { key: "server", label: "SERVER" },
        { key: "root", label: "ROOT" },
        { key: "note", label: "NOTE" },
      ],
      rows: m.items.map((x) => ({
        space: x.current ? cell(`* ${x.space}`, "selected") : `  ${x.space}`,
        check: check[x.check],
        mode: x.mode,
        server: x.server ?? cell("unavailable", "failed"),
        root: x.root,
        // A `down` record means two different things, and the repair differs: a mesh this machine
        // started can be re-`up`ed here, one registered by hand runs somewhere this machine doesn't
        // control (and, unlike the others, its record is never swept away for it).
        note: [
          x.origin === "manual" ? "registered" : x.origin === "catalog" ? "discovered" : "",
          x.tlsRequired ? "tls-required" : "",
          x.eventsRequired ? "events: required" : "",
          x.catalog ? `${x.catalog.name ? `${x.catalog.name}  ` : ""}catalog ${x.catalog.error ? `stale since ${x.catalog.fetchedAt ?? "unknown"}: ${x.catalog.error}` : `snapshot ${x.catalog.fetchedAt ?? "unknown"}`}` : "",
        ].filter(Boolean).join("  "),
      })),
    });
  if (!m.currentRecorded) blocks.push({ kind: "lines", lines: [cell(`note: current mesh "${m.current}" ${currentMeshState(m, currentJournalUnreadable)}`, "hint")] });
  if (m.unreadable.length) blocks.push({ kind: "lines", lines: m.unreadable.map((u) => cell(`unreadable: ${u.error}`, "failed")) });
  const sections: Section[] = [{ title: "Recorded Meshes", blocks }];
  if (m.catalogs.length)
    sections.push({ title: "Space Catalog Accounts", blocks: [{ kind: "lines", lines: m.catalogs.map((r) => `${r.idp}  ${r.state}${r.error ? `: ${r.error}` : ""}`) }] });
  return sections;
}

/** The pid of the selected space's running stack delivery member, from its owned service record. */
function stackDeliveryPid(r: StatusResult): number | undefined {
  return r.services?.instances?.find((item) => item.definition === STACK_DEFINITION.delivery && item.observedProcess === "running")?.pid ?? undefined;
}

function selectedSection(s: SelectedResult, folder: StatusResult["folder"], deliveryPid?: number, storeFull = false): Section {
  if (!s.resolved) return { title: "Selected Mesh", blocks: [{ kind: "fields", rows: [["target", cell(s.code, "failed")]] }] };
  const rows: [string, Cell][] = [
    ["space", s.space],
    ["server", s.server ?? cell("unavailable", "failed")],
    ["mode", s.mode],
  ];
  if (s.eventsRequired) rows.push(["events", "required"]);
  if (s.tlsRequired) rows.push(["transport", "tls-required"]);
  if (s.idp) rows.push(["idp", s.idp]);
  rows.push(["source", s.source], ["root", s.root], ["personas", personaCell(s.personas)]);
  if (s.mode === "user") {
    rows.push(["connection", s.connection === "reachable" ? cell("reachable", "ok") : cell("unreachable", "failed")]);
    const l = s.login;
    if (!l) rows.push(["login", cell("unreadable - see the warning below", "failed")]);
    if (l && !l.subject) rows.push(["login", cell(`not signed in - ${codeSpan(`${displayCmd()} login --idp ${l.idp}`)}`, "waiting")]);
    if (l?.subject) {
      rows.push(["login", cell(`${l.subject} · session until ${l.expiresAt}`, "ok")]);
      if (l.actor === "not-granted") rows.push(["actor", cell(`"${CLI_USER_ACTOR}" not granted - ${codeSpan(`${displayCmd()} actor grant ${CLI_USER_ACTOR} --sub ${l.subject} --full`)}`, "waiting")]);
      else if (l.actor === "granted" && l.grant)
        rows.push([
          "actor",
          cell(`"${CLI_USER_ACTOR}" granted${l.grant.label ? ` (${l.grant.label})` : ""} - read [${l.grant.read.join(", ")}], post [${l.grant.post.join(", ")}]${l.grant.scope.length ? `, scope [${l.grant.scope.join(", ")}]` : ""}`, "ok"),
        ]);
      else rows.push(["actor", cell("grant not checkable on this machine (no local ledger)", "hint")]);
    }
  } else {
    rows.push(["connection", s.connection === "ok" ? cell("ok", "ok") : cell(`${s.connection}${s.staleRecord ? " (stale registry entry)" : ""}`, "failed")]);
    const responder = responderText(s.deliveryResponder, s.mode, Boolean(servedStack(folder, s) && folder.stackBlock), deliveryPid, storeFull);
    if (responder) rows.push(["delivery responder", cell(responder.text, responder.tone)]);
  }
  if (s.snapshot.state === "unavailable" || (s.mode === "user" && s.snapshot.state === "skipped")) rows.push(["live snapshot", cell(`${s.snapshot.state === "unavailable" ? "unavailable" : "not read"} (${s.snapshot.reason})`, s.snapshot.state === "unavailable" ? "failed" : "hint")]);
  if (s.channels) rows.push(["channels", s.channels.length ? s.channels.map((ch) => `${ch.channel}(${ch.messages})`).join(", ") : "none"]);
  if (s.membershipFeed)
    rows.push(["membership feed", s.membershipFeed.asOf ? cell(`${s.membershipFeed.entries} entries · updated ${formatAge(Math.max(0, Date.now() - Date.parse(s.membershipFeed.asOf)))} ago`, "ok") : cell("no heartbeat", "hint")]);
  return { title: "Selected Mesh", blocks: [{ kind: "fields", rows }] };
}

function stateCell(text: string, tone: Tone): Cell {
  return { text, tone, mark: tone === "hint" ? "○" : "●" };
}

/** The agent applications this machine has set up: those whose required executables are all on PATH,
 *  and the ones that run in this process. The rest are what `cotal setup` adds. */
function setUpApplications(m: StatusResult["machine"]): string[] {
  return (m.connectors ?? []).filter((connector) => !connector.missing.length).map((connector) => connector.name);
}

/** The applications line: the names that are set up, and how many more `cotal setup` would add.
 *  A name the background service's own cached report says it cannot see adds the command that
 *  refreshes this installation, and only while that command can. */
function applicationsCell(m: StatusResult["machine"], interactive: boolean, beyondService: readonly string[] = []): Cell {
  if (m.connectors === null) return stateCell("could not be read", "failed");
  const setUp = setUpApplications(m), others = m.connectors.length - setUp.length;
  const hidden = beyondService.filter(name => setUp.includes(name));
  const service = hidden.map(serviceHiddenApplicationSuffix).join("");
  if (!interactive) return setUp.length ? stateCell(`${setUp.join(", ")}${others ? ` · ${others} not set up` : ""}${service}`, "ok") : stateCell("not set up", "hint");
  if (!setUp.length) return stateCell(`not set up · \`${displayCmd()} setup\` adds one`, "hint");
  return stateCell(`${setUp.join(", ")}${others ? ` · ${others} more with \`${displayCmd()} setup\`` : ""}${service}`, "ok");
}

/** The extensions line: one count at the version they share, naming only those that differ from it.
 *  The versions are the manifest pins, so a differing one is a skew an upgrade did not carry. */
function extensionsCell(e: StatusResult["extensions"]): Cell | undefined {
  if (e.items === null) return stateCell("manifest could not be read", "failed");
  if (!e.items.length) return undefined;
  const counts = new Map<string, number>();
  for (const item of e.items) counts.set(item.version, (counts.get(item.version) ?? 0) + 1);
  const shared = [...counts].sort((a, b) => b[1] - a[1])[0]![0];
  const odd = e.items.filter((item) => item.version !== shared);
  const text = `${e.items.length} extension${e.items.length === 1 ? "" : "s"} at ${shared}`;
  return odd.length ? stateCell(`${text} · ${odd.map((item) => `${item.label} v${item.version}`).join(" · ")}`, "waiting") : text;
}

/**
 * What this machine has set up, and what needs attention.
 *
 * A row in its good state says nothing a reader acts on, and a piece of an application this machine
 * does not have is what `cotal setup` adds, which the applications line already counts. So an
 * application's own rows (the Claude plugin, Desktop and skills) appear only for an application that
 * IS set up, and only when they are not current. Cross-vendor skills that need repair or cannot be
 * read appear regardless of application setup. An ACP client's entry appears when it is stale or
 * cannot be read; the broker executable appears when it is missing or
 * refused and local broker records make it relevant; the dashboard, which is optional, appears
 * when its record cannot be read. `--all` and
 * `--wide` print every row, and `--verbose` adds the installation paths ({@link machineSection}).
 *
 * It used to print one row per known connector whether or not it was set up, every extension label
 * with the same version spelled out on each, and the broker executable's full bundled path on a
 * healthy machine: a block of text whose signal a reader had to hunt for.
 */
function machineOverview(r: StatusResult, wide: boolean, interactive: boolean, seed?: ReturnType<typeof readCursor>, beyondService: readonly string[] = []): Section {
  const m = r.machine;
  const tones = { ok: "ok", warn: "waiting", error: "failed", off: "hint" } as const;
  const setUp = setUpApplications(m);
  // An application's rows carry its name: "Claude plugin" and "claude setup" are both claude's.
  const ownedBySetUp = (label: string) => setUp.some((name) => label.toLowerCase().includes(name.toLowerCase()));
  const rows: [string, Cell][] = wide
    ? m.integrations.map((item) => [item.name, stateCell(item.text, tones[item.state])])
    : m.integrations.filter((item) => item.client ? item.state === "warn" || item.state === "error" : item.state !== "ok" && ownedBySetUp(item.name)).map((item) => [item.name, stateCell(item.text, tones[item.state])]);
  rows.unshift(["Agent applications", applicationsCell(m, interactive, beyondService)]);
  if (wide)
    for (const connector of m.connectors ?? []) {
      if (m.integrations.some((item) => item.name.toLowerCase().includes(connector.name.toLowerCase()))) continue;
      rows.push([connector.name, stateCell(connector.missing.length ? `${connector.missing.join(", ")} not on PATH` : connector.requires.length ? "available on PATH" : "in-process", connector.missing.length ? "waiting" : "ok")]);
    }
  // A remote registration uses the broker elsewhere. Keep executable readiness in the full
  // diagnostics, without making a hosted client repair a binary it does not need to run.
  const localBroker = r.meshes.hasPrepared || r.meshes.currentPrepared || r.meshes.unreadable.length > 0 ||
    r.meshes.items.some((entry) => entry.origin !== "manual" && entry.origin !== "catalog") ||
    r.folder.controllerStack || r.folder.storedState || r.folder.auth.state !== "none" ||
    (r.folder.stackJournal !== undefined && r.folder.stackJournal !== "absent") ||
    r.folder.processes?.some((row) => row.name === "nats" && (row.pid !== null || row.state === "unreadable")) ||
    (!r.selected.resolved && (r.selected.code === "not-started" || r.selected.code === "unregistered-root" || r.selected.code === "unreadable-auth"));
  if (wide || (localBroker && (m.nats === "missing" || m.natsProblem)))
    rows.push(["Broker executable", stateCell(m.nats === "missing" ? "not installed" : brokerExecutable(m), m.nats === "missing" ? "waiting" : m.natsProblem ? "failed" : "ok")]);
  const skillsState = m.skills.state;
  if (wide || skillsState === "behind" || skillsState === "unreadable" || (skillsState === "not-installed" && setUp.length > 0))
    rows.push(["Agent skills", skillsCell(m.skills)]);
  if (wide || m.web.installed === null)
    rows.push(["Dashboard", stateCell(m.web.installed === null ? "installation could not be read" : m.web.installed ? "installed" : "not installed · optional", m.web.installed === null ? "failed" : m.web.installed ? "ok" : "hint")]);
  const extensions = wide
    ? r.extensions.items === null ? stateCell("manifest could not be read", "failed") : r.extensions.items.length ? r.extensions.items.map((item) => `${item.label} v${item.version}`).join(" · ") : undefined
    : extensionsCell(r.extensions);
  if (extensions !== undefined) rows.push(["Extensions", extensions]);
  if (seed) rows.push(["Connector setup", stateCell(`incomplete · ${seed.package} failed during ${seed.phase}`, "failed")]);
  return {
    title: "This machine",
    blocks: [
      { kind: "lines", lines: [`cotal ${m.version}  ·  Node ${m.node}  ·  ${m.platform}`] },
      { kind: "fields", rows },
    ],
  };
}

function connectionCell(s: Extract<SelectedResult, { resolved: true }>): Cell {
  if (s.connection === "ok" || s.connection === "reachable") return stateCell("reachable", "ok");
  const states: Readonly<Record<string, string>> = {
    "root-gone": "project folder was moved or deleted",
    unreachable: "unreachable",
    "slow-link": "not answering",
    "broker-stopped": `broker process ${s.brokerPid} is stopped`,
    "tls-trust": "TLS could not be verified",
    "tls-unsupported": "listener does not offer required TLS",
    "auth-unsupported": "listener does not enforce Cotal authentication",
    "jetstream-unsupported": "listener does not offer JetStream",
    "non-nats-listener": "non-NATS listener holds the broker address",
    "stale-auth": "credentials need renewal",
    "auth-required": "authentication required",
    "open-wants-auth": "authentication required",
    "registry-open-now-auth": "authentication required",
    "creds-rejected": "credentials rejected",
    "registry-creds-rejected": "credentials rejected",
    "address-held": "address held by another space",
  };
  return stateCell(`${states[s.connection] ?? s.connection.replaceAll("-", " ")}${s.staleRecord ? " · saved registration needs attention" : ""}`, "failed");
}

/** Show recorded mode, TLS, and catalog problems. `cotal space show <name>` names the address. */
function signsInText(entry: StatusResult["meshes"]["items"][number], wide: boolean): string {
  return [
    `${entry.mode === "user" ? "user sign-in" : entry.mode === "auth" ? "static auth" : "open"}${entry.modeChecked ? "" : ", not checked"}`,
    ...(wide ? [entry.origin === "catalog" ? "saved catalog entry" : entry.origin === "manual" ? "registered endpoint" : "local registration"] : []),
    entry.tlsRequired ? "TLS required" : "",
    entry.catalog?.error ? "catalog refresh failed" : "",
  ].filter(Boolean).join(" · ");
}

/** The connection state of one row: the selected space's own dialed state when this row is the
 *  address it dialed, else the row's own check. A row that was not dialed carries no state, and the
 *  note under the table says so once instead of repeating it on every row. */
function spaceStateCell(r: StatusResult, entry: StatusResult["meshes"]["items"][number]): Cell {
  const selected = r.selected.resolved && entry.space === r.selected.space;
  // The selected connection describes this row only when it dialed the row's address; under
  // `--all` with a `--server` that names another, the row shows its own address's check.
  if (selected && r.selected.resolved && entry.check !== "not-checked" && r.selected.server !== null && entry.server !== null &&
    brokerUrlKey(r.selected.server) === brokerUrlKey(entry.server)) return connectionCell(r.selected);
  if (entry.check === "not-checked") return "";
  return stateCell(entry.check === "slow-link" ? "not answering" : entry.check === "broker-stopped" ? "broker process is stopped" : entry.check, entry.check === "reachable" ? "ok" : "failed");
}

/**
 * The spaces this machine knows: the selected one first with its connection state, then one line
 * each for the others.
 *
 * Only the selected space is dialed, so the others carry no state and ONE note says so, rather than
 * `not checked` repeated on every row; `--all` dials each and fills the column. The broker address
 * is not a group title: it groups spaces by an address a reader does not act on here, and `cotal
 * space show <name>` names it. `--all` and `--wide` keep the grouped report.
 */
function spacesOverview(r: StatusResult, wide: boolean, seedFailed: boolean, currentJournalUnreadable: boolean): Section {
  const blocks: Section["blocks"][number][] = [];
  // The space this report is for: the target it resolved or the space it is about, else the selection
  // it could not resolve.
  const reported = r.selected.space ?? r.meshes.current;
  const row = (entry: StatusResult["meshes"]["items"][number]) => ({
    space: entry.space === reported ? cell(`→ ${entry.space}`, "selected") : entry.space,
    state: spaceStateCell(r, entry),
    detail: cell(signsInText(entry, wide), "hint"),
  });
  const columns = [{ key: "space", label: "Space" }, { key: "state", label: "Connection" }, { key: "detail", label: "Signs in" }];
  if (!r.meshes.items.length && !r.meshes.unreadable.length) blocks.push({ kind: "lines", lines: [cell("No spaces registered", "hint"), ...(seedFailed ? [] : [cell(`Sign in to Cotal Cloud with \`${displayCmd()} login\`.`, "hint")])] });
  else if (wide) {
    const groups = new Map<string, StatusResult["meshes"]["items"]>();
    for (const entry of r.meshes.items) {
      const key = entry.server ?? `unavailable:${entry.space}`;
      const group = groups.get(key);
      if (group) group.push(entry);
      else groups.set(key, [entry]);
    }
    for (const entries of groups.values()) {
      blocks.push({ kind: "lines", lines: [cell(entries[0]!.server ?? "Broker address unavailable", "title")] });
      blocks.push({ kind: "table", header: false, columns, rows: entries.map(row) });
    }
  } else {
    // The space this report is for first, then the rest by name: the one a command here targets is
    // the one a reader looks for.
    const ordered = [...r.meshes.items].sort((a, b) =>
      Number(b.space === reported) - Number(a.space === reported) || a.space.localeCompare(b.space));
    blocks.push({ kind: "table", header: false, columns, rows: ordered.map(row) });
    if (r.meshes.items.some((entry) => entry.check === "not-checked"))
      blocks.push({ kind: "lines", lines: [cell(`Unselected spaces are not dialed · \`${displayCmd()} status --all\` dials each`, "hint")] });
  }
  for (const unreadable of r.meshes.unreadable) blocks.push({ kind: "lines", lines: [stateCell(`Registration could not be read: ${unreadable.error}`, "failed")] });
  // One line per account, named by the account whose catalog failed rather than by its token URL.
  for (const account of r.meshes.catalogs) if (account.error) blocks.push({ kind: "lines", lines: [stateCell(`Space catalog for ${account.account ?? account.idp} could not be refreshed: ${account.error}`, "failed")] });
  if (!r.meshes.currentRecorded) blocks.push({ kind: "lines", lines: [cell(`Selected space '${r.meshes.current}' ${currentMeshState(r.meshes, currentJournalUnreadable)}${folderTargeted(r) ? "; it applies outside this folder" : ""}`, "waiting")] });
  return { title: "Spaces", blocks };
}

/** The unresolved selections that mean nothing runs or is selected here, rather than a failure. */
const NOTHING_SELECTED = new Set(["no-meshes", "not-started", "unregistered-root"]);

/** Whether this report is for this folder's space, which a command without `--space` targets here
 *  instead of the selection. */
function folderTargeted(r: StatusResult): boolean {
  return typeof r.meshes.folder === "string" && r.meshes.folder === r.selected.space;
}

function selectedOverview(r: StatusResult, stackStarting: boolean, selectedStarting: boolean): Section | undefined {
  const s = r.selected;
  const title = !s.resolved && s.recordedRoot !== undefined ? "This folder" : folderTargeted(r) ? "This folder's space" : "Selected space";
  // Nothing running or selected is a state to start from, so it does not carry the mark of a live connection.
  if (!s.resolved) return { title, blocks: [
    { kind: "lines", lines: [stateCell(s.message, NOTHING_SELECTED.has(s.code) ? "hint" : "failed")] },
    ...(selectedStarting || servedStack(r.folder, s) ? stackLines(r.folder, selectedStarting) : []),
  ] };
  // A broker named with `--server` is reported even when nothing on this machine is registered.
  if (s.source !== "flag-server" && !r.meshes.items.length && !r.meshes.currentPrepared && r.folder.auth.state === "none" && !r.folder.processes?.some((item) => item.pid !== null)) return undefined;
  const responder = responderText(s.deliveryResponder, s.mode, Boolean(servedStack(r.folder, s) && r.folder.stackBlock), stackDeliveryPid(r), r.store?.state === "full");
  const rows: [string, Cell][] = [
    ["Broker", s.server ?? stateCell("address unavailable", "failed")],
    ["Connection", connectionCell(s)],
    ...(s.spaceStreams.state === "absent" ? [["Space streams", stateCell(s.spaceStreams.stack === "running" ? "not on the broker · the space was deleted under its running stack" : "not on the broker · a space delete removed them", "failed")] as [string, Cell]] : []),
    ...(responder ? [["Delivery responder", stateCell(responder.text, responder.tone)] as [string, Cell]] : []),
    ...(r.store?.state === "write-failed" ? [["Store", stateCell(`write failed at ${r.store.at}: ${r.store.cause}${r.store.path ? ` · ${r.store.path}` : ""}`, "failed")] as [string, Cell]] : []),
    ...(r.store?.state === "full" ? [["Store", stateCell(`full · ${r.store.used} bytes stored, over its --max-file-store cap of ${r.store.cap} · ${r.store.path}`, "failed")] as [string, Cell]] : []),
    ...(r.store?.state === "damaged" ? [["Store", stateCell(`damage logged at ${r.store.at}: ${r.store.warning}`, "failed")] as [string, Cell]] : []),
    ...(r.stackManager ? [["Manager", r.stackManager.endpoint === "answered" ? stateCell("answering", "ok") : r.stackManager.endpoint === "not-answering" ? stateCell(`not answering · stack-manager pid ${r.stackManager.pid}`, "failed") : stateCell("endpoint not checked", "hint")] as [string, Cell]] : []),
    ["Access", s.mode === "user" ? "user sign-in" : s.mode === "auth" ? "static auth" : "open"],
    ["Project", s.rootGone ? stateCell(`${s.root} · folder is gone`, "failed") : s.root],
    ["Default agent", r.machine.defaults ? `${r.machine.defaults.harness ?? "application unresolved"} · persona ${r.machine.defaults.persona ?? "not set"}` : stateCell("saved defaults could not be read", "failed")],
    ["Persona catalog", s.personas.default === "valid" ? "default available" : stateCell(s.personas.default === "invalid" ? "default is invalid" : s.personas.default === "unreadable" ? "could not be read" : "no default persona", s.personas.default === "invalid" || s.personas.default === "unreadable" ? "failed" : "hint")],
  ];
  if (s.tlsRequired) rows.push(["Transport", "TLS required"]);
  if (s.eventsRequired) rows.push(["Events", "required"]);
  if (s.mode === "user") {
    if (!s.login) rows.push(["Account", stateCell("could not be read", "failed")]);
    else if (!s.login.subject) rows.push(["Account", stateCell("not signed in", "waiting")]);
    else {
      rows.push(["Account", `${s.login.subject} · session until ${s.login.expiresAt}`]);
      rows.push(["Grant", stateCell(s.login.actor === "granted" ? "granted" : s.login.actor === "not-granted" ? "not granted" : "not checkable on this machine", s.login.actor === "granted" ? "ok" : s.login.actor === "not-granted" ? "waiting" : "hint")]);
    }
  }
  if (s.snapshot.state === "unavailable") rows.push(["Live details", stateCell(`unavailable · ${s.snapshot.reason}`, "waiting")]);
  if (servedStack(r.folder, s) && r.folder.noManager && !r.stackManager) {
    const service = r.folder.managerService;
    const outside = r.outsideStackManager;
    rows.push(["Manager", service
      ? stateCell(`the ${service.definition} service · instance ${service.instanceId} · outside this stack, which was started with --no-manager`, "ok")
      : outside?.endpoint === "answered"
        ? stateCell(`answering${outside.instanceId ? ` · instance ${outside.instanceId}` : ""} · outside this stack, which was started with --no-manager`, "ok")
        : stateCell(`${outside?.endpoint === "not-answering" ? "no manager answered" : "endpoint not checked"} · this stack was started with --no-manager`, "hint")]);
  }
  const blocks: Section["blocks"][number][] = [{ kind: "fields", rows }];
  if (r.folder.root === s.root && r.folder.processSpace === s.space && r.folder.controllerStack) {
    blocks.push({ kind: "lines", lines: [cell("Controller stack · its members are the stack-* rows under Owned services", "hint")] }, ...stackLines(r.folder, stackStarting));
  } else if (r.folder.root === s.root && r.folder.stackJournal === "unreadable") {
    blocks.push({ kind: "lines", lines: [cell("Stack journal unreadable · no stack membership or stopped state was inferred; see Owned services and the journal warning", "failed")] });
  } else if (r.folder.root === s.root && r.folder.processSpace === s.space && r.folder.processes) {
    blocks.push({ kind: "lines", lines: [cell("Legacy local process records", "label")] });
    blocks.push({
      kind: "table", header: false,
      columns: [{ key: "name", label: "Service" }, { key: "state", label: "State" }],
      rows: r.folder.processes.map((item) => ({
        name: item.name === "nats" ? "Broker" : item.name === "manager" ? "Manager" : item.name === "delivery" ? "Delivery" : item.name === "web" ? "Web" : item.name,
        state: item.state !== "stopped" ? processCell(item) : stateCell(item.pid === null && item.detail !== "stopped" ? "not started" : item.detail ?? "stopped", "hint"),
      })),
    });
  } else blocks.push({ kind: "lines", lines: [cell("Legacy process records not checked here · the selected space has a different or unresolved local process scope", "hint")] });
  if (r.folder.launches === false) blocks.push({ kind: "lines", lines: [cell(`This folder's personas are not used by the selected space. Spawn uses ${s.personas.root}.`, "waiting")] });
  return { title: `${title}  → ${s.space}`, blocks };
}

/** The selected space and its root when this folder's controller stack serves it: a resolved one, or
 *  a prepared one that is not started, as an `up` cut off before it registered the space leaves it. */
export function servedStack(folder: StatusResult["folder"], s: { space?: string; root?: string }): { space: string; root: string } | undefined {
  if (s.space === undefined || s.root === undefined) return undefined;
  return folder.controllerStack && folder.root === s.root && folder.processSpace === s.space ? { space: s.space, root: s.root } : undefined;
}

/** This folder's own controller stack when it does not serve the selected space. The note under the
 *  heading sends to status when its last operation has no recorded outcome, so status names it. */
export function folderStack(folder: StatusResult["folder"], s: SelectedResult): { space: string; root: string } | undefined {
  return folder.controllerStack && folder.processSpace !== null && !servedStack(folder, s) ? { space: folder.processSpace, root: folder.root } : undefined;
}

/** The lines that name this folder's stack operation cut off with no recorded outcome: one that keeps
 *  `up` and `down` from settling it, or one that left the stack part way. */
function stackLines(folder: StatusResult["folder"], stackStarting: boolean): Section["blocks"][number][] {
  if (stackStarting) return [{ kind: "lines", lines: [stateCell("Startup in progress", "waiting")] }];
  const blocks: Section["blocks"][number][] = [];
  if (folder.stackBlock) blocks.push({ kind: "lines", lines: [stateCell(`Stack blocked · ${folder.stackBlock.reason}`, "waiting")] });
  const part = folder.stackUnfinished;
  if (part) blocks.push({ kind: "lines", lines: [stateCell(part.kind === "up"
    ? part.running.length ? `Half started · the last up ended before ${roleList(part.stopped)} started; ${roleList(part.running)} ${part.running.length === 1 ? "runs" : "run"}` : "Start interrupted · the last up ended before any member started"
    : part.stopped.length ? `Half stopped · the last down ended with ${roleList(part.running)} still running; ${roleList(part.stopped)} ${part.stopped.length === 1 ? "is" : "are"} stopped` : "Stop interrupted · the last down ended before any member stopped", "waiting")] });
  return blocks;
}

/** Stack members as a status line names them: `broker`, `delivery and manager`. */
function roleList(roles: readonly StackRole[]): string {
  return roles.length > 1 ? `${roles.slice(0, -1).join(", ")} and ${roles.at(-1)}` : roles[0] ?? "";
}

/** Pre-commit backup claims and ready cuts with a missing source block ordinary startup. */
export function backupRecovery(maintenance: StatusResult["maintenance"], sourceMissing = false): string | null {
  return maintenance && (maintenance.state === "claimed" || maintenance.state === "restore-ready" || sourceMissing) ? maintenance.next : null;
}

function statusLaunchNext(r: StatusResult, s: Extract<SelectedResult, { resolved: true }>, scope: Parameters<typeof onRerun>[1], reachable: boolean, noApplication: boolean): { command: string; description: string } | string | undefined {
  const defaults = r.machine.defaults;
  const cmd = displayCmd();
  if (defaults?.persona === "default" && s.personas.default !== "missing" && s.personas.default !== "valid") {
    if (!noApplication) return { command: onRerun(`${cmd} persona show default`, scope), description: "See what is wrong with the default persona" };
    return undefined;
  }
  if (!reachable || s.deliveryResponder === "unbound" || s.deliveryResponder === "stale" || !defaults?.harness || !r.machine.connectors?.length) return undefined;
  return defaultLaunchBlock(defaults.harness, r.machine.connectors) ?? { command: onRerun(`${cmd} spawn`, scope), description: defaults.persona === "default" && s.personas.default === "missing" ? "Open your default agent; creates the shipped default persona" : "Open your default agent" };
}

function nextActions(r: StatusResult, seedFailed: boolean, interactive: boolean, recovery: string | null, preparedHarness?: string, stoppedForeignListener = false, stackStarting = false, selectedStarting = false): Section {
  if (seedFailed) return {
    title: "Next",
    blocks: [{ kind: "lines", lines: r.hints.flatMap(hint => hint.split("\n").map(line => cell(line, "hint"))) }],
  };
  if (recovery) return { title: "Next", blocks: [...new Set([recovery, ...r.hints])].map((hint) => ({ kind: "lines", lines: [cell(hint, "hint")] })) };
  const cmd = displayCmd();
  const items: { command: string; description: string }[] = [];
  const extra: string[] = [];
  let restartBlock: CommandFailure | undefined;
  const noApplication = !setUpApplications(r.machine).length;
  if (!r.selected.resolved && !r.meshes.items.length && !r.meshes.unreadable.length) {
    items.push({ command: `${cmd} login`, description: "Sign in to Cotal Cloud" });
  }
  if (noApplication) {
    const s = r.selected;
    const connector = r.machine.connectors?.find((row) => row.name === preparedHarness);
    if (interactive) items.push({ command: `${cmd} setup`, description: !s.resolved && s.code !== "not-started" ? "Set up an agent application and a space" : "Set up an agent application" });
    else if (connector && !s.resolved && s.code === "not-started" && s.root && s.space && !s.recordedRoot) {
      const guide = Object.hasOwn(OFFICIAL_CONNECTORS, connector.name) ? `connect-${connector.name}` : "connectors";
      extra.push(`Install ${connector.missing.join(", ")} on PATH first. See https://docs.cotal.ai/docs/${guide}/.`);
      items.push({ command: `${cmd} setup --destination local --harness ${shellWord(connector.name)} --project ${shellWord(s.root)} --space ${shellWord(s.space)} --configure-only --no-input`, description: "" });
    } else items.push({ command: `${cmd} setup --help`, description: "See setup flags for scripts. Bare setup needs a terminal." });
  }
  if (r.selected.resolved) {
    const s = r.selected;
    const reachable = s.connection === "ok" || s.connection === "reachable";
    const scope = { space: s.source === "flag-server" ? undefined : s.space, server: s.source === "flag-server" || s.source === "flag-space-override" ? s.server : undefined };
    const launch = statusLaunchNext(r, s, scope, reachable, noApplication);
    if (typeof launch === "string") extra.push(launch);
    else if (launch) items.push(launch);
    if (reachable) items.push({ command: onRerun(`${cmd} who`, scope), description: "See the live roster" });
    if (r.stackManager?.endpoint === "answered" || r.outsideStackManager?.endpoint === "answered")
      items.push({ command: onRerun(`${cmd} ps`, scope), description: "List managed agents" });
  }
  if (r.selected.resolved || !noApplication) {
    items.push({ command: `${cmd} space`, description: "List the spaces on this machine" });
    const unchecked = r.meshes.items.some(m => m.check === "not-checked");
    if (!r.selected.resolved || r.selected.source !== "registry" || unchecked)
      items.push({ command: `${cmd} use <name>`, description: "Select the default space" });
    if (r.meshes.items.length > 1 && unchecked)
      items.push({ command: `${cmd} status --all`, description: "Check every registered space" });
  }
  // A stopped broker is resumed, not restarted. A local controller stack that does not answer,
  // or one with a member whose process is gone, otherwise restarts its stopped members from its
  // own records. One whose last operation a member keeps unsettled is named the way out that
  // `up` and `down` name instead. A stack started with --no-manager leaves its manager out by choice,
  // so a manager record an earlier up left is not a stopped member, and the restart keeps the flag.
  const memberGone = r.services?.instances?.some((row) => row.definition.startsWith("stack-") && ["gone", "foreign-pid", "previous-boot"].includes(row.observedProcess) && !(r.folder.noManager && row.definition === STACK_DEFINITION.manager)) === true;
  // A connection to a `--server` address other than the recorded one does not say whether the stack
  // answers; the hint `readSelected` adds names that address. A user-auth space is probed on its own path.
  const dialed = r.selected.resolved ? r.selected : undefined;
  const recordedServer = r.meshes.items.find((m) => m.space === dialed?.space)?.server;
  const elsewhere = dialed !== undefined && dialed.mode !== "user" && (dialed.source === "flag-server" || dialed.source === "flag-space-override")
    && (recordedServer == null || dialed.server === null ? recordedServer !== dialed.server : brokerUrlKey(recordedServer) !== brokerUrlKey(dialed.server));
  const stack = servedStack(r.folder, r.selected), own = stack !== undefined;
  const seedBlocksRestart = r.selected.channelSeedBlocksRestart;
  // This folder's own stack is blocked the same way under another selection, and its block leads too.
  const blocked = stack ?? folderStack(r.folder, r.selected);
  const block = blocked ? r.folder.stackBlock : undefined;
  const startingSpace = selectedStarting ? r.selected.space : stackStarting ? blocked?.space : undefined;
  const origin = r.meshes.items.find((m) => m.space === dialed?.space)?.origin;
  const legacy = dialed && !r.folder.controllerStack && r.folder.root === dialed.root && r.folder.processSpace === dialed.space;
  const local = legacy && dialed.mode === "auth" && !["manual", "catalog"].includes(origin ?? "up");
  const exited = legacy ? (r.folder.processes ?? []).filter((row) => (row.name === "nats" || row.name === "manager") && row.state === "stopped" && (row.pid !== null || row.detail === "stopped")).map((row) => row.name) : [];
  const storeBlocked = !elsewhere && r.selected.resolved && r.selected.connection === "unreachable" && rootStoreProblem(r.selected.root) !== undefined;
  if (r.selected.resolved && r.selected.connection === "broker-stopped") items.unshift({ command: `kill -CONT ${r.selected.brokerPid}`, description: "Resume the stopped broker process so it answers again" });
  else if (stoppedForeignListener) { /* The address remedy in hints takes precedence over a restart. */ }
  else if (startingSpace !== undefined) {
    items.unshift({ command: `${cmd} status --space ${shellWord(startingSpace)}`, description: "Wait for startup to finish, then check again" });
  } else if (block && blocked) {
    const inspect = { command: `${cmd} service status ${block.definition} --instance ${block.instanceId} --space ${shellWord(blocked.space)}`, description: block.route.kind === "inspect" ? "Inspect the member that keeps up and down from settling" : "Inspect that member" };
    items.unshift(...(block.route.kind === "abandon" ? [{ command: `${cmd} down --abandon-stop ${block.route.requestId} --yes`, description: `Abandon the unconfirmed stop of ${block.definition}; up and down refuse until then` }, inspect] : [inspect]));
  } else if (stack && r.folder.stackUnfinished) {
    const part = r.folder.stackUnfinished;
    const restart = `${cmd} up --root ${shellWord(stack.root)}${part.noManager ? " --no-manager" : ""}`;
    // An up that ended before it registered the space cannot be finished: the next up reuses the
    // running broker, and delivery does not start for a space that is not registered.
    items.unshift(...(part.kind === "up"
      ? r.selected.resolved || !part.running.length
        ? seedBlocksRestart ? [] : [{ command: restart, description: `Finish starting the stack: the last up ended before ${roleList(part.stopped)} started` }]
        : [{ command: `${cmd} down --yes`, description: `Stop what the last up started: it ended before it registered the space, so up cannot finish it` }, { command: restart, description: "Then start the stack again" }]
      : [{ command: `${cmd} down --yes`, description: `Finish stopping the stack: the last down ended with ${roleList(part.running)} still running` },
        ...(part.stopped.length && !seedBlocksRestart ? [{ command: `${cmd} up --root ${shellWord(stack.root)}`, description: "Or restart this stack's stopped members from its recorded inputs" }] : [])]));
  } else if (r.selected.resolved && r.selected.spaceStreams.state === "absent") {
    // Up creates the streams again only while the stack's other members are stopped.
    const stack = r.selected.spaceStreams.stack;
    if (own && stack === "running")
      items.unshift({ command: `${cmd} down --yes`, description: "Stop the stack its space was deleted under" }, { command: `${cmd} up`, description: "Then start it again; up creates the space's streams, empty" });
    else if (own)
      items.unshift({ command: `${cmd} up --root ${shellWord(r.selected.root)}`, description: stack === "stopped" ? "Create the space's streams again, empty, and restart the stack's stopped members" : `Create the space's streams again, empty; while the stack runs, stop it first with \`${cmd} down --yes\`` });
    else {
      const absent = spaceStreamsAbsent(r.selected.space, r.selected.spaceStreams.root ?? undefined, stack ?? undefined);
      extra.push(`${absent.message}; ${absent.remedy}`);
    }
  } else if (!storeBlocked && !seedBlocksRestart && own && r.selected.resolved && r.store?.state !== "full" && (memberGone || !elsewhere && r.selected.connection !== "ok" && r.selected.connection !== "reachable")) {
    restartBlock = channelSeedRestartBlock(stack.root);
    // `up` neither adopts nor replaces a service outside the stack that runs one of this root's
    // records, so each is stopped first, with the stop `up` names.
    const held = r.folder.heldServices ?? [], space = r.selected.space;
    if (!restartBlock) items.unshift(...held.map((row) => ({ command: `${cmd} svc stop ${row.definition} --instance ${row.instanceId} --space ${shellWord(space)} --yes`, description: `Stop the ${row.definition} service, which runs this root's ${row.record} (pid ${row.pid}) outside the stack` })),
      { command: `${cmd} up --root ${shellWord(r.selected.root)}${r.folder.noManager ? " --no-manager" : ""}`, description: held.length ? "Then restart this stack's stopped members from its recorded inputs" : "Restart this stack's stopped members from its recorded inputs" });
  } else if (!elsewhere && legacy && dialed.mode === "open" && dialed.connection === "ok" && origin === "up" && exited.includes("manager") && r.folder.processes?.some((row) => row.name === "nats" && row.state === "running")) {
    restartBlock = channelSeedRestartBlock(dialed.root);
    if (!restartBlock) items.unshift({ command: `${cmd} up`, description: "Restart this folder's manager without stopping the broker" });
  } else if (!storeBlocked && !seedBlocksRestart && local && exited.length) {
    const broker = exited.includes("nats"), manager = exited.includes("manager");
    const notes = [...(broker ? ["up reopens the recorded store"] : []), ...(manager ? ["pass --runtime again if the manager ran on one"] : [])];
    items.unshift({ command: `${cmd} up`, description: `Restart this folder's ${broker && manager ? "broker and manager" : broker ? "broker" : "manager"}, which exited; ${notes.join("; ")}` });
  } else if (!storeBlocked && !seedBlocksRestart && local && r.selected.resolved && r.selected.connection === "unreachable" && (r.folder.processes ?? []).every((row) => row.state === "stopped")) {
    // A clean down leaves every member stopped with no pidfile. Spawn and ps need the stack, so the
    // bare `up` that starts it again on its recorded address and store comes first.
    items.unshift({ command: `${cmd} up`, description: "Start this folder's stopped stack again; pass --runtime again if the manager ran on one" });
  } else if (!seedBlocksRestart && !elsewhere && local && r.selected.resolved && r.selected.connection === "ok" && r.store?.state !== "full" && r.store?.state !== "write-failed"
    && (r.selected.deliveryResponder === "unbound" || r.selected.deliveryResponder === "stale")
    && r.folder.processes?.some((row) => row.name === "delivery" && row.state === "stopped")) {
    items.unshift({ command: `${cmd} up`, description: "Restore the delivery responder" });
  }
  // A stack whose folder was deleted stops only from this machine's records.
  if (r.selected.resolved && r.selected.rootGone) items.unshift({ command: `${cmd} down --space ${shellWord(r.selected.space)} --yes`, description: "Stop the stack whose folder is gone and free its name" });
  if (r.selected.resolved && r.selected.mode === "user" && r.selected.login && !r.selected.login.subject) items.unshift({ command: `${cmd} login --idp ${r.selected.login.idp}`, description: "Sign in to the selected space" });
  // A delivery member that runs with no lease is not replaced by `up`; `down` kills one that does not exit.
  const deliveryPid = stackDeliveryPid(r);
  if (r.selected.resolved && r.selected.deliveryResponder === "unbound" && deliveryPid !== undefined)
    items.unshift(
      { command: `${cmd} service status stack-delivery${own ? "" : ` --space ${shellWord(r.selected.space)}`}`, description: `Read the delivery member's record: pid ${deliveryPid} is alive but holds no lease, so it is starting or not responding` },
      { command: own ? `${cmd} down --yes` : `${cmd} down --space ${shellWord(r.selected.space)} --yes`, description: "If it stays that way, stop the stack; down kills a member that does not exit on SIGTERM" },
      { command: own ? `${cmd} up` : `${cmd} up --root ${shellWord(r.selected.root)}`, description: "Then start the stack again" },
    );
  // A manager that does not answer cannot report its stop impact, so no stop route reaches it.
  if (r.stackManager?.endpoint === "not-answering")
    items.unshift({ command: `kill -KILL ${r.stackManager.pid}`, description: `The stack manager does not answer, so \`${cmd} down\` cannot stop it. If it stays that way, end its process; \`${cmd} down --yes\` then records it stopped` });
  // The broker keeps a store write error until it restarts, so messages sent meanwhile may be lost.
  if (r.store?.state === "write-failed") {
    const repair = storeWriteRepair(r.store, r.selected.resolved ? r.selected.root : undefined, r.selected.space ?? "");
    const first = `First ${repair}`;
    // A broker without JetStream cannot record the manager's stop, and it stops only after the manager.
    if (r.store.jetStreamDisabled && r.stackManager && r.selected.resolved)
      items.unshift(
        { command: `kill -TERM ${r.stackManager.pid}`, description: "The broker disabled JetStream after the write failure and serves none until it restarts, which needs the manager stopped first. On this host, end the manager; it stops its agents by its default policy" },
        { command: own ? `${cmd} down --yes` : `${cmd} down --space ${shellWord(r.selected.space)} --yes`, description: "Then stop the other members" },
        { command: own ? `${cmd} up` : `${cmd} up --root ${shellWord(r.selected.root)}`, description: `${first}; then up starts the broker again with the history it kept` },
      );
    else items.unshift({ command: `${cmd} down`, description: `${first}; then \`${cmd} up\` starts the broker again with the history it kept` });
  }
  // The broker refuses every write while the store is over its cap, so sends store nothing, and a
  // stopped member starts again only once there is room. A larger cap makes that room and keeps the
  // history, but needs the broker restarted, so the manager's own process is ended first where it
  // runs, as a full store refuses its stop. This is the route up names. A history purge is not named:
  // it frees only the channel history's bytes, which may leave the store over its cap.
  if (r.store?.state === "full" && r.selected.resolved) {
    const { root } = r.selected;
    const manager = r.stackManager;
    items.unshift(
      ...(manager ? [{ command: `kill -TERM ${manager.pid}`, description: "End the manager on this host, as a full store refuses its stop; it stops its agents by its default policy" }] : []),
      // `down` stops only the stack of the folder it runs in.
      { command: `${cmd} down --yes`, description: `${manager ? "Then stop the other members" : "Stop the stack"}${own ? "" : `; run it in ${root}`}` },
      { command: own ? `${cmd} up --max-file-store <bytes>` : `${cmd} up --root ${shellWord(root)} --max-file-store <bytes>`, description: "Then start it again with a larger cap; the store keeps the history" },
    );
  }
  // The broker keeps serving a store it found damage in, from what it can still read there.
  if (r.store?.state === "damaged" && r.selected.resolved && r.services?.instances?.some((row) => row.definition === STACK_DEFINITION.broker))
    items.unshift({ command: `${cmd} service logs stack-broker${own ? "" : ` --space ${shellWord(r.selected.space)}`}`, description: "Read what the broker logged about the damage it found in its store; history holds only what it could still read" });
  const first = restartBlock ? [{ kind: "lines" as const, lines: [cell(`Restart blocked: ${restartBlock.message}. ${restartBlock.remedy}`, "hint")] }] : [];
  return { title: "Next", blocks: [...first, { kind: "commands", items }, ...[...extra, ...r.hints].map((hint) => ({ kind: "lines" as const, lines: [cell(hint, "hint")] }))] };
}

function ownedServicesOverview(services: OwnedServiceStatus | undefined): Section | undefined {
  if (!services || services.state === "not-checked") return undefined;
  const blocks: Section["blocks"][number][] = [];
  if (services.definitions === null) blocks.push({ kind: "lines", lines: [stateCell("Saved service definitions unavailable", "waiting")] });
  if (services.instances === null) blocks.push({ kind: "lines", lines: [stateCell("Owned service instances unavailable; no stopped state inferred", "waiting")] });
  if (services.instances?.length) blocks.push({ kind: "table", columns: [{ key: "service", label: "Service" }, { key: "instance", label: "Full instance" }, { key: "host", label: "Execution host" }, { key: "process", label: "Process observation" }, { key: "readiness", label: "Recorded readiness" }, { key: "supervisor", label: "Supervisor record" }], rows: services.instances.slice(0, 100).map((row) => ({
    service: row.definition, instance: row.instanceId, host: row.executionHost,
    process: stateCell(row.observedProcess.replaceAll("-", " "), row.observedProcess === "running" ? "ok" : row.observedProcess === "unreadable" || row.observedProcess === "unresolved-launch" || row.observedProcess === "foreign-host" ? "waiting" : "hint"),
    readiness: cell(`${row.startInterrupted ? "start interrupted" : row.readinessObservation.replaceAll("-", " ")} · ${row.readinessAsOf}`, "hint"),
    supervisor: row.supervisorRecord.mechanism === "none-recorded" ? "not assigned here" : `${row.supervisorRecord.mechanism} · ${row.supervisorRecord.fileObservation}; OS state not checked`,
  })) });
  if (services.instances && services.instances.length > 100) blocks.push({ kind: "lines", lines: [cell(`${services.instances.length - 100} instance rows omitted; --json retains the complete readable inventory.`, "hint")] });
  const instantiated = new Set(services.instances?.map((row) => row.definition));
  const saved = services.instances === null ? [] : services.definitions?.filter((row) => !instantiated.has(row.name)) ?? [];
  if (saved.length) blocks.push({ kind: "table", columns: [{ key: "service", label: "Saved service" }, { key: "type", label: "Launch type" }, { key: "observation", label: "Instance records" }], rows: saved.slice(0, 100).map((row) => ({ service: row.name, type: row.launch.type === "adapter" ? row.launch.adapter : "process", observation: "no owned instance recorded" })) });
  if (saved.length > 100) blocks.push({ kind: "lines", lines: [cell(`${saved.length - 100} saved definitions omitted; --json retains the complete readable inventory.`, "hint")] });
  if (services.definitions?.length === 0 && services.instances?.length === 0) blocks.push({ kind: "lines", lines: [cell("No saved definitions or owned instance records in this selected space.", "hint")] });
  blocks.push({ kind: "lines", lines: [cell(`Local records and process observations as of ${services.observedAt}; non-atomic. Recorded readiness is historical, not a fresh endpoint response. No OS unit query, service control, adoption or remote process ownership is implied.`, "hint")] });
  // The space is known here, and a sole instance names its service and full ID as well.
  const sole = services.instances?.length === 1 ? services.instances[0] : undefined;
  if (services.space !== null && (services.instances?.length || services.definitions?.length)) {
    const inspect = `${displayCmd()} svc status ${sole ? `${sole.definition} --instance ${sole.instanceId}` : "<service> --instance <full-id>"} --space ${shellWord(services.space)}`;
    blocks.push({ kind: "commands", items: [{ command: inspect, description: "Inspect one exact owned instance and its recorded supervisor" }, { command: `${displayCmd()} svc`, description: "Read the full saved-service inventory" }] });
  }
  return { title: `Owned services  → ${services.space}`, blocks };
}

function bootAttemptOverview(snapshot: StatusResult["bootAttempts"]): Section | undefined {
  if (!snapshot) return undefined;
  const elsewhere = [...snapshot.elsewhere.slice(0, 100).map((row) => `Launch summary ${row.deploymentId} was recorded at ${row.root}. This folder was moved or copied since, so it reports only that earlier boot and blocks nothing here.`), ...(snapshot.elsewhere.length > 100 ? ["Additional summaries are in JSON."] : [])];
  if (!snapshot.unsettled.length && !snapshot.additive.length && !snapshot.unreadable.length)
    return elsewhere.length ? { title: "Deployment attempts", blocks: [{ kind: "fields", rows: [["Folder root", snapshot.root]] }, { kind: "lines", lines: elsewhere }] } : undefined;
  return { title: "Deployment attempts", blocks: [
    { kind: "fields", rows: [["Folder root", snapshot.root], ["Local read", snapshot.state], ["Unsettled fresh", String(snapshot.unsettled.length)], ["Additive attempts", String(snapshot.additive.length)], ["Unreadable records", String(snapshot.unreadable.length)]] },
    snapshot.unsettled.length ? { kind: "table", columns: [{ key: "id", label: "Fresh boot" }, { key: "space", label: "Space" }, { key: "broker", label: "Recorded broker" }], rows: snapshot.unsettled.slice(0, 100).map((row) => ({ id: row.deploymentId, space: row.space, broker: row.server })) } : { kind: "lines", lines: ["No readable unsettled fresh attempt in this folder."] },
    snapshot.additive.length ? { kind: "table", columns: [{ key: "id", label: "Additive intent" }, { key: "space", label: "Space" }, { key: "state", label: "Recorded state" }], rows: snapshot.additive.slice(0, 100).map((row) => ({ id: row.deploymentId, space: row.space, state: row.recordedState })) } : { kind: "lines", lines: ["No readable additive attempt in this folder."] },
    ...(elsewhere.length ? [{ kind: "lines" as const, lines: elsewhere }] : []),
    { kind: "lines", lines: [...snapshot.unreadable.slice(0, 100).map((path) => `Unreadable record: ${path}`), ...(snapshot.unsettled.length > 100 || snapshot.additive.length > 100 || snapshot.unreadable.length > 100 ? ["Additional records are in JSON."] : []), "A fresh intent may have started a broker; an additive intent may have changed its resources. No retry or stop authority follows from this read."] },
    { kind: "commands", items: [{ command: `${displayCmd()} team show <deployment-id>`, description: "Inspect the original attempt from its recorded root" }] },
  ] };
}

function maintenanceOverview(maintenance: StatusResult["maintenance"]): Section | undefined {
  if (!maintenance) return undefined;
  return { title: "Maintenance", blocks: [
    { kind: "fields", rows: [["Folder root", maintenance.root], ["Space", maintenance.space ?? "not read"], ["State", maintenance.state], ["Attempt", maintenance.attemptId ?? "not read"]] },
    ...(maintenance.next ? [{ kind: "lines" as const, lines: [maintenance.next] }] : []),
    ...(maintenance.rolledBackRuns?.length ? [{ kind: "lines" as const, lines: rolledBackNotes({ runs: maintenance.rolledBackRuns, more: maintenance.rolledBackRunsMore ?? 0 }) }] : []),
  ] };
}

/** The approved screen hierarchy; record-level diagnostics are opt-in. `wide` reports every row in
 *  full, as `--all` and `--wide` ask. */
export function statusView(r: StatusResult, verbose = false, wide = false, { interactive = false, preparedHarness, seed, recovery = backupRecovery(r.maintenance), stoppedForeignListener = false, stackStarting = false, selectedStarting = false, currentJournalUnreadable = false, beyondService = [] }: { interactive?: boolean; preparedHarness?: string; seed?: ReturnType<typeof readCursor>; recovery?: string | null; stoppedForeignListener?: boolean; stackStarting?: boolean; selectedStarting?: boolean; currentJournalUnreadable?: boolean; beyondService?: readonly string[] } = {}): Report {
  const selected = selectedOverview(r, stackStarting, selectedStarting);
  // This folder's own stack under another selection, with the lines it has when it is selected.
  const held = folderStack(r.folder, r.selected), heldLines = held ? stackLines(r.folder, stackStarting) : [];
  const heldSection: Section | undefined = held && heldLines.length ? { title: `This folder's space  → ${held.space}`, blocks: heldLines } : undefined;
  const owned = ownedServicesOverview(r.services);
  const attempts = bootAttemptOverview(r.bootAttempts);
  const maintenance = maintenanceOverview(r.maintenance);
  const sections = [machineOverview(r, wide, interactive, seed, beyondService), spacesOverview(r, wide, Boolean(seed), currentJournalUnreadable), ...(selected ? [selected] : []), ...(heldSection ? [heldSection] : []), ...(maintenance ? [maintenance] : []), ...(attempts ? [attempts] : []), ...(owned ? [owned] : [])];
  if (verbose) sections.push(machineSection(r.machine), extensionsSection(r.extensions), folderSection(r.folder, r.selected), ...meshesSections(r.meshes, currentJournalUnreadable), selectedSection(r.selected, r.folder, stackDeliveryPid(r), r.store?.state === "full"));
  sections.push(nextActions(r, Boolean(seed), interactive, recovery, preparedHarness, stoppedForeignListener, stackStarting, selectedStarting));
  return { sections };
}
