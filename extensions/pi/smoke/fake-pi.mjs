import { appendFileSync, readFileSync } from "node:fs";

const log = (entry) => appendFileSync(process.env.FAKE_PI_LOG, JSON.stringify(entry) + "\n");
log({
  pid: process.pid,
  argv: process.argv.slice(2),
  seatIdentity: "COTAL_SPACE" in process.env || "COTAL_NAME" in process.env,
  providerKey: "ANTHROPIC_API_KEY" in process.env,
  cwd: process.cwd(),
});
if (process.argv.includes("--version")) {
  process.stdout.write(`${process.env.FAKE_PI_VERSION ?? "1.5.2"}\n`);
  process.exit(0);
}
const mode = process.env.FAKE_PI_MODE;
if (mode === "exit") process.exit(3);
if (process.env.FAKE_PI_STUBBORN === "1") {
  process.on("SIGTERM", () => log({ sigterm: true }));
  setInterval(() => {}, 1_000);
}

// "catalog" replays pi's recorded answers: the models reply, then each selected model's levels.
const recorded = mode === "catalog" ? JSON.parse(readFileSync(process.env.FAKE_PI_REPLY, "utf8")) : undefined;
let selected;
function catalogAnswer({ id, type, provider, modelId }) {
  const answer = (fields) => ({ id, type: "response", command: type, ...fields });
  if (type === process.env.FAKE_PI_REFUSE) return answer({ success: false, error: `Unknown command: ${type}` });
  if (type === "get_available_models") return { ...recorded.models, id };
  if (type === "set_model") {
    const key = `${provider}/${modelId}`;
    if (!(key in recorded.levels)) return answer({ success: false, error: `Model not found: ${key}` });
    selected = key;
    return answer({ success: true, data: {} });
  }
  if (type === "get_available_thinking_levels") return answer({ success: true, data: { levels: recorded.levels[selected] } });
  return answer({ success: false, error: `Unknown command: ${type}` });
}

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => {
  buf += d;
  let nl;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const command = JSON.parse(buf.slice(0, nl));
    buf = buf.slice(nl + 1);
    log({ command });
    if (mode === "catalog") process.stdout.write(JSON.stringify(catalogAnswer(command)) + "\n");
    else if (mode === "reply") process.stdout.write(JSON.stringify({ ...JSON.parse(readFileSync(process.env.FAKE_PI_REPLY, "utf8")), id: command.id }) + "\n");
    else if (mode === "garbage") process.stdout.write("pi: not a protocol record\n");
  }
});
