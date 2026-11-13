// Real managed connector with a file transport for public tool requests.
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { MeshAgent, configFromEnv, cotalToolSpecs, parseToolArgs } from "@cotal-ai/connector-core";

const config = configFromEnv();
const mesh = new MeshAgent(config);
const root = process.env.MANAGED_TOOL_DIR;
mesh.on("error", (error) => console.error(error.message));
await mesh.start();
let seen = "", busy = false;
const timer = setInterval(async () => {
  const path = join(root, "command.json");
  if (busy || !existsSync(path)) return;
  const raw = readFileSync(path, "utf8");
  if (seen === raw) return;
  seen = raw;
  busy = true;
  const task = JSON.parse(raw);
  try {
    const spec = cotalToolSpecs(config).find((entry) => entry.name === task.name);
    if (!spec) throw new Error("tool not advertised: " + task.name);
    const result = await spec.run(mesh, config, parseToolArgs(spec, task.args));
    appendFileSync(join(root, "results.jsonl"), JSON.stringify({ seq: task.seq, result }) + "\n");
  } catch (error) {
    appendFileSync(join(root, "results.jsonl"), JSON.stringify({ seq: task.seq, error: String(error) }) + "\n");
  } finally { busy = false; }
}, 100);
const stop = () => { clearInterval(timer); void mesh.stop().finally(() => process.exit(0)); };
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
