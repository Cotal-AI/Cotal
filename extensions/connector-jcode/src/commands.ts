/**
 * The Jcode seat's own commands on its `agent` endpoint (SPEC 13.22): Jcode's native session
 * operations, each one Harness request that starts no model turn, the stop for a running turn, the
 * owner's own turns and what Jcode reports of its context, and the switch of its model and effort.
 *
 * `clear` is not offered. Jcode answers it with a session status of `attached`, which the host's
 * turn tracking reads as a busy session, so the seat would stop taking messages after it.
 */
import { HarnessError, type JcodeClient } from "@1jehuang/jcode-sdk";
import type { CommandEntry, CommandTarget } from "@cotal-ai/core";
import { CommandRefused, type AgentCommand, type AgentTurn, type CommandDispatcher } from "@cotal-ai/connector-core";
import type { HostTurnState } from "./host-turns.js";
import { switchJcodeModel } from "./model-switch.js";
import { jcodeUsage } from "./usage.js";

type Session = Pick<JcodeClient, "cancel" | "compact" | "rewind" | "renameSession">;

interface NativeCommand {
  readonly description: string;
  readonly inputHint?: string;
  run(client: Session, sessionId: string, args: string): Promise<unknown>;
}

const refuse = (message: string): never => {
  throw new CommandRefused("failed-precondition", message);
};

/** Named as Jcode's own TUI names them. */
const NATIVE = new Map<string, NativeCommand>(Object.entries({
  compact: {
    description: "Compact the conversation so far to free context. Jcode refuses when there is too little to compact.",
    run: (client, sessionId, args) => (args ? refuse("Jcode's compact takes no arguments") : client.compact(sessionId)),
  },
  rewind: {
    description: "Keep the first N messages of the conversation and drop the rest.",
    inputHint: "message number",
    run: (client, sessionId, args) =>
      /^[1-9]\d*$/.test(args) ? client.rewind(sessionId, Number(args)) : refuse("rewind needs a message number, 1 or more"),
  },
  rename: {
    description: "Name this session, or restore its generated title with --clear.",
    inputHint: "session name or --clear",
    run: (client, sessionId, args) =>
      args === "--clear" ? client.renameSession(sessionId) : args ? client.renameSession(sessionId, args) : refuse("rename needs a name, or --clear"),
  },
} satisfies Record<string, NativeCommand>));

/** `host` is the host's turn state, read at each call: a bridge recovery replaces its client.
 *  `startTurn` runs the owner's turn; the host binds it once its turn closures exist. */
export function jcodeCommands(
  host: Pick<HostTurnState, "client" | "sessionId" | "turnActive" | "driving" | "reconnecting" | "tokenUsage" | "provider">,
  startTurn: (turn: AgentTurn) => Promise<void>,
): CommandDispatcher {
  return {
    targets: new Set<CommandTarget>(["command"]),
    images: true,
    turn: (turn) => startTurn(turn),
    usage: async () => jcodeUsage(host.provider, host.tokenUsage),
    setModel: (model, variant) => switchJcodeModel(host, model, variant),
    async list(): Promise<CommandEntry[]> {
      return [...NATIVE].map(([name, c]) => ({ name, target: "command", description: c.description, ...(c.inputHint ? { inputHint: c.inputHint } : {}) }));
    },
    async dispatch({ name, args }: AgentCommand) {
      const command = NATIVE.get(name);
      if (!command) throw new CommandRefused("not-found", `Jcode has no command named "${name}"`);
      const { client, sessionId } = host;
      if (!client || !sessionId) throw new CommandRefused("failed-precondition", "Jcode's session is not ready");
      try {
        await command.run(client, sessionId, args.trim());
      } catch (e) {
        // An `invalid_request` answer is Jcode refusing the operation; any other failure may have
        // reached the session.
        if (e instanceof HarnessError && e.code === "invalid_request") refuse(e.message);
        throw e;
      }
    },
    // Jcode ends a cancelled turn with `turn_done`, as it does when its user stops one, so the host
    // ends that turn on its usual path. A cancel sent to an idle session would leave a `cancelled`
    // status that the host reads as busy, so none is sent then.
    async interrupt() {
      const { client, sessionId, turnActive } = host;
      if (!client || !sessionId || !turnActive) return "idle";
      await client.cancel(sessionId);
      return "interrupted";
    },
  };
}
