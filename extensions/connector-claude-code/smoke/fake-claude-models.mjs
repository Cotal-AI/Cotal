import { appendFileSync, readFileSync, readdirSync } from "node:fs";

const log = (entry) => appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify(entry) + "\n");
const reply = JSON.parse(readFileSync(process.env.FAKE_CLAUDE_REPLY, "utf8"));
// With recorded settings, claude answers each request by its kind: `initialize` with the reply and the
// fast-mode state it reports by then, `get_settings` with what it applies to the model the flag
// settings name, and `apply_flag_settings` by merging them. Without, every request gets the reply.
const settings = process.env.FAKE_CLAUDE_SETTINGS ? JSON.parse(readFileSync(process.env.FAKE_CLAUDE_SETTINGS, "utf8")) : undefined;
log({ pid: process.pid, argv: process.argv.slice(2), env: Object.keys(process.env), cwd: process.cwd(), cwdEntries: readdirSync(".") });
if (reply === "exit") process.exit(3);
process.on("exit", (code) => log({ exited: code }));
// A busy claude that keeps running after its input closes. It still ends within 30s if the suite dies.
if (process.env.FAKE_CLAUDE_STUBBORN === "1") setTimeout(() => {}, 30_000);

let flagModel;
let initialized = 0;
function answerTo({ subtype, settings: applied }) {
  if (!settings || reply === "silent") return reply;
  const success = (response) => ({ type: "control_response", response: { subtype: "success", response } });
  if (subtype === "initialize") {
    const fast = settings.fastStates[Math.min(initialized++, settings.fastStates.length - 1)];
    return { ...reply, response: { ...reply.response, response: { ...reply.response.response, ...fast } } };
  }
  if (subtype === "apply_flag_settings") {
    if (applied && "model" in applied) flagModel = applied.model ?? undefined;
    return success({});
  }
  if (subtype === "get_settings") {
    if (settings.refuse === "get_settings") return { type: "control_response", response: { subtype: "error", error: "Unsupported control request subtype: get_settings" } };
    if (flagModel === undefined) return success({ applied: settings.launchDefault });
    return success({ applied: settings.byModel[flagModel] ?? { model: flagModel, effort: null, ultracode: false, ultracodeAvailable: false } });
  }
  return { type: "control_response", response: { subtype: "error", error: `Unsupported control request subtype: ${subtype}` } };
}

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  for (let nl = buf.indexOf("\n"); nl >= 0; nl = buf.indexOf("\n")) {
    const request = JSON.parse(buf.slice(0, nl));
    buf = buf.slice(nl + 1);
    log({ request });
    const answered = answerTo(request.request ?? {});
    const answer = JSON.stringify({ ...answered, response: { ...answered.response, request_id: request.request_id } }) + "\n";
    if (reply !== "silent") setTimeout(() => process.stdout.write(answer), Number(process.env.FAKE_CLAUDE_ANSWER_DELAY_MS ?? 0));
  }
});
// The real claude ends on its own once its input closes, and so does this one unless it is stubborn.
process.stdin.on("end", () => log({ stdinClosed: true }));
