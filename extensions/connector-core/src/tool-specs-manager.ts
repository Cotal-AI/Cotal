/** The tool specs that call the manager, and `cotal_feedback`: spawning and stopping seats, yielding a
 *  run turn, the workflow-run door, and defining and reading personas. `cotalToolSpecs` places
 *  them in the tool set and hides the ones this session's capabilities do not admit. */
import { execFileSync } from "node:child_process";
import { z } from "zod";
import { peerLabel, assertLifecycleToken, isPermissionDenied, renderLifecycleBlocked, LANG_PROBLEM_DETAIL_KIND, parseDuration, type ControlReply, type InlinePersona, type PersonaEndpoint } from "@cotal-ai/core";
import type { AgentConfig } from "./config.js";
import { submitFeedback, type FeedbackInput } from "./feedback.js";
import { ok, err, type CotalToolSpecDecl, type ToolResult } from "./tool-specs-shared.js";

/** Error for a failed privileged control request (spawn / despawn-other / definePersona). A
 *  *permission denial* — this session's creds can't publish to the manager control subject
 *  because its persona lacks `capabilities: [spawn]` — is a different failure with a different
 *  fix than an *absent/unreachable manager*. Report them apart instead of always blaming the
 *  manager (which sent the operator chasing a non-existent "manager down"). */
function controlFailure(action: string, e: unknown): ToolResult {
  const detail = (e as Error)?.message ?? String(e);
  if (isPermissionDenied(e)) {
    return err(
      `${action}: this session isn't allowed to — its persona needs \`capabilities: [spawn]\` ` +
        `(which grants the privileged manager control subject). Add it and respawn so its creds re-mint. [${detail}]`,
    );
  }
  return err(`${action}: no manager reachable (${detail}). Is the manager running?`);
}

/** A `run-*` refusal for the model: the manager's sentence, plus every validation problem it
 *  carried (the language's own records: code, title, where, cause, fix) so the program can be
 *  fixed in one round. */
function renderRunRefusal(verb: string, reply: ControlReply): string {
  const problems = (reply.details ?? []).filter((d) => d.kind === LANG_PROBLEM_DETAIL_KIND);
  const head = `cotal_run ${verb}: ${reply.error ?? "the manager refused"}`;
  if (problems.length === 0) return head;
  const lines = problems.map((d) => {
    const where = d.where as { file?: string; line?: number; column?: number } | undefined;
    const at = where ? `${where.file ?? "<program>"}:${where.line ?? "?"}:${where.column ?? "?"}` : "<program>";
    return `  ${String(d.code ?? "L????")} ${String(d.title ?? "")} (${at})\n    ${String(d.cause ?? "")}\n    fix: ${String(d.fix ?? "")}`;
  });
  return [head, ...lines].join("\n");
}

/** Like {@link controlFailure}, naming the `run` capability rather than `spawn`. */
function runFailure(action: string, e: unknown): ToolResult {
  const detail = (e as Error)?.message ?? String(e);
  if (isPermissionDenied(e)) {
    return err(
      `${action}: this session isn't allowed to — its persona needs \`capabilities: [run]\` ` +
        `(which grants the manager's run-* commands). Add it and respawn so its creds re-mint. [${detail}]`,
    );
  }
  return err(`${action}: no manager reachable (${detail}). Is the manager running?`);
}

/** The manager-instance pin of the manager read and run tools: the same token `cotal_spawn`'s
 *  `instance` takes. */
const managerInstanceArg = z
  .string()
  .refine((value) => {
    try { assertLifecycleToken(value, "instance"); return true; }
    catch { return false; }
  }, "instance must be a lifecycle token ([a-z0-9]{26,32})")
  .optional()
  .describe("Optional manager instance id for a multi-manager space. When omitted, a seat a manager launched uses that manager and any other caller lets the mesh select one; on a user-auth mesh with several of your managers live, that selection refuses and lists their ids. A pin that cannot be resolved is refused without falling back to another manager.");

/** Contact email for keyless feedback: explicit arg → COTAL_FEEDBACK_EMAIL → git config. */
function resolveFeedbackEmail(explicit: string | undefined, env?: NodeJS.ProcessEnv): string | undefined {
  if (explicit?.trim()) return explicit.trim();
  const lookupEnv = env ?? process.env;
  if (lookupEnv.COTAL_FEEDBACK_EMAIL?.trim()) return lookupEnv.COTAL_FEEDBACK_EMAIL.trim();
  // A hosted session must not discover a contact in the host repository.
  const args = env === undefined ? ["config", "user.email"] : ["config", "--global", "--includes", "user.email"];
  try {
    const email = execFileSync("git", args, { encoding: "utf8", env, windowsHide: true }).trim();
    return email || undefined;
  } catch {
    return undefined;
  }
}

/** The name a spawn result shows. A missing or whitespace-only name is the seat's id. */
export function shownSpawnName(name: string, id: string | undefined, role?: string): string {
  if (name.trim()) return peerLabel({ name, role });
  const ident = id !== undefined && id.trim() ? id : "(unnamed)";
  return role !== undefined && role.trim() ? peerLabel({ name: ident, role }) : ident;
}

/** The `cotal_spawn` line for a seat the manager reports started: who it is, where it is and the next
 *  move. It names only the `join` channels the caller passed. The reply carries no channel list, and
 *  a persona the caller does not own may list channels the caller cannot read, so without `join` it
 *  says the seat has only what its persona lists. A rename leads, so the caller addresses the seat it
 *  got. A seat waiting at an operator screen has not joined the mesh yet, and the line says so. A once
 *  seat is stopped by its manager, so it is not told to despawn it. */
export function spawnResult(s: {
  requested: string; started: string; renamed: boolean; mode?: string; model?: string;
  join?: readonly string[]; waitingFor?: string; once: boolean;
}): string {
  const lead = s.renamed ? `Started ${s.started} ("${s.requested}" was taken)` : `Started ${s.started}`;
  const facts = [s.mode, s.model ? `recorded model ${JSON.stringify(s.model)}` : undefined].filter(Boolean);
  const about = facts.length ? ` (${facts.join(", ")})` : "";
  const on = s.join?.length ? s.join.map((c) => `#${c}`).join(", ") : undefined;
  const persona = "it starts only on the channels its persona lists, which may be none";
  if (s.waitingFor !== undefined)
    return `${lead}${about}, but it is waiting for the operator at ${s.waitingFor} and joins the mesh after that. ` +
      (on ? `It starts on ${on}.` : `Without join, ${persona}.`);
  if (!on) return `${lead}${about} without join, so ${persona}. Pass join to put it on the task's channel.`;
  return `${lead} on ${on}${about}. Post the brief there, and mention it only when it must act.${s.once ? "" : " Despawn it when its job is done."}`;
}

/** The specs of `cotal_spawn`, `cotal_feedback`, `cotal_despawn`, `cotal_yield`, `cotal_run`, `cotal_persona`
 *  and `cotal_personas`, in that order. The parameters are `cotalToolSpecs`'s parameters of the same names. */
export function managerToolSpecs(config: AgentConfig, source: string, env?: NodeJS.ProcessEnv): CotalToolSpecDecl[] {
  return [
    {
      name: "cotal_spawn",
      title: "Cotal: spawn a new teammate",
      description:
        "Start another agent on the mesh to do a job. It runs as its own process: it shows up on the roster, the user can watch it work, and any agent can message it. " +
        "A subagent that your own harness starts, such as Claude Code's Task tool, runs inside your session, where nobody else can see or reach it. Prefer cotal_spawn. Use a subagent only for a self-contained job nobody else needs to follow, where it keeps the work contained and can be more efficient, depending on the harness. " +
        "Usually you write the new agent's persona here: pass persona, whose prompt says who it is, and a name. The top-level prompt is the first message it works on, so say there what to do. If others could use its work, put it on the task's channel with join and say in the prompt where the brief is. " +
        "To start a saved persona instead, pass its name and no persona; cotal_personas lists them. Pass persona.save: true, or use cotal_persona, only for a persona worth reusing. " +
        'Example: `{name: "reviewer", join: ["review.login-page"], persona: {prompt: "You review the login page change and report each finding with its file and line.", allowSubscribe: ["review.login-page"], allowPublish: ["review.login-page"]}, prompt: "Read the brief on #review.login-page, post your findings there, then despawn yourself."}` ' +
        "The new agent can read and post wherever its persona allows. A persona you pass here, or an operator's persona, that names no channels gets your read and post grants and no more; one you save with cotal_persona gets only the channels it lists. Give a helper only the channels its job needs. " +
        "On a mesh that checks grants, a spawn that asks for more than you hold is refused. It gets one of your capabilities only if its persona lists it in capabilities. To let it call an endpoint command you can call, list it in persona.endpoints, such as [{endpoint: \"com.example.orders\", commands: [\"list\"]}]. A per-user auth mesh refuses endpoints in a persona, because the operator grants endpoint access there, so ask the user if the job needs it. cotal_orientation shows what you hold, and cotal_endpoints the endpoint commands you can call. " +
        "For a single job, pass once: true with the prompt, and the helper is stopped when it ends that turn; or tell it in the prompt to despawn itself when done, as in the example. A standing teammate keeps running until it despawns itself or you call cotal_despawn. " +
        "For work with several steps, a wait on a person, or a need to survive restarts, use cotal_run.",
      schema: {
        name: z.string().describe("With `persona`, the new helper's name (auto-numbered with an underscore, e.g. reviewer_2, if that's taken). Without it, which catalog persona to spawn: the persona FILENAME in .cotal/agents (e.g. `review-critic`), without the .md; the peer joins under the persona's own `name:`, and an unknown name fails."),
        persona: z
          .object({
            prompt: z.string().min(1).describe("Who the helper is: its persona body, as a persona file's body would be. Its first message is the top-level `prompt`."),
            role: z.string().min(1).optional().describe("The helper's role (e.g. reviewer). The top-level `role` wins."),
            model: z.string().min(1).optional().describe("The helper's model. The top-level `model` wins. The spawn fails if the manager does not record this pin."),
            variant: z.string().min(1).optional().describe("The helper's model variant. The top-level `variant` wins."),
            description: z.string().min(1).optional().describe("A one-line description, shown in the catalog when the persona is saved."),
            subscribe: z.array(z.string()).optional().describe("Channels the helper reads at start. Omit every channel field to take your own read and post grants; pass [] for none."),
            allowSubscribe: z.array(z.string()).optional().describe("Channels the helper may read. Each must be one you may read."),
            allowPublish: z.array(z.string()).optional().describe("Channels the helper may post to. Each must be one you may post to."),
            capabilities: z.array(z.string()).optional().describe("Capabilities to hand on, such as spawn, run or artifacts. Each must be one you hold."),
            endpoints: z.array(z.object({ endpoint: z.string(), commands: z.array(z.string()).min(1), instanceId: z.string().optional() }).strict()).optional().describe("Endpoint commands to hand on, as { endpoint, commands } entries such as { endpoint: \"com.example.orders\", commands: [\"list\"] }. Each must be one you hold. Add instanceId to hand on a command you hold on one instance of the endpoint."),
            save: z.boolean().optional().describe("Also save this persona to the catalog under `name`, for a broad persona worth reusing. A name already in the catalog is refused before anything starts."),
          })
          .strict()
          .optional()
          .describe("Define the helper on this spawn instead of from a catalog file: `prompt` (who it is), with optional `role`, `model`, `variant`, `description`, `subscribe`, `allowSubscribe`, `allowPublish`, `capabilities`, `endpoints` and `save`. Not saved unless `save` is true."),
        join: z
          .array(z.string())
          .optional()
          .describe("Channels the new peer joins at start, on top of what its persona file lists (e.g. ['general']). Concrete names only, each within YOUR read ACL (a spawn hands on only what you may read yourself; anything else is refused before launch). Omitted, a persona that lists no channel starts on none and its cotal_send with no channel is refused."),
        instance: z
          .string()
          .refine((value) => {
            try { assertLifecycleToken(value, "instance"); return true; }
            catch { return false; }
          }, "instance must be a lifecycle token ([a-z0-9]{26,32})")
          .optional()
          .describe("Optional manager instance id for a multi-manager space. An open managed seat defaults to its launching manager; an unbound open or static caller uses class anycast. User-auth selection remains issuer-bound. A pin that cannot be resolved is refused without falling back to another manager."),
        role: z
          .string()
          .optional()
          .describe(
            "Optional role for the new peer (e.g. worker, reviewer); overrides the persona's role. A role of `manager` requires the helper to hold `spawn`, from `persona.capabilities` or its catalog file: a seat that presents as a manager but cannot spawn is refused at spawn time. You can hand on `spawn` only if you hold it.",
          ),
        agent: z
          .string()
          .optional()
          .describe("Optional harness the new peer runs on: the agent/connector type (claude, jcode, opencode, hermes), NOT the persona to spawn (that's `name`). Resolution order: this explicit agent > the persona's agent: pin > the caller's COTAL_DEFAULT_AGENT > the manager's COTAL_DEFAULT_AGENT > the product default (Claude)."),
        model: z
          .string()
          .min(1)
          .optional()
          .describe("Optional model override (e.g. opus, sonnet); it wins over the persona file's model:. The spawn fails if the manager does not record this pin. The result names the recorded model; do not treat a spawn as cross-vendor unless that name matches what you requested. If the pin cannot be read back, the result is partial and the seat still runs."),
        variant: z
          .string()
          .optional()
          .describe("Optional model variant override (connector-defined; for OpenCode, a model variant such as high/max/low)."),
        launchOptions: z
          .record(z.string(), z.unknown())
          .optional()
          .describe("Optional connector-specific launch options: an opaque key→value map the chosen connector forwards raw to its own host form (claude CLI flags, OpenCode agent config); a connector with no option surface (Hermes) rejects any, and malformed keys are refused."),
        cwd: z
          .string()
          .optional()
          .describe(
            "Optional working directory to root the new peer at (e.g. a different repo). A relative path resolves against the manager's workspace; omitted → it shares the manager's workspace. A directory that does not exist on the serving manager's host is refused before launch, with the host named; in a multi-manager space pin the manager with instance.",
          ),
        prompt: z
          .string()
          .min(1)
          .optional()
          .describe(
            "Optional kickoff message auto-submitted as the new peer's first turn. Pass it when the peer should begin work immediately; omitted means no first model turn is submitted.",
          ),
        events: z
          .boolean()
          .optional()
          .describe("Event planes are on by default for connectors that publish one. Pass false to opt out; true only restates the default."),
        once: z
          .boolean()
          .optional()
          .describe("Run `prompt` as the new peer's one task, then stop the peer. The task reaches the peer as a relayed turn rather than a kickoff, and the peer is stopped when it ends that turn or when the deadline passes. The turn names who started the seat by id when that name is missing or only whitespace. Needs `prompt`. A Claude Code peer takes the task only when its startup shows channels on; otherwise the spawn fails at startup and says why."),
        deadline: z
          .string()
          .optional()
          .describe("With once: how long the task may run, as a duration such as 30m, 2h or 1d, counted from when the manager accepts the spawn. Omitted, it is 1h. Pass -1 for no deadline: the peer then keeps its name and its seat slot until it ends its turn or is despawned."),
        runtime: z
          .string()
          .trim()
          .min(1)
          .optional()
          .describe("Optional terminal runtime for this one seat (pty, or an installed extension such as tmux). Omitted, the serving manager uses its own. An unknown or unreachable runtime, and auto, refuse the launch and start nothing."),
        // NOTE: session `resume` is deliberately NOT exposed here. Forking a host-local `~/.claude`
        // transcript is an operator-local intent; letting a spawn-capable mesh PEER name a host
        // session id would expand `spawn` into host-transcript disclosure with no broker-enforced
        // boundary. Resume lives only on the operator CLI (`cotal spawn --resume`, foreground or
        // --detach); a peer-facing, capability-gated resume is deferred (see #159).
      },
      async run(agent, _config, { name, persona, instance, role, agent: agentType, model, variant, launchOptions, cwd, prompt, events, once, deadline, runtime, join }: { name: string; persona?: InlinePersona; instance?: string; role?: string; agent?: string; model?: string; variant?: string; launchOptions?: Record<string, unknown>; cwd?: string; prompt?: string; events?: boolean; once?: boolean; deadline?: string; runtime?: string; join?: string[] }) {
        let onceArg: { deadlineMs?: number } | undefined;
        if (deadline !== undefined && once !== true) return err("`deadline` applies only to a once spawn; pass once: true with it.");
        if (once === true) {
          if (deadline === undefined) onceArg = {};
          else if (deadline.trim() === "-1") onceArg = { deadlineMs: -1 };
          else {
            let ms: number;
            try { ms = parseDuration(deadline); }
            catch (e) { return err(`deadline: ${(e as Error).message}, or -1 for no deadline`); }
            if (!Number.isSafeInteger(ms) || ms < 1) return err(`deadline: "${deadline}" is not a positive duration; pass one such as 30m, or -1 for no deadline`);
            onceArg = { deadlineMs: ms };
          }
        }
        try {
          const reply = await agent.spawn(name, role, { agent: agentType, model, variant, launchOptions, cwd, prompt, events, runtime, instance, join, persona, ...(onceArg !== undefined ? { once: onceArg } : {}) });
          // An uncertain launch is still managed and may yet join. Reported as an error it reads as a
          // failed launch, and the caller's retry starts a second agent on the same work.
          const pending = reply.code === "uncertain";
          const accepted = reply.data as { goalId?: string; submissionUnknown?: boolean } | undefined;
          if (!reply.ok && !pending && reply.outcome === "unknown" && accepted?.goalId && !accepted.submissionUnknown) {
            const goalId = accepted.goalId;
            const message = `Spawn for ${name} was accepted as goal "${goalId}", but its outcome is not known yet. It may still be starting or may already have succeeded. An identical retry in this session returns the same goal instead of submitting another spawn. Inspect 'ps'/'inspect' or read manager goal-result for this goal as the same caller.`;
            return { text: message, structured: { status: "unknown", name, goalId, manager: reply.instanceId, message } };
          }
          const submission = reply.data as { goalId?: string; submissionUnknown?: boolean } | undefined;
          if (!reply.ok && submission?.submissionUnknown && submission.goalId) {
            const goalId = submission.goalId;
            const next = `cotal_invoke(endpoint="manager", command="goal-result", args={"goalId":${JSON.stringify(goalId)}})`;
            const message = `Spawn submission for ${name} has an unknown outcome for goal "${goalId}". Acceptance has not been confirmed; the seat may appear later. Do NOT retry: another submission could create a second lifecycle. ${reply.error ?? "The submission wait ended."} Next: ${next} as this same caller, or inspect 'ps'/'inspect'. A missing result does not prove the submission failed.`;
            return { text: message, structured: { status: "unknown", name, goalId, next, message } };
          }
          if (!reply.ok && !pending) return err(`Couldn't spawn ${name}: ${renderLifecycleBlocked(reply.error ?? "manager refused", reply)}`);
          const d = reply.data as {
            name?: string; goalId?: string; mode?: string; model?: string; id?: string; actor?: string; executor?: { lifecycleUid: string };
            pinAudit?: { requested: string; error: string; unreported?: true };
            once?: { goalId: string; deadlineAt?: number }; waitingFor?: string; startupNotice?: string;
          } | undefined;
          const actual = d?.name ?? name; // the manager auto-numbers on a collision — report what it spawned
          const mode = d?.mode;
          const seatId = typeof d?.id === "string" ? d.id : d?.actor;
          const who = shownSpawnName(actual, seatId, role);
          // Make the rename unmissable: a colliding caller must see it asked for `name` but got
          // `actual`, not silently address the wrong peer later (the tool result is the only channel).
          const lead = actual !== name ? `"${name}" was taken — spawning ${who} instead` : `Spawning ${who}`;
          const pin = d?.model ? ` recorded model ${JSON.stringify(d.model)}` : "";
          // The seat launched and only its pin read failed: a partial outcome naming the seat, so the
          // caller knows it is running instead of spawning a second seat.
          if (d?.pinAudit) {
            const { requested, error: auditError, unreported } = d.pinAudit;
            const id = d.id ?? d.actor;
            const manager = d.executor?.lifecycleUid ?? reply.instanceId;
            const state = pending ? "it has not joined the mesh within its readiness window and may still be booting" : "it joined the mesh";
            const audit = unreported ? "was not reported by this manager" : "could not be audited";
            const error = pinAuditResultError(auditError);
            const message = `${lead} (id ${id}, manager ${manager}${mode ? `, runtime ${mode}` : ""})${d.goalId ? `, accepted goal "${d.goalId}"` : ""}: ${state}, but its model pin ${JSON.stringify(requested)} ${audit} (${error}). ` +
              (pending ? "An identical retry in this session while it is starting returns the same goal. To check on it, inspect it with cotal_invoke on the manager endpoint rather than spawning with different options." : "It is running, so spawning it again would start a second agent. To check which model it runs, inspect it with cotal_invoke on the manager endpoint.");
            return {
              text: message,
              structured: {
                status: "partial", name: actual, id, manager, goalId: d.goalId, ...(mode ? { runtime: mode } : {}), joined: !pending,
                model: { requested, audited: false, reported: !unreported, error }, message,
              },
            };
          }
          if (pending) {
            const goalId = d?.goalId;
            const message = `${lead}${pin} (id ${d?.actor}, manager ${d?.executor?.lifecycleUid}): accepted${goalId ? ` as goal "${goalId}"` : ""}, but its readiness outcome is not known yet. It may still be starting. An identical retry by this caller while it is starting returns this same goal, not another seat. Watch cotal_roster for ${shownSpawnName(actual, seatId)} or inspect it before deciding what to do.`;
            return { text: message, structured: { status: "starting", name: actual, goalId, id: seatId, manager: reply.instanceId, message } };
          }
          // A once spawn names its task, so the spawner can read how it ended.
          const task = d?.once
            ? ` Its task is goal ${JSON.stringify(d.once.goalId)}, ${d.once.deadlineAt !== undefined ? `with a deadline of ${new Date(d.once.deadlineAt).toISOString()}` : "with no deadline"}; it is stopped when the task ends. Read the outcome with cotal_invoke(endpoint="manager", command="goal-result", args={"goalId":${JSON.stringify(d.once.goalId)}}).`
            : "";
          // The manager's word that nothing wakes the seat while idle: a DM to it waits for a turn
          // somebody else starts, so the spawner must not hand it work and go idle waiting.
          const wake = d?.startupNotice ? ` It joined, but ${d.startupNotice}. A message to it waits until someone starts its next turn.` : "";
          return ok(spawnResult({ requested: name, started: who, renamed: actual !== name, mode, model: d?.model, join, waitingFor: d?.waitingFor, once: d?.once !== undefined }) + task + wake);
        } catch (e) {
          return controlFailure(`Couldn't spawn ${name}`, e);
        }
      },
    },
    {
      name: "cotal_feedback",
      title: "Cotal: send beta feedback",
      description:
        "Send feedback about Cotal to its developers. With a configured feedback key it goes to the keyed beta intake; without one it goes to the public cotal.ai intake, which requires a contact email.",
      schema: {
        origin: z
          .enum(["human", "agent"])
          .describe('"human" when relaying the user\'s feedback, "agent" when reporting an issue you hit yourself.'),
        type: z.enum(["bug", "idea", "friction", "praise", "other"]).describe("What kind of feedback this is."),
        summary: z.string().max(300).describe("Required one-line summary, max 300 characters."),
        details: z.string().max(10_000).optional().describe("Longer free-form details. Do not include secrets."),
        severity: z.enum(["low", "medium", "high"]).optional().describe("How badly this hurts (bugs/friction)."),
        area: z.string().max(120).optional().describe("The part of Cotal this concerns (e.g. presence, channels, CLI)."),
        repro: z.string().max(10_000).optional().describe("Steps to reproduce."),
        expected: z.string().max(5_000).optional().describe("What you expected to happen."),
        actual: z.string().max(5_000).optional().describe("What actually happened."),
        diagnostics: z
          .string()
          .max(10_000)
          .optional()
          .describe("Relevant diagnostics as text (logs, errors). Never include secrets."),
        email: z
          .string()
          .optional()
          .describe("Contact email, required on the keyless public path when none is configured in the environment."),
      },
      async run(_agent, _config, args: Record<string, unknown>) {
        const { email, ...payload } = args;
        const contact = config.feedbackKey ? undefined : resolveFeedbackEmail(email as string | undefined, env);
        return submitFeedback(
          { ...payload, source } as unknown as FeedbackInput,
          { key: config.feedbackKey, url: config.feedbackUrl, email: contact },
        );
      },
    },
    {
      name: "cotal_despawn",
      title: "Cotal: stop a teammate",
      description:
        "Stop a helper when its job is done, or stop yourself by leaving out name. The manager that started you then ends your process. This works only for an agent a manager started; a session someone connected by hand is refused. Graceful by default; pass graceful: false only for a hung agent.",
      schema: {
        name: z
          .string()
          .optional()
          .describe("Name of the peer to stop. Omit to stop yourself (self-despawn)."),
        instance: z
          .string()
          .refine((value) => {
            try { assertLifecycleToken(value, "instance"); return true; }
            catch { return false; }
          }, "instance must be a lifecycle token ([a-z0-9]{26,32})")
          .optional()
          .describe("Optional manager instance id for the named peer. Requires `name`. Omitted keeps this session's existing manager selection. A managed user-auth seat must use its own manager. An unresolved pin is refused without fallback."),
        graceful: z
          .boolean()
          .optional()
          .describe("Default true: let the session exit cleanly. false = hard kill."),
      },
      async run(agent, _config, { name, instance, graceful }: { name?: string; instance?: string; graceful?: boolean }) {
        try {
          const reply = await agent.despawn(name, { graceful, instance });
          if (!reply.ok) {
            return err(`Couldn't despawn ${name ?? "self"}: ${reply.error ?? "manager refused"}`);
          }
          const who = name ?? "self";
          return ok(`Stopping ${who}${graceful === false ? " (hard)" : ""} — it will leave the roster shortly.`);
        } catch (e) {
          return controlFailure(`Couldn't despawn ${name ?? "self"}`, e);
        }
      },
    },
    {
      name: "cotal_yield",
      title: "Cotal: yield a run turn",
      description:
        "Report the outcome of a workflow turn assigned to you. Use this only when your context contains a pending run turn; it does not start a workflow or resolve a checkpoint/ask.\n\nUsually finish your session turn normally: that yields `done` automatically. If you cannot progress, call `{\"status\":\"blocked\",\"note\":\"<what prevents progress>\"}`. To hand the assigned turn to another agent, call `{\"status\":\"handoff\",\"to\":\"<agent-name>\",\"note\":\"<handoff context>\"}`.\n\nWhen you hold several assigned turns, pass `turn` with the exact goal id from the relevant run-turn context block. Without `turn`, the oldest turn already shown to your session is selected. A turn that has not been shown cannot be yielded, and neither can one the run already settled, such as a turn whose deadline elapsed: that refusal names the turn and its deadline. A turn already yielded, including by the automatic `done` when your session turn ended, is refused the same way, and the refusal says how it was yielded. A successful reply confirms the turn was yielded, not that the whole workflow completed; the run's coordinator can inspect progress with `cotal_run` status.",
      schema: {
        status: z
          .enum(["done", "blocked", "handoff"])
          .describe("done = finished (usually implicit: just end your turn instead); blocked = can't proceed; handoff = another agent should take it."),
        to: z.string().optional().describe("Required for handoff: the agent name the assigned turn should pass to."),
        note: z.string().max(4096).optional().describe("Short free-text for the run: what blocked you, or what the next agent should know."),
        turn: z.string().optional().describe("The turn's goal id, from the 🎯 block. Omit when you hold only one."),
      },
      async run(agent, _config, { status, to, note, turn }: { status: "done" | "blocked" | "handoff"; to?: string; note?: string; turn?: string }) {
        try {
          const reply = await agent.yieldTurn(status, { to, note, turn });
          if (!reply.ok) return err(`Couldn't yield: ${reply.error ?? "manager refused"}`);
          return ok(`Turn yielded (${status}${to ? ` → ${to}` : ""}) — the run continues.`);
        } catch (e) {
          return err(`Couldn't yield: ${(e as Error).message}`);
        }
      },
    },
    {
      name: "cotal_run",
      title: "Cotal: run a workflow program",
      description:
        "Use for coordination with several steps, waits on a person, or work that must survive restarts. For one job done by one helper, use cotal_spawn. Use Cotal Lang to program multi-step coordination between agents: sequence work, run tasks in parallel, branch on results, wait for events, and request human decisions. Agents own their reasoning and conversations; the workflow specifies when they act and which outcomes determine the next step.\n\nBefore writing a program, read cotal_docs pages `workflows` and `lang-card`. Hosted execution requires a running execution-capable manager, the `run` capability, and issued caller authority. A managed agent on a user-auth mesh uses its own bearer command and selected participant manager; both its current grant and its direct parent's current grant must allow `run`. Open meshes, unsupported local user-mode hosts and execution-free control managers refuse hosted runs. `@cotal-ai/lang` provides validation and simulation separately; those are not verbs of this tool.\n\nSTART: pass `verb: \"start\"` and the program text in `source`. Example: `{\"verb\":\"start\",\"source\":\"await sleep(\\\"1s\\\", { name: \\\"first-run\\\" });\"}`. Optional `file` labels diagnostics only; it reads nothing from disk. The manager validates before recording the run and returns a runId. Acceptance is not completion.\n\nINSPECT: use `verb: \"status\"` with that `runId` for state and step journal, or `verb: \"ps\"` to list runs. Both are read-only. Report completion only after observing state `completed`; surface failures or unresolved steps.\n\nANSWER: first inspect status, then pass `verb: \"answer\"`, `runId`, the exact open `stepKey`, and, when requested, `value` matching the answer shape. An ask requires its requested record; a checkpoint can resolve without a value. `artifact` may name the evidence reviewed. Answer only with authority to make that decision; never invent an approval.\n\nRESUME: pass `verb: \"resume\"` and `runId` to continue a run from its recorded source. A held run appears as `released` in status. Do not start a duplicate run to continue it or resume one the manager is already driving.\n\nRuns continue independently of your session and can recover after a manager restart. Their channel effects are bounded by the starting credential's issued channel scope. To report that your assigned agent turn is blocked or handed off, use `cotal_yield` instead. Pass `instance` for the exact manager when an unbound user-auth caller has several managers; a failed pin does not fall back.",
      schema: {
        verb: z.enum(["start", "status", "ps", "answer", "resume"]).describe("start = validate and drive a new program; status = one run's record + journal; ps = list runs; answer = resolve an open checkpoint/ask; resume = take a released or held run over."),
        source: z.string().min(1).optional().describe("start only: the cotal-lang program source, inline. Required for start."),
        file: z.string().min(1).optional().describe("start only: a file name to attribute the source to in error messages. Diagnostic only; nothing is read from disk."),
        timeout: z.string().min(1).optional().describe("start/resume: the default checkpoint timeout for the drive, as a duration (e.g. `1h`, `30m`). Default 1h."),
        runId: z.string().min(1).optional().describe("Required for status, answer and resume: the run id (`run-<32 hex>`) returned by start or ps."),
        stepKey: z.string().min(1).optional().describe("Required for answer: copy the exact open step key from status, e.g. `/checkpoint:approve#0`."),
        value: z.unknown().optional().describe("answer only: supply the value requested by the open checkpoint or ask and match its answer shape. A checkpoint may resolve without a value; an ask must receive its requested record. Use null only when that is the intended answer."),
        artifact: z.string().min(1).optional().describe("answer only: a reference to what you reviewed before answering, recorded beside the answer."),
        endpoint: z.string().min(1).optional().describe("status/ps/answer: the endpoint the run record lives under. Omit for runs the manager hosts."),
        page: z.strictObject({
          limit: z.number().int().min(1).max(16).optional(),
          cursor: z.string().min(1).max(3072).regex(/^[A-Za-z0-9_-]+$/).optional(),
        }).optional().describe("ps only: one bounded diagnostic JSON page, default 8 rows. Pin the manager with instance unless this session is already bound. Continuation is not snapshot, absence or ownership proof. A manager from release 0.88.0 or earlier refuses `page`."),
        instance: managerInstanceArg,
      },
      async run(
        agent,
        config,
        a: { verb: "start" | "status" | "ps" | "answer" | "resume"; source?: string; file?: string; timeout?: string; runId?: string; stepKey?: string; value?: unknown; artifact?: string; endpoint?: string; page?: { limit?: number; cursor?: string }; instance?: string },
      ) {
        const need = (field: keyof typeof a, verb: string): ToolResult | undefined =>
          a[field] === undefined ? err(`cotal_run ${verb}: \`${String(field)}\` is required`) : undefined;
        try {
          if (a.page !== undefined && a.verb !== "ps") return err("cotal_run: page is supported only for ps");
          if (a.page !== undefined && a.instance === undefined && config.managerInstanceId === undefined)
            return err("cotal_run ps: diagnostic pages require an explicit instance or a bound manager");
          if (a.verb === "start") {
            const missing = need("source", "start");
            if (missing) return missing;
            const reply = await agent.run("start", { source: a.source, file: a.file, timeout: a.timeout }, a.instance);
            if (!reply.ok) return err(renderRunRefusal("start", reply));
            const { runId } = reply.data as { runId: string };
            return ok(`Started run ${runId} on the manager. It runs there until it completes or is held; cotal_run(verb="status", runId="${runId}"${a.instance ? `, instance="${a.instance}"` : ""}) follows its steps, and an open checkpoint is answered with verb="answer"${a.instance ? ` on instance="${a.instance}"` : ""}.`);
          }
          if (a.verb === "resume") {
            const missing = need("runId", "resume");
            if (missing) return missing;
            const reply = await agent.run("resume", { runId: a.runId, timeout: a.timeout }, a.instance);
            if (!reply.ok) return err(renderRunRefusal("resume", reply));
            return ok(`Resumed run ${a.runId} on the manager from its recorded program.${a.instance ? ` Use instance="${a.instance}" for subsequent status and answer calls to this manager.` : ""}`);
          }
          if (a.verb === "ps") {
            const reply = await agent.run("ps", { endpoint: a.endpoint, ...(a.page !== undefined ? { page: a.page } : {}) }, a.instance);
            if (!reply.ok) return err(renderRunRefusal("ps", reply));
            if (a.page !== undefined) {
              const page = reply.data as { semantics?: unknown; nextCursor?: unknown } | null;
              if (page === null || typeof page !== "object" || Array.isArray(page) || page.semantics !== "diagnostic")
                return err("the manager did not return a diagnostic inventory page");
              const text = JSON.stringify(page);
              if (a.page.cursor !== undefined && page.nextCursor === a.page.cursor)
                return err(`Diagnostic inventory made no progress; retain this incomplete observation, do not retry in a loop: ${text}`);
              return ok(text);
            }
            const rows = reply.data as Array<{ runId: string; endpoint: string; state?: string; holder?: string; journalHigh?: number; forkedFrom?: { run: string; step: string } }>;
            if (rows.length === 0) return ok("No workflow runs are recorded in this space.");
            return ok(rows.map((r) => `${r.runId}  ${r.endpoint}  ${r.state ?? "(no status)"}  holder=${r.holder ?? "-"}  journal=${r.journalHigh ?? "-"}${r.forkedFrom ? `  forked-from=${r.forkedFrom.run}@${r.forkedFrom.step}` : ""}`).join("\n"));
          }
          if (a.verb === "status") {
            const missing = need("runId", "status");
            if (missing) return missing;
            const reply = await agent.run("status", { runId: a.runId, endpoint: a.endpoint }, a.instance);
            if (!reply.ok) return err(renderRunRefusal("status", reply));
            const v = reply.data as { runId: string; endpoint: string; status?: { state: string; holder: string; epoch: number }; journal: Array<{ n: number; kind: string; holder?: string; epoch?: number; replayedTo?: number; step?: string; outcome?: string; asks?: string; addressee?: string }> };
            const head = `run ${v.runId} on ${v.endpoint}: ${v.status ? `${v.status.state}, holder ${v.status.holder}, epoch ${v.status.epoch}` : "(no status)"}`;
            const lines = v.journal.map((r) => r.kind === "activation"
              ? `#${r.n}  activation  holder=${r.holder} epoch=${r.epoch} replayedTo=${r.replayedTo}`
              : `#${r.n}  step  ${r.step}  ${r.outcome}${r.asks !== undefined ? `\n      asks: ${r.asks}${r.addressee !== undefined ? ` (escalates to ${r.addressee})` : ""}` : ""}`);
            return ok([head, ...(lines.length ? lines : ["(no journal records: never started, or retired)"])].join("\n"));
          }
          const missing = need("runId", "answer") ?? need("stepKey", "answer");
          if (missing) return missing;
          // The manager records the answerer from the caller's own credential (SPEC 14.5); the
          // tool sends no name, so it cannot answer as anyone else.
          const reply = await agent.run("answer", { runId: a.runId, stepKey: a.stepKey, value: a.value, artifact: a.artifact, endpoint: a.endpoint }, a.instance);
          if (!reply.ok) return err(renderRunRefusal("answer", reply));
          return ok(`Answered ${a.stepKey} on run ${a.runId} as ${config.name}: ${JSON.stringify(reply.data)}`);
        } catch (e) {
          return runFailure(`cotal_run ${a.verb}`, e);
        }
      },
    },
    {
      name: "cotal_persona",
      title: "Cotal: define a persona",
      description:
        "Save a persona that cotal_spawn can start by name. Most jobs need a persona written for them. For one job, pass persona to cotal_spawn instead, and save one here only when it is worth reusing. Reuse one from cotal_personas only when it really fits, such as a general reviewer. Every persona you save stays in the user's workspace after the helper stops. No cotal_* tool removes one: remove one you own with cotal_invoke, endpoint `manager`, command `remove-persona`, args `{ name }`; the operator removes any with `cotal persona remove <name>`. " +
        "Name it after what it does, such as review-login-page. Write the prompt about the job: what to do, where the brief is, how to report, and when to stop. Point to sources for facts rather than stating them. Set role when others should reach it through a role. " +
        "List its channels and give it only what the job needs: subscribe for where it starts, allowSubscribe for what it may read, and allowPublish for what it may post to. A wildcard works in all three. For example, review.> covers every channel under review, including ones opened later, and review.* covers one level. If you list subscribe alone, it may read just those channels and can't post anywhere. Leave all three out and it can read and post nowhere, so list the channels it needs. A persona you pass to cotal_spawn differs here: with no channel field it takes your own read and post grants. " +
        "To give its agent one of your capabilities, list it in capabilities. cotal_orientation shows the ones you hold. To let it call an endpoint command, list it in endpoints, a per-user auth mesh excepted. You can give only channels, capabilities and endpoint commands you hold, and each later spawn of the persona is checked again against its spawner. A wire save does not keep launch options. Only you or an operator can change a persona you saved.\n\n" +
        "Before you write one, check what you can give. cotal_orientation shows your own channels and capabilities, and cotal_channels lists the channels in the space. cotal_endpoints lists the endpoints you can call, and cotal_describe shows what one lets a caller do. The agent-files page in cotal_docs lists every persona field.\n\n" +
        "Example:\n\n" +
        "```\n" +
        "{\n" +
        '  name: "review-login-page",\n' +
        '  role: "reviewer",\n' +
        '  subscribe: ["review.login-page"],\n' +
        '  allowPublish: ["review.login-page"],\n' +
        '  prompt: "You review the login page change in PR 812. The brief is on #review.login-page. Check the session timeout and the error messages against docs/auth.md. Post each finding there with its file and line. When you are done, post a one-line verdict and despawn yourself."\n' +
        "}\n" +
        "```",
      schema: {
        name: z
          .string()
          .regex(/^[A-Za-z0-9_][A-Za-z0-9_-]*$/, "use letters, digits, _ or -, starting with a letter, digit or _")
          .describe("Unique name for the persona (also the spawn name): letters, digits, _ or -, not beginning with -."),
        instance: managerInstanceArg,
        prompt: z.string().max(10_000).describe("The persona: an appended system prompt describing who this agent is. A complete agent file (leading --- frontmatter with subscribe / allowSubscribe / allowPublish) is merged, not wrapped."),
        model: z.string().max(120).optional().describe("Optional model override (e.g. opus, sonnet). Wins over a model: in the prompt's frontmatter."),
        role: z.string().max(120).optional().describe("Optional role written into the persona file (e.g. reviewer). Wins over a role: in the prompt's frontmatter."),
        agent: z.string().max(120).optional().describe("Optional harness pin written into the persona file (e.g. jcode). Wins over an agent: in the prompt's frontmatter."),
        subscribe: z.array(z.string()).optional().describe("Optional active read set written into the persona file. Wins over subscribe: in the prompt's frontmatter."),
        allowSubscribe: z.array(z.string()).optional().describe("Optional read ACL written into the persona file. Wins over allowSubscribe: in the prompt's frontmatter."),
        allowPublish: z.array(z.string()).optional().describe("Optional post ACL written into the persona file. Wins over allowPublish: in the prompt's frontmatter."),
        capabilities: z.array(z.string()).optional().describe("Optional capabilities written into the persona file, such as spawn, run or artifacts. Each must be one you hold; the manager refuses anything more and writes nothing. A redefine that omits it keeps the saved list, which is checked the same way; pass [] to clear it. Capabilities in the prompt's frontmatter are dropped."),
        endpoints: z.array(z.object({ endpoint: z.string(), commands: z.array(z.string()).min(1), instanceId: z.string().optional() }).strict()).optional().describe("Optional endpoint commands written into the persona file, as { endpoint, commands } entries, with instanceId for a command held on one instance. Each must be one you hold; the manager refuses anything more and writes nothing. A redefine that omits it keeps the saved list, which is checked the same way; pass [] to clear it. Endpoints in the prompt's frontmatter are dropped."),
        announce: z
          .string()
          .optional()
          .describe(
            "Optional channel to post a one-line note on once the persona is saved. Omit it to keep the definition private to the manager's persona catalog. Name the channel your team is actually working on, not `general`: a peer that did not ask for this persona has no way to judge whether spawning it is wanted, and a broadcast soliciting spawns from an unfamiliar principal gives peers no reason to trust the request. Your post ACL applies as it does to any other message.",
          ),
      },
      async run(
        agent,
        _config,
        { name, prompt, instance, model, role, agent: agentType, subscribe, allowSubscribe, allowPublish, capabilities, endpoints, announce }: {
          name: string;
          prompt: string;
          instance?: string;
          model?: string;
          role?: string;
          agent?: string;
          subscribe?: string[];
          allowSubscribe?: string[];
          allowPublish?: string[];
          capabilities?: string[];
          endpoints?: PersonaEndpoint[];
          announce?: string;
        },
      ) {
        try {
          const reply = await agent.definePersona({ name, prompt, instance, model, role, agent: agentType, subscribe, allowSubscribe, allowPublish, capabilities, endpoints, announce });
          const target = `\`name\` set to \`${name}\`${instance === undefined ? "" : ` and \`instance\` set to \`${instance}\``}`;
          if (reply.definitionOutcome === "unknown") {
            const readback = `Read back with \`cotal_personas\` on the same manager before acting. Pass ${target}.`;
            const message = `The definition outcome for persona \`${name}\` is unknown: ${reply.error ?? "the manager reply was not observed"}. ` +
              `The file may already have been written or may still be written. Do not re-run this definition or spawn it on this result. ` +
              `${readback} A missing readback alone does not prove the write will not land.`;
            return { text: message, structured: { status: "unknown", name, ...(instance === undefined ? {} : { instance }), next: readback, message } };
          }
          if (!reply.ok) return err(`Couldn't define ${name}: ${reply.error ?? "manager refused"}`);
          const spawnHint = `You can bring it online with \`cotal_spawn\`. Pass ${target}.`;
          // The persona is SAVED whenever we get here, so a failed announcement is a partial success,
          // not a failure. Saying "couldn't define" would name the wrong remediation (the caller
          // would fix its spawn capability, which was never the problem) and invite a retry — and a
          // retry that succeeds posts the duplicate announcement this change exists to remove. Say
          // what happened to each half, and point at the ACL that actually blocked the post.
          // Two different partial successes, and conflating them is dangerous in the direction this
          // change cares about. A permission denial PROVES nothing was published. Any other failure
          // — a reconnect, a publish timeout — leaves the outcome UNKNOWN, because a chat publish
          // rides JetStream request/PubAck and the stream may have stored the message while the ack
          // was never observed. Telling someone "it did not go out, post it yourself" on an unknown
          // outcome is how they post it twice.
          if (reply.announceError && reply.announceOutcome === "denied")
            return ok(
              `Persona \`${name}\` saved — but the announcement to #${announce} was REFUSED and did not go out: ${reply.announceError}. ` +
                `The persona is on disk; do not re-run this call. Check your \`allowPublish\` for #${announce}, then post it yourself if you still want to. ${spawnHint}`,
            );
          if (reply.announceError)
            return ok(
              `Persona \`${name}\` saved — but I could NOT CONFIRM the announcement to #${announce}: ${reply.announceError}. ` +
                `It may or may not have been delivered. The persona is on disk; do not re-run this call, and READ #${announce} before posting anything yourself — posting blind is how the channel gets it twice. ${spawnHint}`,
            );
          // Report the destination when there was one, so the caller can tell a silent define from an
          // announced one without having to go read the channel.
          return ok(`Persona \`${name}\` saved${announce ? ` and announced on #${announce}` : ""}. ${spawnHint}`);
        } catch (e) {
          // A rejected `announce` throws before the manager write, so nothing was saved and the
          // remediation is the argument, not a capability. controlFailure's spawn-capability advice
          // would be actively misleading here.
          const detail = (e as Error)?.message ?? String(e);
          if (detail.startsWith("announce:"))
            return err(`Couldn't define ${name}: ${detail}. Nothing was written.`);
          return controlFailure(`Couldn't define ${name}`, e);
        }
      },
    },
    {
      name: "cotal_personas",
      title: "Cotal: list or show personas",
      description:
        "Read the workspace persona catalog the manager owns (.cotal/agents). Omit `name` to list spawnable persona names (role, model, and a one-line description when you own the file). Pass `name` to show one card you own, including the persona body. Same ownership as cotal_persona: a file you do not own lists as a name only, while unauthorized, unknown, and unparseable shows are all not-found. Use this to see whether a name is taken before cotal_persona, or what a teammate's persona says, without shelling out. Pass `instance` to read one manager's catalog when the owner has several managers.",
      schema: {
        name: z
          .string()
          .regex(/^[A-Za-z0-9_-]+$/, "letters, digits, _ or - only")
          .optional()
          .describe("Persona to show. Omit to list the catalog."),
        instance: managerInstanceArg,
      },
      async run(agent, _config, { name, instance }: { name?: string; instance?: string }) {
        try {
          if (name) {
            const reply = await agent.showPersona(name, instance);
            if (!reply.ok) return err(`Couldn't show ${name}: ${reply.error ?? "manager refused"}`);
            const row = (reply.data ?? {}) as {
              name?: string;
              role?: string;
              model?: string;
              description?: string;
              owner?: string;
              persona?: string;
              error?: string;
            };
            if (row.error) return err(`Persona \`${name}\` is unparseable: ${row.error}`);
            const meta = [
              row.role && `role=${row.role}`,
              row.model && `model=${row.model}`,
              row.owner && `owner=${row.owner}`,
            ]
              .filter(Boolean)
              .join("  ");
            const lines = [`Persona \`${row.name ?? name}\`${meta ? `  ${meta}` : ""}`];
            if (row.description) lines.push(row.description);
            if (row.persona) lines.push("", row.persona);
            return ok(lines.join("\n"));
          }
          const reply = await agent.listPersonas(instance);
          if (!reply.ok) return err(`Couldn't list personas: ${reply.error ?? "manager refused"}`);
          const personas = ((reply.data as { personas?: Array<{
            name: string;
            role?: string;
            model?: string;
            description?: string;
            owner?: string;
            error?: string;
          }> })?.personas) ?? [];
          if (!personas.length) return ok("No personas in the manager catalog.");
          const lines = personas.map((p) => {
            if (p.error) return `${p.name}  ⨯ unparseable`;
            const meta = [p.role, p.model && `model=${p.model}`, p.owner && `owner=${p.owner}`].filter(Boolean).join("  ");
            const head = meta ? `${p.name}  ${meta}` : p.name;
            return p.description ? `${head}\n  ${p.description}` : head;
          });
          return ok(`Personas in the manager catalog (${personas.length}):\n${lines.join("\n")}`);
        } catch (e) {
          return controlFailure(name ? `Couldn't show ${name}` : "Couldn't list personas", e);
        }
      },
    },
  ];
}

/** A broker denial names the caller's principal and the subject it cannot publish to. Neither is actionable. */
function pinAuditResultError(error: string): string {
  return /^permission-denied\b/.test(error)
    ? "permission-denied: this caller may not read the helper's model pin"
    : error;
}
