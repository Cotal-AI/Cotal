/**
 * `cotal chat` command pure smoke (no broker, no manager, no auth service, no session).
 *
 * SCOPE, stated honestly: this checks the command's declaration, its scoped help, its grammar and
 * front-end refusals, the declared flags that refuse until an admission supports them, the one
 * `--kind` it accepts, the admission each recorded mode is dispatched to, the exit code of each
 * close report, the wording of each channel disclosure, the signal hold's bookkeeping, that loading
 * a front end starts nothing, and the completion values that need no mesh. Target resolution, the
 * registry read before admission, admission, a real signal, the hand-over to a running front end
 * and every native behavior are NOT covered here.
 *
 * Run: pnpm smoke:chat-command
 */
import { commandDeclarationProblems, parseCommandArgs, registry, type Command } from "@cotal-ai/core";
import { createSuite } from "@cotal-ai/smoke-kit";
import { disableInput, exitCode, globalFlagDeclarationProblems, isCommandFailure, outputDeclarationProblems, type CommandFailure } from "@cotal-ai/workspace";
import "../src/index.js"; // self-register the CLI commands
import { printCommandHelp } from "../src/help.js";
import { USER_CHAT_TTL_SEC, channelDisclosure, chatAdmission, chatArguments, chatComplete, closeExitCode, holdSignals, type ChatInput } from "../src/commands/chat.js";
import { loadChatFrontEnd } from "../src/chat/frontend.js";
import type { CloseReport } from "../src/chat/session.js";

const { check, finish } = createSuite();
const cmd = registry.resolve<Command>("command", "chat");

/** The parsed input, or the refusal its grammar raised. A parse error is returned as thrown. */
function run(argv: string[]): ChatInput | CommandFailure | Error {
  try {
    return chatArguments(parseCommandArgs(cmd, argv));
  } catch (e) {
    return e as Error;
  }
}
const refusal = (r: ReturnType<typeof run>): CommandFailure | undefined => (isCommandFailure(r) ? r : undefined);
const exitOf = (r: ReturnType<typeof run>): number | undefined => { const f = refusal(r); return f ? exitCode(f.outcome, f.code) : undefined; };

/** Run `body` with stdin and stdout reporting `tty` as their terminal state, then restore both. */
function withTty<T>(tty: boolean, body: () => T): T {
  const saved = [process.stdin, process.stdout].map((stream) => [stream, Object.getOwnPropertyDescriptor(stream, "isTTY")] as const);
  for (const [stream] of saved) Object.defineProperty(stream, "isTTY", { value: tty, configurable: true, writable: true });
  try {
    return body();
  } finally {
    for (const [stream, descriptor] of saved) {
      if (descriptor) Object.defineProperty(stream, "isTTY", descriptor);
      else delete (stream as { isTTY?: boolean }).isTTY;
    }
  }
}

console.log("1. the command is registered under Messaging with its declared surface");
{
  const flags = (cmd.flags ?? []).map((f) => f.name).sort().join();
  check("chat is a Messaging command with one optional channel", cmd.name === "chat" && cmd.group === "Messaging" && cmd.positionals === "[<channel>]");
  check("it declares the target, front-end, label, kind and not-yet flags and nothing else",
    flags === ["creds", "kind", "lifecycle-uid", "link", "name", "plain", "role", "server", "space", "stdio", "token"].join(), flags);
  check("it declares plain output only, so it has no --json", JSON.stringify(cmd.outputs) === '["plain"]' && !(cmd.flags ?? []).some((f) => f.name === "json"));
  check("its declaration passes the kernel's checks",
    commandDeclarationProblems(cmd).length === 0 && outputDeclarationProblems(cmd).length === 0 && globalFlagDeclarationProblems(cmd).length === 0);
  const lines: string[] = [];
  printCommandHelp(cmd, undefined, (line) => lines.push(line), 120);
  const help = lines.join("\n");
  check("its help shows the usage, --stdio and the flags that are not available yet",
    help.includes("cotal chat [<channel>]") && help.includes("--stdio") && help.includes("not available for chat yet"), help);
}

console.log("2. grammar refuses before any target, connector or connection");
{
  const stdio = run(["--stdio"]);
  check("--stdio alone opens a program session with no channel", !(stdio instanceof Error) && stdio.frontEnd === "stdio" && stdio.channel === undefined, stdio);
  const named = run(["#review", "--stdio", "--name", "alice"]);
  check("a channel's leading # is dropped and --name becomes the label",
    !(named instanceof Error) && named.channel === "review" && named.label === "alice", named);
  const both = run(["--stdio", "--plain"]);
  check("--stdio with --plain refuses as usage", refusal(both)?.code === "USAGE_INVALID" && exitOf(both) === 1, both);
  const json = run(["--json", "--stdio"]);
  const parseCode = (json as unknown as { code?: unknown }).code;
  check("--json is not a chat flag", !isCommandFailure(json) && typeof parseCode === "string" && parseCode.startsWith("ERR_PARSE_ARGS"), json);
  check("two channels refuse as usage", refusal(run(["a", "b", "--stdio"]))?.code === "USAGE_INVALID");
  for (const channel of ["team.*", "team.>"])
    check(`the wildcard channel ${channel} refuses as usage`, refusal(run([channel, "--stdio"]))?.code === "USAGE_INVALID");
  for (const [what, name] of [["an empty", " "], ["a 129-character", "x".repeat(129)], ["a control-character", "a\u0007b"]] as const)
    check(`${what} --name refuses as usage`, refusal(run(["--stdio", "--name", name]))?.code === "USAGE_INVALID");
}

console.log("3. each declared flag no admission supports refuses as unsupported, exit 2");
for (const flag of ["role", "link", "token", "creds", "lifecycle-uid"]) {
  const r = run(["--stdio", `--${flag}`, "x"]);
  check(`--${flag} refuses as not available yet`,
    refusal(r)?.code === "UNSUPPORTED" && exitOf(r) === 2 && refusal(r)!.message.includes(`--${flag} is not available for chat yet`), r);
}
{
  const role = refusal(run(["--stdio", "--role", "reviewer"]));
  check("--role says it would take the role's work queue and the view cannot answer a task's sender",
    role?.message.includes("work queue") === true && role.message.includes("cannot yet answer a task's sender"), role);
}

console.log("3a. --kind accepts only endpoint, the kind every admission already presents");
{
  const endpoint = run(["--stdio", "--kind", "endpoint"]);
  check("--kind endpoint opens as the same session without it",
    !(endpoint instanceof Error) && JSON.stringify(endpoint) === JSON.stringify(run(["--stdio"])), endpoint);
  const agent = run(["--stdio", "--kind", "agent"]);
  check("--kind agent refuses as usage, exit 1, because a chat session never presents as an agent",
    refusal(agent)?.code === "USAGE_INVALID" && exitOf(agent) === 1 && refusal(agent)!.message.includes("never presents as an agent"), agent);
  const other = run(["--stdio", "--kind", "service"]);
  check("any other --kind refuses as usage, exit 1", refusal(other)?.code === "USAGE_INVALID" && exitOf(other) === 1, other);
}

console.log("4. the front end follows the terminal and never falls back");
{
  const view = withTty(true, () => run([]));
  check("a terminal opens the terminal view", !(view instanceof Error) && view.frontEnd === "tui", view);
  const piped = withTty(false, () => run(["review"]));
  check("no terminal refuses as usage and names --plain and --stdio",
    refusal(piped)?.code === "USAGE_INVALID" && refusal(piped)!.message.includes("--plain") && refusal(piped)!.message.includes("--stdio"), piped);
  const plain = withTty(false, () => run(["review", "--plain"]));
  check("--plain opens line mode without a terminal", !(plain instanceof Error) && plain.frontEnd === "plain", plain);
}

console.log("5. the recorded mode alone picks the admission");
{
  const open = chatAdmission("open", "l", "review");
  check("open routes the channel and asks for no credential", JSON.stringify(open) === JSON.stringify({ mode: "open", label: "l", channels: ["review"] }), open);
  const auth = chatAdmission("auth", "l", "review");
  check("static subscribes and may post to the channel, with the ceiling left to the native rule",
    JSON.stringify(auth) === JSON.stringify({ mode: "auth", label: "l", subscribe: ["review"], allowPublish: ["review"] }), auth);
  const user = chatAdmission("user", "l", "review");
  check("user reads and posts the channel for the auth service's 8-hour cap",
    JSON.stringify(user) === JSON.stringify({ mode: "user", label: "l", channels: ["review"], read: ["review"], post: ["review"], ttlSec: 28_800 }) && USER_CHAT_TTL_SEC === 28_800, user);
  const bare = [chatAdmission("open", "l", undefined), chatAdmission("auth", "l", undefined), chatAdmission("user", "l", undefined)];
  check("without a channel every list is empty", bare.every((a) => Object.values(a).every((v) => !Array.isArray(v) || v.length === 0)), bare);
  let unknown: unknown;
  try { chatAdmission("other" as never, "l", undefined); } catch (e) { unknown = e; }
  check("an unknown recorded mode refuses as unsupported with no other mode tried",
    isCommandFailure(unknown) && unknown.code === "UNSUPPORTED" && unknown.message.includes("no other mode was tried"), unknown);
}

console.log("6. a close report sets the exit code");
{
  const report = (retirement: CloseReport["retirement"], connectionClosed: CloseReport["connectionClosed"]): CloseReport => ({ retirement, connectionClosed, message: "m" });
  check("a confirmed retirement exits 0", closeExitCode(report("retired", "confirmed")) === 0);
  check("a confirmed open close exits 0", closeExitCode(report("not-applicable", "confirmed")) === 0);
  check("a requested, unconfirmed retirement exits 4", closeExitCode(report("requested", "confirmed")) === 4);
  check("an unknown retirement exits 3", closeExitCode(report("unknown", "confirmed")) === 3);
  check("an unconfirmed connection close exits 3, whatever the retirement",
    (["retired", "requested", "not-applicable"] as const).every((r) => closeExitCode(report(r, "not-confirmed")) === 3));
  check("no close report exits 3", closeExitCode(undefined) === 3);
  check("a confirmed close of a session that could not continue exits 5", closeExitCode({ ...report("retired", "confirmed"), lost: "gone" }) === 5);
  check("...and 3 when its close is not confirmed", closeExitCode({ ...report("retired", "not-confirmed"), lost: "gone" }) === 3);
}

console.log("7. completion needs no mesh for these words");
{
  const name = chatComplete(["--name", ""]);
  check("a --name value offers nothing", name.items.length === 0 && name.directive === "nofiles", name);
  const second = chatComplete(["review", ""]);
  check("a second positional offers nothing", second.items.length === 0 && second.directive === "nofiles", second);
}

console.log("8. each channel disclosure says what the registry read found");
{
  const registered = channelDisclosure("review", true);
  const unregistered = channelDisclosure("review", false);
  const unread = channelDisclosure("review", undefined);
  check("a registered channel is named as registered", registered.includes("#review is a registered channel") && !registered.includes("Unregistered"), registered);
  check("an unregistered channel is labeled and nothing creates it",
    unregistered.startsWith("Unregistered channel #review") && unregistered.includes("native policy") && unregistered.includes("nothing creates"), unregistered);
  check("an unread registry is disclosed as not read, never as either answer",
    unread.includes("could not be read") && !unread.includes("registered channel") && !unread.startsWith("Unregistered"), unread);
}

console.log("9. signals are held until a front end takes them, and loading a front end starts nothing");
{
  const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
  const before = new Map(SIGNALS.map((sig) => [sig, process.listeners(sig)]));
  const added = (sig: (typeof SIGNALS)[number]) => process.listeners(sig).filter((l) => !before.get(sig)!.includes(l));
  const held = holdSignals();
  check("holding adds one handler for each signal", SIGNALS.every((sig) => added(sig).length === 1));
  // The handlers are called directly: emitting a signal would also reach the runner's own handlers.
  for (const sig of ["SIGHUP", "SIGINT"] as const) for (const handler of added(sig)) (handler as () => void)();
  check("the first signal's status is kept and a later one is absorbed", held.caught() === 129, held.caught());
  held.release();
  held.release();
  check("releasing removes every handler, and a second release is harmless", SIGNALS.every((sig) => added(sig).length === 0));
  const start = await loadChatFrontEnd("stdio");
  check("loading the stdio front end installs no handler and starts nothing", typeof start === "function" && SIGNALS.every((sig) => added(sig).length === 0));
}

console.log("10. --no-input leaves only the program protocol");
{
  disableInput();
  check("--plain refuses under --no-input", refusal(withTty(true, () => run(["--plain"])))?.code === "USAGE_INVALID");
  check("the terminal view refuses under --no-input", refusal(withTty(true, () => run([])))?.code === "USAGE_INVALID");
  const stdio = run(["--stdio"]);
  check("--stdio still opens", !(stdio instanceof Error) && stdio.frontEnd === "stdio", stdio);
}

finish();
