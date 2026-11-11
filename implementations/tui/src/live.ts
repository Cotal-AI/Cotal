import { chatWildcard, DEV_OWNER, parsePrincipalKey, principalKey, readPersonaCatalog, spawnNameError, type ConnectorModelCatalog } from "@cotal-ai/core"
import { connectTargetOrThrow, isCommandFailure, isConnectRefusal, oneLine, refreshRegistrationPolicy, resolvePreference, resolveTargetOrThrow, userViewAuth, type MeshTarget } from "@cotal-ai/workspace"
import { control, controlPs, type ControlClient, type ControlCtx, type ManagedRow, type PsReply } from "@cotal-ai/workspace/control"
import { readManagedLaunch, requestManagedLaunch } from "@cotal-ai/workspace/launch"
import { MeshView, openObserver, type MeshSnapshot } from "@cotal-ai/workspace/view"
import { createSignal, type Accessor, type Setter } from "solid-js"
import { safe } from "./safe.js"
import { applicationsOf, type ConnectorRow, type SpawnRequest, type SpawnSetup, type SpawnState } from "./spawn.js"
import { openTalk, type Closed, type Talk } from "./talk.js"

export type Mesh = MeshSnapshot
export type Presence = Mesh["agents"][number]
export type { FeedEntry } from "@cotal-ai/workspace/view"

/** The app's connection to one space. `live` needs both the broker socket and the Cotal bind; when
 *  either drops the endpoint re-establishes on its own, so that is `reconnecting`, with the last
 *  model kept on screen. `closed` is the app letting go; `failed` never retries. */
export type Conn =
  | { phase: "connecting"; space?: string }
  | { phase: "live"; space: string; server: string; mesh: Mesh }
  | { phase: "reconnecting"; space: string; server: string; mesh: Mesh; reason?: string }
  | { phase: "closed"; space?: string }
  | { phase: "failed"; space?: string; message: string; remedy?: string }

/** What the space's managers last said about the seats they run, keyed by the seat's presence card id.
 *  A failed read is `unavailable` and stops the poll until the space reconnects. `partial` names the
 *  managers that did not answer, whose seats are missing from `byId`. */
export type Managed =
  | { phase: "loading" }
  | { phase: "rows"; byId: ReadonlyMap<string, ManagedRow>; readAt: number; partial?: string }
  | { phase: "unavailable"; reason: string }

export type StopResult = { ok: true } | { ok: false; error: string }

export type Session = {
  conn: Accessor<Conn>
  managed: Accessor<Managed>
  /** Asks the seat's manager to stop the run `row` reports. When the name now belongs to another
   *  run, nothing is stopped. Graceful lets it shut down; otherwise the manager kills the process. */
  stop: (row: ManagedRow, graceful: boolean) => Promise<StopResult>
  /** What the spawn dialog offers: the persona catalog `cotal spawn <persona>` completes from, and
   *  the applications the space's manager reports. A persona folder that cannot be read, or a
   *  manager that does not answer, throws. */
  spawnSetup: () => Promise<SpawnSetup>
  /** Why the mesh cannot carry `name` as an agent's name, if it cannot. */
  nameError: (name: string) => string | undefined
  /** Asks a manager to launch the request as `cotal spawn <persona> --detach` does, then follows the
   *  run it started until this roster shows it or the manager stops listing it. */
  spawn: (req: SpawnRequest) => Accessor<SpawnState>
  /** The human's chat session owner, once the space is open. */
  talk: Accessor<Talk | undefined>
  /** Closes the chat session first, then the observer. Says how the chat session closed, when one
   *  was open. */
  close: () => Promise<Closed | undefined>
}

const OBSERVER_NAME = "tui"
const PS_POLL_MS = 10_000
// While a spawn is followed, the manager is asked often enough that an exit shows within moments.
const FOLLOW_POLL_MS = 2_000

// `controlPs` answers for a user-mesh bearer's one manager under this name, not its instance id.
const BEARER = "owner"

/** A run a spawn follows: its presence card id and lifecycle, the manager instance that holds it,
 *  and when the follow began, since a manager read asked before then may predate the run. */
type Follow = { name: string; id: string; lifecycleUid: string; manager: string; at: number; notice?: string; set: Setter<SpawnState> }

// A manager names an open- or static-mode seat by its bare actor id, while its presence card carries
// the principal `local.<actor>`; a user-mode seat's id is already the principal.
const principalOf = (row: { id: string }) => (parsePrincipalKey(row.id) ? row.id : principalKey(DEV_OWNER, row.id).key)

function failed(space: string | undefined, e: unknown): Conn {
  const f = isConnectRefusal(e) ? e.failure() : isCommandFailure(e) ? e : undefined
  return { phase: "failed", space, message: safe(f?.message ?? (e as Error).message), ...(f?.remedy ? { remedy: safe(f.remedy) } : {}) }
}

/** Opens one space read-only: the space named, or with none the one every command in this folder
 *  would pick. The observer is invisible to peers and nothing is written to the registry. A chat
 *  session opens only when the human first writes. `afterPaint` resolves once the frame showing the
 *  latest change is painted. */
export function openSpace(space: string | undefined, afterPaint: () => Promise<void>): Session {
  const [conn, setConn] = createSignal<Conn>({ phase: "connecting", space })
  const [managed, setManaged] = createSignal<Managed>({ phase: "loading" })
  const [talk, setTalk] = createSignal<Talk>()
  let view: MeshView | undefined
  let target: MeshTarget | undefined
  let ctx: ControlCtx | undefined
  let timer: ReturnType<typeof setInterval> | undefined
  let followTimer: ReturnType<typeof setInterval> | undefined
  const follows = new Set<Follow>()
  let reading = false
  let again = false
  let closed = false

  const client: ControlClient = {
    versionSkew: (detail, undeclared, managerVersion) =>
      `${detail}. The manager does not declare "${undeclared}", so it runs another Cotal release than this app${managerVersion ? ` (the manager reports ${managerVersion})` : " and did not report its version"}. Run both at the same release.`,
    roster: async () => view?.snapshot().agents ?? [],
  }

  const settle = (f: Follow, state: SpawnState) => {
    follows.delete(f)
    f.set(state)
    if (!follows.size) followTimer = void clearInterval(followTimer)
  }
  // A run that ever showed on this roster joined, even if it has since gone offline.
  const joinedRuns = (agents: readonly Presence[]) => {
    for (const f of follows) if (agents.some((p) => p.card.id === f.id && p.lifecycleUid === f.lifecycleUid)) settle(f, { phase: "joined", name: f.name, id: f.id, ...(f.notice ? { notice: f.notice } : {}) })
  }
  // A run the manager that holds it no longer lists, and that never joined, has exited.
  const exitedRuns = (r: Extract<PsReply, { ok: true }>, asked: number) => {
    joinedRuns(view?.snapshot().agents ?? [])
    for (const f of follows)
      if (asked >= f.at && r.answered.some((a) => a.instanceId === f.manager || a.instanceId === BEARER) && !r.rows.some((row) => row.lifecycleUid === f.lifecycleUid))
        settle(f, { phase: "exited", name: f.name, reason: `${f.name} exited before it joined; \`cotal manager logs\` shows why` })
  }
  const follow = (f: Follow, waiting: Extract<SpawnState, { phase: "waiting" }>) => {
    f.set(waiting)
    follows.add(f)
    joinedRuns(view?.snapshot().agents ?? [])
    if (follows.has(f) && !followTimer) followTimer = setInterval(() => void readManaged(), FOLLOW_POLL_MS)
  }

  // One read at a time, so an older answer never lands after a newer one. A poll tick during a read
  // is skipped; a refresh after a stop runs once the read in flight is done.
  const readManaged = async (refresh = false) => {
    if (!ctx || closed) return
    if (reading) return void (again ||= refresh)
    reading = true
    try {
      do {
        again = false
        const asked = Date.now()
        const r = await controlPs(client, ctx, { readOnly: true })
        if (closed) return
        if (!r.ok) {
          clearInterval(timer)
          timer = undefined
          return void setManaged({ phase: "unavailable", reason: safe(r.error) })
        }
        const missing = [...r.failed.map((f) => `${f.instanceId}: ${f.error}`), ...(r.silent.length ? [`${r.silent.length} manager(s) gave no answer: ${r.silent.join(", ")}`] : [])]
        exitedRuns(r, asked)
        setManaged({ phase: "rows", byId: new Map(r.rows.map((row) => [principalOf(row), safe(row)])), readAt: Date.now(), ...(missing.length ? { partial: safe(missing.join("; ")) } : {}) })
      } while (again)
    } finally {
      reading = false
    }
  }
  const poll = () => {
    if (timer || !ctx || closed) return
    void readManaged()
    timer = setInterval(() => void readManaged(), PS_POLL_MS)
  }

  void (async () => {
    try {
      const t = await resolveTargetOrThrow({ space, readOnly: true })
      const c = await connectTargetOrThrow(t, "admin", { readOnly: true })
      if (closed) return
      const user = c.bearer ? await userViewAuth(c, "admin") : undefined
      if (closed) return
      const ep = openObserver({ space: c.space, server: c.server, name: OBSERVER_NAME, auth: user ? { user } : { creds: c.creds } })
      const v = new MeshView(ep, { tapSubject: c.creds || user ? chatWildcard(c.space) : undefined })
      view = v
      await v.start()
      if (closed) return void (await v.stop())
      const show = (raw: Mesh) => {
        if (closed) return
        if (raw.status.connected && conn().phase === "reconnecting") poll()
        joinedRuns(raw.agents)
        const mesh = safe(raw)
        const at = { space: c.space, server: c.server, mesh }
        setConn(raw.status.connected ? { phase: "live", ...at } : { phase: "reconnecting", ...at, ...(mesh.status.error ? { reason: mesh.status.error } : {}) })
      }
      v.on("change", show)
      show(v.snapshot())
      ctx = { space: c.space, server: c.server }
      target = t
      setTalk(openTalk({ target: t, control: client, afterPaint, observer: ep, nameOf: v.nameOf }))
      poll()
    } catch (e) {
      if (!closed) setConn(failed(space, e))
    }
  })()

  // The manager answers once the agent joins, once its process exits, or when its join window ends
  // with the process still running (`uncertain`); a run that answer leaves open is followed.
  const launch = async (req: SpawnRequest, since: number): Promise<Extract<SpawnState, { phase: "refused" }> | { run: Omit<Follow, "at" | "set">; waiting: Extract<SpawnState, { phase: "waiting" }> }> => {
    if (!ctx || !target) return { phase: "refused", error: "the space is not open yet" }
    const at = ctx
    const space = target.space
    const reply = await requestManagedLaunch(
      { persona: req.persona, identity: req.name, agent: req.harness, defaultAgent: req.defaultAgent, model: req.model, variant: req.variant, prompt: req.prompt, events: req.events },
      (args) => control(client, at, "start", args),
    )
    void readManaged(true)
    if (!reply.ok) {
      const run = reply.request?.allocation
      if (!run || reply.code !== "uncertain") return { phase: "refused", error: safe(oneLine(reply.error ?? "the manager did not confirm the launch")) }
      const name = safe(run.name)
      return { run: { name, id: principalKey(run.owner, run.actor).key, lifecycleUid: run.lifecycleUid, manager: reply.request!.managerInstanceId }, waiting: { phase: "waiting", name, late: true, since } }
    }
    const { result, eventsNotice } = readManagedLaunch(reply, { space, requestedModel: req.model ?? null, detached: true }, { space })
    const waitingFor = (reply.data as { waitingFor?: unknown }).waitingFor
    const name = safe(result.name)
    const notice = eventsNotice ? { notice: safe(oneLine(eventsNotice)) } : {}
    return {
      run: { name, id: principalOf(result), lifecycleUid: result.lifecycleUid, manager: result.managerInstanceId, ...notice },
      waiting: { phase: "waiting", name, late: false, since, ...notice, ...(typeof waitingFor === "string" ? { waitingFor: safe(waitingFor) } : {}) },
    }
  }

  return {
    conn,
    managed,
    stop: async (row, graceful) => {
      if (!ctx) return { ok: false, error: "the space is not open yet" }
      const r = await control(client, ctx, "stop", { name: row.name, graceful }, { expectedTarget: { id: row.id, lifecycleUid: row.lifecycleUid } })
      void readManaged(true)
      return r.ok ? { ok: true } : { ok: false, error: safe(r.error ?? "failed") }
    },
    spawnSetup: async () => {
      if (!target || !ctx) throw new Error("the space is not open yet")
      const space = target.space
      const personas = readPersonaCatalog(target.root)
      const [status, models, policy] = await Promise.all([control(client, ctx, "managerStatus"), control(client, ctx, "models"), refreshRegistrationPolicy(target)])
      if (!status.ok) throw new Error(oneLine(status.error ?? "the space's manager did not answer"))
      const rows = (status.data as { connectors?: ConnectorRow[] } | undefined)?.connectors
      if (!Array.isArray(rows)) throw new Error("the space's manager did not report its applications")
      if (!models.ok || !Array.isArray(models.data)) throw new Error(oneLine(models.error ?? "the space's manager did not list its models"))
      const catalogs = models.data as ConnectorModelCatalog[]
      const byApp = new Map(catalogs.map((c) => [c.agent, (c.models ?? []).map((m) => ({ id: m.id, variants: (m.variants ?? []).map((v) => v.name) }))]))
      return safe({
        dir: target.personaRoot,
        personas: personas.map((p) => ({ name: p.name, ...(p.def ? { def: p.def } : { error: p.error ?? "unknown error" }) })),
        defaultPersona: resolvePreference("persona", { space }).value!,
        applications: applicationsOf(rows, byApp, policy?.events === "required"),
        defaultApplication: resolvePreference("harness", { space }).value!,
      } satisfies SpawnSetup)
    },
    nameError: (name) => spawnNameError(name, { userMode: target?.mode === "user" }),
    spawn: (req) => {
      const since = Date.now()
      const [state, set] = createSignal<SpawnState>({ phase: "launching", label: req.name ? `${req.persona} as ${req.name}` : req.persona, since })
      void launch(req, since).then(
        (r) => (closed ? undefined : "run" in r ? follow({ ...r.run, at: Date.now(), set }, r.waiting) : set(r)),
        (e: Error) => set({ phase: "refused", error: safe(oneLine(e.message)) }),
      )
      return state
    },
    talk,
    close: async () => {
      if (closed) return undefined
      closed = true
      clearInterval(timer)
      clearInterval(followTimer)
      follows.clear()
      setConn({ phase: "closed", space: conn().space })
      const chat = await talk()?.close()
      await view?.stop()
      return chat
    },
  }
}
