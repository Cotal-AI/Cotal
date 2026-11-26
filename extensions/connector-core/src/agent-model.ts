/**
 * The model an agent runs, on its `agent` endpoint (SPEC 13.22): the `set-model` handler. The
 * connector's dispatcher switches its harness, and the agent's card then shows the model and variant
 * the harness runs.
 */
import {
  AGENT_CONTRACTS, EpEnvelopeError,
  type EpErrorCode, type EpPrincipalCommandDef, type EpPrincipalServeContext, type SetModelInput, type SetModelOutput,
} from "@cotal-ai/core";
import { CommandRefused, notSelf, type CommandDispatcher } from "./agent-commands.js";

export interface ModelLane {
  readonly handler: EpPrincipalCommandDef;
  /** Refuse every later `set-model` as `unavailable`. */
  close(): void;
}

const refused = (code: EpErrorCode, message: string) => new EpEnvelopeError(code, message, undefined, "not-executed");

/** What the model lane needs besides the dispatcher. */
export interface ModelLaneOptions {
  /** Puts a switch on the agent's card once the harness took it. */
  show(switched: SetModelOutput): Promise<void>;
  warn(msg: string): void;
  /** The role whose `modelPolicy` the agent launched under. Such an agent refuses every switch. */
  policed?: string;
}

/** Serve `set-model` through `dispatcher`. Calls run one at a time, so the harness and the card take
 *  the switches in the order they came. A card that did not take a switch is warned about, since the
 *  harness runs the model already. */
export function createModelLane(dispatcher: CommandDispatcher | undefined, o: ModelLaneOptions): ModelLane {
  let closed = false;
  let tail: Promise<unknown> = Promise.resolve();

  async function switchTo({ model, variant }: SetModelInput): Promise<SetModelOutput> {
    if (!dispatcher?.setModel) throw refused("unimplemented", "this agent's harness cannot switch the model it runs");
    if (o.policed !== undefined)
      throw refused("failed-precondition", `this agent launched under modelPolicy.${o.policed} in the operator's cotal config, which judges its model at launch only. Start a new agent on a model the policy allows.`);
    const cause = dispatcher.unsupported?.();
    if (cause !== undefined) throw refused("unimplemented", `this agent's connector cannot switch its model now: ${cause}`);
    if (closed) throw refused("unavailable", "this agent is stopping");
    let runs: SetModelOutput;
    try {
      runs = await dispatcher.setModel(model, variant);
    } catch (e) {
      const message = String((e as Error)?.message ?? e);
      if (e instanceof CommandRefused) throw refused(e.code, `the harness refused the switch: ${message}`);
      throw new EpEnvelopeError("internal", `the harness failed, so the model it runs is not known: ${message}`, undefined, "unknown");
    }
    const switched: SetModelOutput = { model: runs.model, ...(runs.variant !== undefined ? { variant: runs.variant } : {}) };
    try {
      await o.show(switched);
    } catch (e) {
      o.warn(`set-model: presence does not show ${switched.model} yet: ${(e as Error).message}`);
    }
    return switched;
  }

  return {
    handler: {
      command: "set-model",
      contract: AGENT_CONTRACTS["set-model"],
      handler: (ctx: EpPrincipalServeContext) => {
        notSelf(ctx, "switches its own model");
        const run = tail.then(() => switchTo(ctx.request.args as unknown as SetModelInput));
        tail = run.catch(() => {});
        return run;
      },
    },
    close() {
      closed = true;
    },
  };
}
