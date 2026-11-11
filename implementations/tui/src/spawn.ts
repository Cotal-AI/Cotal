import type { AgentDef } from "@cotal-ai/core"

/** A persona the spawn form can launch: one whose file was read. */
export type Persona = { name: string; def: AgentDef }

/** A model the manager lists for an application, with the efforts (model variants) it offers. */
export type Model = { id: string; variants: readonly string[] }

/** The application an agent runs in, as the space's manager reports it. `events: false` is one with
 *  no event plane, which launches without one. One the manager or the space cannot launch says why. */
export type Application = { id: string; models: readonly Model[]; events?: false } | { id: string; unavailable: string }

/** One connector row of the manager's status. */
export type ConnectorRow = { agent: string; state: string; eventPlane: boolean; reason?: string }

export const FEED_REQUIRED = "this space requires an activity feed"

/** What a launch sends for the event plane. An application with one leaves it unset, so the manager
 *  arms it; sending `true` would refuse a caller without the admin tier. One without an event plane
 *  sends `false`, unless the space's policy requires the plane, which refuses it. */
export function eventsFor(eventPlane: boolean, required: boolean): undefined | false | { refused: string } {
  if (eventPlane) return undefined
  return required ? { refused: FEED_REQUIRED } : false
}

/** The applications the manager reports, each with its models and what it sends for the event plane. */
export function applicationsOf(rows: readonly ConnectorRow[], models: ReadonlyMap<string, readonly Model[]>, required: boolean): Application[] {
  return rows.map((r): Application => {
    if (r.state !== "available") return { id: r.agent, unavailable: r.reason ?? "the space's manager cannot run it" }
    const events = eventsFor(r.eventPlane, required)
    if (typeof events === "object") return { id: r.agent, unavailable: events.refused }
    return { id: r.agent, models: models.get(r.agent) ?? [], ...(events === false ? { events } : {}) }
  })
}

/** What the spawn dialog offers on this space. `defaultApplication` is the caller's saved default,
 *  which a persona's own application overrides. */
export type SpawnSetup = {
  dir: string
  personas: { name: string; def?: AgentDef; error?: string }[]
  defaultPersona: string
  applications: Application[]
  defaultApplication: string
}

export type Row = "prompt" | "app" | "model" | "effort" | "name"
export const ROWS: readonly Row[] = ["prompt", "app", "model", "effort", "name"]

/** The form's state: the persona, the prompt and name as typed, and the choices the operator changed.
 *  Every other value is a default. */
export type Draft = { persona: Persona; prompt: string; name: string; app?: string; model?: string; variant?: string }

/** One launch through the space's manager, as `cotal spawn <persona> --detach` sends it.
 *  `defaultAgent` is the application the form showed as the default, so the manager runs that one. */
export type SpawnRequest = { persona: string; defaultAgent: string; name?: string; harness?: string; model?: string; variant?: string; prompt?: string; events?: false }

/** A draft's effective values, which of them differ from the defaults, and the first value the
 *  manager would refuse, or the request it would accept. A model or effort of `""` leaves it to the
 *  application. Effort is `disabled`, with the reason, when the model offers none to choose. */
export type Resolved = {
  app: Application
  models: readonly string[]
  model: string
  effort: { choices: readonly string[]; value: string } | { disabled: string }
  name: string
  changed: Record<Row, boolean>
} & ({ refused: { row: Row; reason: string } } | { request: SpawnRequest })

const usable = (a: Application): a is Extract<Application, { models: readonly Model[] }> => !("unavailable" in a)

// The manager folds a persona's model into every launch that names none, whatever the application.
export function resolve(setup: SpawnSetup, d: Draft, nameError: (name: string) => string | undefined): Resolved {
  const baseApp = d.persona.def.agent ?? setup.defaultApplication
  const id = d.app ?? baseApp
  const app = setup.applications.find((a) => a.id === id) ?? { id, unavailable: "not installed on the space's manager" }
  const pinned = d.persona.def.model
  const models = [pinned ?? "", ...(usable(app) ? app.models.map((m) => m.id) : []).filter((m) => m !== pinned)]
  const model = d.model ?? models[0]!
  const effort = effortOf(app, model, d.persona.def.variant, d.variant)
  const name = d.name.trim() || d.persona.name
  const prompt = d.prompt.trim()
  const changed = {
    prompt: !!prompt,
    app: app.id !== baseApp,
    model: model !== models[0],
    effort: "choices" in effort && effort.value !== effort.choices[0],
    name: name !== d.persona.name,
  }
  const nameRefused = changed.name ? nameError(name) : undefined
  const base = { app, models, model, effort, name, changed }
  if (!usable(app)) return { ...base, refused: { row: "app", reason: app.unavailable } }
  if (nameRefused) return { ...base, refused: { row: "name", reason: nameRefused } }
  const request: SpawnRequest = {
    persona: d.persona.name,
    defaultAgent: setup.defaultApplication,
    ...(changed.name ? { name } : {}),
    ...(changed.app ? { harness: app.id } : {}),
    ...(changed.model ? { model } : {}),
    ...(changed.effort && "choices" in effort ? { variant: effort.value } : {}),
    ...(prompt ? { prompt } : {}),
    ...(app.events === false ? { events: false as const } : {}),
  }
  return { ...base, request }
}

// The manager applies a persona's variant to every launch that names none, so it is the first choice.
function effortOf(app: Application, model: string, pinned: string | undefined, chosen: string | undefined): Resolved["effort"] {
  const listed = usable(app) ? app.models : []
  const variants = listed.find((m) => m.id === model)?.variants ?? []
  if (!variants.length) {
    const why = !listed.some((m) => m.variants.length) ? `not offered by ${app.id}` : model ? `not offered for ${model}` : "choose a model first"
    return { disabled: pinned ? `${pinned} from the persona, ${why}` : why }
  }
  const choices = [pinned ?? "", ...variants.filter((v) => v !== pinned)]
  return { choices, value: chosen ?? choices[0]! }
}

/** The draft with the next or previous application the manager can run, its model and effort back to the defaults. */
export function cycleApp(setup: SpawnSetup, d: Draft, r: Resolved, by: 1 | -1): Draft {
  const list = setup.applications
  let at = list.findIndex((a) => a.id === r.app.id)
  if (at < 0) at = by > 0 ? -1 : list.length
  for (let step = 1; step <= list.length; step++) {
    const next = list[(((at + by * step) % list.length) + list.length) % list.length]!
    if (usable(next)) return { ...d, app: next.id, model: undefined, variant: undefined }
  }
  return d
}

/** The draft with the next or previous model, its effort back to the default. */
export function cycleModel(d: Draft, r: Resolved, by: 1 | -1): Draft {
  return { ...d, model: r.models[(r.models.indexOf(r.model) + by + r.models.length) % r.models.length], variant: undefined }
}

export function cycleEffort(d: Draft, r: Resolved, by: 1 | -1): Draft {
  if ("disabled" in r.effort) return d
  const { choices, value } = r.effort
  return { ...d, variant: choices[(choices.indexOf(value) + by + choices.length) % choices.length] }
}

/** A spawn from its launch to its outcome. `waiting` follows a run the manager started until this
 *  roster shows it or the manager stops listing it: one the manager reported joined, one waiting
 *  for the operator at `waitingFor`, or one whose process outlived the manager's join window
 *  (`late`). `notice` is what the manager said about the event plane. */
export type SpawnState =
  | { phase: "launching"; label: string; since: number }
  | { phase: "waiting"; name: string; late: boolean; waitingFor?: string; notice?: string; since: number }
  | { phase: "joined"; name: string; id: string; notice?: string }
  | { phase: "exited"; name: string; reason: string }
  | { phase: "refused"; error: string }
