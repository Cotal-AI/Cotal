import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { MeshAgent, configFromEnv, launchEnv, type AgentConfig, type InboxItem } from "@cotal-ai/connector-core";
import { writeRpc, readJsonLines } from "./rpc-frames.js";
import { PROVIDER_KEYS } from "./connector.js";
import { createTuiRenderer, type TuiRenderer } from "./tui-render.js";

// Resolve the `pi` wrapper the same way connector.ts resolves `tsx`: as the
// extension's own node_modules/.bin entry (pnpm provides it for the
// @earendil-works/pi-coding-agent dependency). Spawn PI_CLI directly, matching
// how the connector spawns TSX as the command.
const PI_CLI = fileURLToPath(new URL("../node_modules/.bin/pi", import.meta.url));

// ---- helpers duplicated from peer.ts (per blueprint: "duplicate first, then
// extract `peer-util.ts` only after both paths are stable and byte-identical").
// Keeping the duplication inline here keeps the bridge from dragging in a
// share-it-later utility file; the helpers are small and the contract is
// identical to peer.ts.

/** Actionable = a DM, an anycast to our role, or a channel message that names us. */
function actionable(mesh: MeshAgent, item: InboxItem): boolean {
  if (item.fromId === mesh.id) return false;
  return item.kind !== "channel" || item.mentionsMe === true;
}

/** The audience a reply goes back to. Same-scope messages share a turn. */
function scopeKey(item: InboxItem): string {
  return item.kind === "channel" && item.channel ? `channel:${item.channel}` : `dm:${item.fromId}`;
}

function framed(item: InboxItem): string {
  return `from ${item.fromName} via ${item.kind}: ${item.text}`;
}

/** Pull this turn's final assistant text from the agent_end messages array. */
function turnReplyText(messages: readonly unknown[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as { role?: unknown; content?: unknown };
    if (m.role !== "assistant" || !Array.isArray(m.content)) continue;
    const text = m.content
      .map((p) =>
        p && typeof p === "object" && (p as { type?: unknown }).type === "text"
          ? String((p as { text?: unknown }).text ?? "")
          : "",
      )
      .join("");
    return text.length ? text : undefined;
  }
  return undefined;
}

function log(e: unknown): void {
  process.stderr.write(`[pi-peer] ${e instanceof Error ? e.message : String(e)}\n`);
}

/**
 * Interactive mesh-driven peer — the TUI launch mode selected by `PI_PEER_MODE=tui`.
 * Spawns stock `pi --mode rpc` as a child and drives it from the mesh while rendering
 * `extension_ui_request` dialogs locally in the pane, so any pi extension that calls
 * `ctx.ui.*` (approval gates, prompts, selects, editors) becomes live and
 * operator-answerable per-pane.
 */
export async function runTuiClient(config: AgentConfig = configFromEnv()): Promise<void> {
  const mesh = new MeshAgent(config);
  mesh.start();

  const renderer: TuiRenderer & { _setStreaming?: (on: boolean) => void } = createTuiRenderer();
  renderer.start();

  const child = spawn(PI_CLI, ["--mode", "rpc", "--no-session"], {
    cwd: process.cwd(),
    stdio: ["pipe", "pipe", "pipe"],
    env: launchEnv({ providerKeys: PROVIDER_KEYS }),
  });

  // turn/pending/streaming/halt — the loop state.
  // `InboxTurn` in `extensions/connector-core` — same API as peer.ts.
  const { InboxTurn } = await import("@cotal-ai/connector-core");
  const turn = new InboxTurn(mesh);
  let pending = false; // prompt sent, awaiting preflight response
  let halt = false; // set on preflight failure → STOP pump
  let stderrBuf = "";

  const setMeshStatus = (status: "idle" | "working" | "waiting", activity?: string): void => {
    void mesh.setStatus(status, activity).catch(log);
  };

  const deliver = (to: InboxItem, text: string): void => {
    if (to.kind === "channel" && to.channel) void mesh.send(text, to.channel).catch(log);
    else void mesh.dm(to.fromId, text).catch(log);
  };

  function pump(): void {
    if (turn.inFlight || pending || halt) return;
    turn.drop((i) => !actionable(mesh, i));
    const origin = turn.start();
    if (!origin) {
      setMeshStatus("idle");
      return;
    }
    pending = true;
    renderer.flushTrailing();
    writeRpc(child, { type: "prompt", message: framed(origin) });
  }

  function foldSameScope(): void {
    if (!turn.origin || pending) return;
    for (const item of turn.extend((i, o) => actionable(mesh, i) && scopeKey(i) === scopeKey(o))) {
      void renderer; // mark touched
      writeRpc(child, { type: "steer", message: framed(item) });
    }
  }

  // ----- child stderr → transcript (line 6 of slice 3 design) -----
  child.stderr?.on("data", (d: Buffer) => {
    stderrBuf += d.toString();
  });

  // ----- child exit → renderer.stop() + parent exits loud with child code -----
  child.on("exit", (code) => {
    if (stderrBuf) renderer.pushError(`child stderr: ${stderrBuf}`);
    renderer.pushError(`child exit ${code}`);
    renderer.stop();
    process.exit(code ?? 1);
  });

  // ----- Esc while streaming → writeRpc {type:"abort"} -----
  renderer.onAbort(() => {
    writeRpc(child, { type: "abort" });
  });

  // ----- mesh → pump or foldSameScope -----
  mesh.on("incoming", () => {
    if (turn.inFlight) foldSameScope();
    else pump();
  });
  mesh.on("wake", () => {
    if (!turn.inFlight) pump();
  });

  // ----- the frame loop -----
  void (async () => {
    try {
      for await (const frame of readJsonLines(child.stdout)) {
        const t = (frame as { type?: string }).type;
        switch (t) {
          // ---- preflight ack ----
          case "response": {
            const r = frame as { command?: string; success?: boolean; error?: string };
            if (r.command === "prompt") {
              if (r.success === true) {
                pending = false;
                // streaming will start when agent_start arrives
              } else {
                // Prompt preflight failed. This is NOT the no-model / no-key
                // startup case: pi resolves --model only to providers with
                // configured auth and falls back to a scoped model otherwise, and
                // zero configured models makes pi exit(1) before rpc mode starts.
                // The reachable trigger is an OAuth credential that expires
                // MID-SESSION (short-lived-token providers like GitHub Copilot —
                // the reason pi's getApiKey callback exists): the next prompt throws
                // "authentication failed" here. Abandon so JetStream redelivers the
                // message once auth is restored, surface a visible misconfigured
                // status, and halt the pump so we don't burn the inbox retrying.
                pending = false;
                turn.abandon();
                setMeshStatus("waiting", "misconfigured: preflight failed; inbox will redeliver");
                halt = true;
                renderer.pushError(`preflight failed: ${r.error ?? "(no error message)"}`);
              }
            }
            // other command acks (steer, abort, ...) are silent.
            break;
          }

          // ---- agent activity (AgentEvent union: agent_start/end, turn_start/end,
          //    message_start/update/end, tool_execution_start/update/end) ----
          case "agent_start": {
            renderer._setStreaming?.(true);
            setMeshStatus("working", "thinking");
            foldSameScope(); // flush same-scope peers that landed before streaming began
            break;
          }
          case "turn_start": {
            // A new turn. Set streaming here too — some providers emit turn_start
            // without a preceding agent_start, so relying on agent_start alone
            // would leave streaming=false and Esc-while-streaming wouldn't abort.
            renderer._setStreaming?.(true);
            break;
          }
          case "turn_end": {
            // Turn finished; agent_end (with messages + willRetry) follows and is the
            // commit point. No-op here.
            break;
          }
          case "message_start": {
            // A message (user/assistant/toolResult) begins. The streamed text lands
            // via message_update.text_delta; the final assistant text also appears
            // in message_end + agent_end.messages. No-op.
            break;
          }
          case "message_end": {
            // Message complete. No-op (text was streamed via message_update; the
            // turn's final text is committed from agent_end.messages).
            break;
          }
          case "message_update": {
            const ev = frame as {
              assistantMessageEvent?: { type?: string; delta?: string };
            };
            const am = ev.assistantMessageEvent;
            if (am?.type === "text_delta" && typeof am.delta === "string") {
              renderer.pushAssistantText(am.delta);
            }
            break;
          }
          case "tool_execution_start": {
            const ev = frame as { toolName?: string; args?: Record<string, unknown> };
            const name = ev.toolName ?? "tool";
            const args = ev.args ?? {};
            const pathLike =
              (typeof args["path"] === "string" ? args["path"] as string : undefined) ??
              (typeof args["file_path"] === "string" ? args["file_path"] as string : undefined);
            renderer.pushToolEvent(name, pathLike);
            setMeshStatus("working", `running ${name}`);
            break;
          }
          case "tool_execution_update": {
            // Partial tool result streaming (e.g. long bash output). No-op — the
            // tool_execution_end line + status reset is enough for the pane.
            break;
          }
          case "tool_execution_end": {
            setMeshStatus("working", "thinking");
            break;
          }
          // ---- session metadata (AgentSessionEvent extensions) — no-op, do not
          //      spam the pane. These are session lifecycle signals, not turn data. ----
          case "queue_update":
          case "compaction_start":
          case "compaction_end":
          case "session_info_changed":
          case "thinking_level_changed":
          case "auto_retry_start":
          case "auto_retry_end":
            break;

          // ---- extension UI ----
          case "extension_ui_request": {
            const req = frame as {
              id: string;
              method: string;
              title?: string;
              message?: string;
              options?: string[];
              placeholder?: string;
              prefill?: string;
              timeout?: number;
              statusKey?: string;
              statusText?: string | undefined;
              widgetKey?: string;
              widgetLines?: string[] | undefined;
              widgetPlacement?: "aboveEditor" | "belowEditor";
              text?: string;
            };
            switch (req.method) {
              case "confirm": {
                const ok = await renderer.popConfirm(req.title ?? "Confirm", req.message ?? "", { timeout: req.timeout });
                writeRpc(child, { type: "extension_ui_response", id: req.id, confirmed: ok });
                break;
              }
              case "select": {
                const v = await renderer.popSelect(req.title ?? "Select", req.options ?? [], { timeout: req.timeout });
                writeRpc(child, { type: "extension_ui_response", id: req.id, value: v });
                break;
              }
              case "input": {
                const v = await renderer.popInput(req.title ?? "Input", req.placeholder, { timeout: req.timeout });
                writeRpc(child, { type: "extension_ui_response", id: req.id, value: v });
                break;
              }
              case "editor": {
                const v = await renderer.popEditor(req.title ?? "Editor", req.prefill, { timeout: req.timeout });
                // popEditor returns "" on cancel/timeout, the post-edit string otherwise.
                // Extension API (per per-edit-approval.ts) treats undefined as cancel
                // and string as content — but we never send undefined; we send the
                // content (or "" on cancel). The rpc-side handler (rpc-mode.js) maps
                // any non-cancelled response to the string value, so passing ""
                // resolves to "" on the extension end (which the extension then
                // can treat as "empty/cancelled" by convention).
                writeRpc(child, { type: "extension_ui_response", id: req.id, value: v });
                break;
              }
              case "notify": {
                // Fire-and-forget. Render in pane.
                renderer.pushError(`[notify] ${req.message ?? ""}`.trimEnd());
                break;
              }
              case "setStatus": {
                renderer.setStatus("working", `${req.statusKey}: ${req.statusText ?? ""}`);
                break;
              }
              case "setWidget":
              case "setTitle":
              case "set_editor_text":
                // Render-in-place; no response.
                renderer.pushError(`[extension ui: ${req.method}] (render-only)`);
                break;
              default:
                renderer.pushError(`[extension ui: unknown method ${req.method}]`);
            }
            break;
          }

          case "extension_error": {
            const err = frame as { error?: string; event?: string; extensionPath?: string };
            renderer.pushError(`extension error (${err.event ?? ""}): ${err.error ?? ""}`);
            // do not crash; keep processing.
            break;
          }

          // ---- turn completion ----
          case "agent_end": {
            const ev = frame as { willRetry?: boolean; messages?: readonly unknown[] };
            if (ev.willRetry) {
              // Auto-retry follows; do NOT commit, do NOT pump.
              break;
            }
            // Clean finish (or failed-but-terminal — both consume the turn).
            renderer._setStreaming?.(false);
            renderer.flushTrailing();
            const to = turn.origin;
            const reply = turnReplyText(ev.messages ?? []);
            turn.commit();   // SOLE ack site
            if (to && reply) deliver(to, reply);
            setMeshStatus("idle");
            pump();
            break;
          }

          default:
            renderer.pushError(`[unknown frame: ${JSON.stringify(frame)}]`);
        }
      }
    } catch (e) {
      renderer.pushError(`bridge read error: ${(e as Error).message}`);
      renderer.stop();
      process.exit(1);
    }
  })();

  // ----- crash safety: SIGINT / SIGTERM → renderer.stop() + child.kill + mesh.stop + exit 0 -----
  let shuttingDown = false;
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    renderer.stop();
    try { child.kill("SIGTERM"); } catch { /* */ }
    try { await mesh.stop(); } catch { /* */ }
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
  process.on("exit", () => renderer.stop());

  // Drain anything already buffered before the listeners were attached.
  pump();

  // Keep alive.
  await new Promise<void>(() => {});
}
