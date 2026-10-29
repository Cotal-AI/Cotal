// A real managed connector process exercising the published tool surface on the JWT broker.
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { MeshAgent, configFromEnv, cotalToolSpecs, parseToolArgs } from "@cotal-ai/connector-core";

const config = configFromEnv();
const mesh = new MeshAgent(config);
const root = process.env.MULTI_TOOL_DIR;
const trace = (row) => appendFileSync(join(root, "tool-results.jsonl"), JSON.stringify(row) + "\n");
const invoke = mesh.managerInvoke.bind(mesh);
mesh.managerInvoke = async (...args) => {
  const reply = await invoke(...args);
  trace({ command: args[0], reply });
  return reply;
};
mesh.on("error", (e) => console.error(e.message));
await mesh.start();
let seen = "", busy = false;
const timer = setInterval(async () => {
  const path = join(root, "tool-command.json");
  if (busy || !existsSync(path)) return;
  const raw = readFileSync(path, "utf8");
  if (seen === raw) return;
  seen = raw;
  busy = true;
  const task = JSON.parse(raw);
  try {
    const spec = cotalToolSpecs(config).find((s) => s.name === task.name);
    if (!spec) throw new Error("tool not advertised: " + task.name);
    trace({ startedSeq: task.seq });
    trace({ seq: task.seq, result: await spec.run(mesh, config, parseToolArgs(spec, task.args)) });
  } catch (e) { trace({ seq: task.seq, error: String(e) }); }
  finally { busy = false; }
}, 100);
const stop = () => { clearInterval(timer); void mesh.stop().finally(() => process.exit(0)); };
process.on("SIGTERM", stop); process.on("SIGINT", stop);
