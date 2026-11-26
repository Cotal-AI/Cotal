/**
 * `set-model` on a Jcode seat's `agent` endpoint (SPEC 13.22): Jcode's own `set_model` and
 * `set_reasoning_effort` Harness requests, sent between turns, answered with the model and effort
 * Jcode reports it runs afterwards.
 */
import { HarnessError, type JcodeClient } from "@1jehuang/jcode-sdk";
import type { SetModelOutput } from "@cotal-ai/core";
import { CommandRefused } from "@cotal-ai/connector-core";
import type { HostTurnState } from "./host-turns.js";
import { bareModelId } from "./route-identity.js";

type Session = Pick<JcodeClient, "setModel" | "setReasoningEffort" | "request">;

const refusal = (message: string) => new CommandRefused("failed-precondition", message);
/** Jcode answers `invalid_request` when it refused the request and left the session as it was. */
const refusedByJcode = (e: unknown): e is HarnessError => e instanceof HarnessError && e.code === "invalid_request";

/** Switch the seat to `model`, or keep the one it runs when undefined, then set its reasoning effort
 *  to `variant`, or leave the effort as Jcode left it when undefined. The effort goes second because
 *  Jcode's model switch can change or clear it. */
export async function switchJcodeModel(
  host: Pick<HostTurnState, "client" | "sessionId" | "turnActive" | "driving" | "reconnecting">,
  model: string | undefined,
  variant: string | undefined,
): Promise<SetModelOutput> {
  const { client, sessionId } = host;
  if (!client || !sessionId || host.reconnecting) throw refusal("Jcode's session is not ready");
  // Jcode holds a switch asked for during a turn until that turn ends and answers only then, which
  // can be past the SDK's request timeout.
  if (host.turnActive || host.driving) throw refusal("Jcode switches models between turns; ask again when this turn ends");
  if (model !== undefined) {
    const spec = bareModelId(model);
    if (!spec.ok) throw refusal(`Jcode takes a bare model id: pass ${JSON.stringify(spec.bare)}. Jcode's configuration chooses the provider.`);
    try {
      await client.setModel(sessionId, model);
    } catch (e) {
      throw refusedByJcode(e) ? refusal(e.message) : e;
    }
  }
  if (variant !== undefined) await setEffort(client, sessionId, variant, model);
  return runsNow(client, sessionId);
}

async function setEffort(client: Session, sessionId: string, variant: string, model: string | undefined): Promise<void> {
  try {
    await client.setReasoningEffort(sessionId, variant);
  } catch (e) {
    // The model has switched already, so a refused effort leaves the seat changed.
    if (model !== undefined)
      throw new Error(`Jcode switched to model ${JSON.stringify(model)}, then did not take variant ${JSON.stringify(variant)}: ${(e as Error).message}`);
    throw refusedByJcode(e) ? refusal(e.message) : e;
  }
}

/** The SDK's `getRuntimeInfo` drops the frame's `reasoning_effort`, so the frame is read as Jcode
 *  sent it. Jcode omits the effort when the model runs with none. */
async function runsNow(client: Session, sessionId: string): Promise<SetModelOutput> {
  const { ev, model, reasoning_effort: effort, message } = await client.request({ req: "get_runtime_info", session_id: sessionId });
  if (ev !== "runtime_info") throw new Error(`Jcode took the switch, then answered its runtime info with ${ev}: ${String(message ?? "")}`);
  if (typeof model !== "string" || !model) throw new Error("Jcode took the switch, then named no model in its runtime info");
  return { model, ...(typeof effort === "string" && effort ? { variant: effort } : {}) };
}
