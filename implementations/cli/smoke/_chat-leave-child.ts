/**
 * Child process for `chat-leave.smoke.ts`. It starts one chat front end the way `cotal chat` hands
 * over to it (signals held, front end started, signals released, exit code from the close report)
 * over a recording stand-in session. On stderr it writes `ready` once the front end has started,
 * then `closed <n> sends <n>` after the front end returns.
 *
 * The stand-in is not an admitted session, and nothing here proves admission, retirement, delivery
 * or any native behavior. It answers the two reads the recipient picker makes, counts `close()` and
 * publishes, and holds a timer until it is closed, the way a live connection keeps the process
 * running, so a front end that never closes its session never exits.
 *
 * Usage: _chat-leave-child.ts <tui|plain|stdio>
 */
import { closeExitCode, holdSignals } from "../src/commands/chat.js";
import { loadChatFrontEnd } from "../src/chat/frontend.js";
import type { AdmittedChatSession, Failed, PublishResult, SessionIdentity } from "../src/chat/session.js";

const frontEnd = process.argv[2];
if (frontEnd !== "tui" && frontEnd !== "plain" && frontEnd !== "stdio") throw new Error("usage: _chat-leave-child.ts <tui|plain|stdio>");

const identity: SessionIdentity = {
  mode: "open", space: "chatleave", principal: "smoke.chat-leave", lifecycleUid: "chat-leave-uid", label: "chat-leave",
  allowSubscribe: ["general"], allowPublish: ["general"],
};
let closes = 0;
let sends = 0;
const alive = setInterval(() => {}, 60_000);
const unused = async (): Promise<Failed> => ({ outcome: "failed", message: "not used by this fixture" });
const publish = async (): Promise<PublishResult> => {
  sends++;
  return { outcome: "stored", messageId: `m${sends}` };
};
const session: AdmittedChatSession = {
  identity: () => identity,
  subscribe: () => () => {},
  send: publish,
  dm: publish,
  anycast: publish,
  setStatus: unused,
  setAttention: unused,
  setChannelMode: unused,
  join: unused,
  leave: unused,
  inbox: unused,
  roster: async () => ({ outcome: "ok", value: { rows: [], view: "current" } }),
  channelInfo: unused,
  connection: async () => ({ outcome: "ok", value: { state: "connected", identity, bufferedInbox: 0, joinedChannels: ["general"], attention: "open", channelModes: {} } }),
  history: unused,
  invoke: unused,
  reconnect: unused,
  surfaced: () => {},
  close: async () => {
    closes++;
    clearInterval(alive);
    return { retirement: "not-applicable", connectionClosed: "confirmed", message: "the stand-in session closed" };
  },
};

const start = await loadChatFrontEnd(frontEnd);
const signals = holdSignals();
const running = start({ session, initialRecipient: { kind: "channel", channel: "general" } });
signals.release();
process.stderr.write("ready\n");
const close = await running;
process.stderr.write(`closed ${closes} sends ${sends}\n`);
process.exitCode ??= closeExitCode(close);
