// Real managed process. The file transport only supplies tool requests and records their replies.
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { MeshAgent, configFromEnv, cotalToolSpecs, parseToolArgs } from "@cotal-ai/connector-core";

const config = configFromEnv();
const mesh = new MeshAgent(config);
const root = process.env.STATIC_HELPER_DIR;
const request = join(root, `${config.name}.request.json`);
const result = join(root, `${config.name}.results.jsonl`);
mesh.on("error", error => console.error(error.message));
await mesh.start();
let seen = "", busy = false;
const timer = setInterval(async () => {
  if (busy || !existsSync(request)) return;
  const raw = readFileSync(request, "utf8");
  if (seen === raw) return;
  seen = raw;
  busy = true;
  const task = JSON.parse(raw);
  try {
    const spec = cotalToolSpecs(config).find(s => s.name === task.name);
    if (!spec) throw new Error(`tool not advertised: ${task.name}`);
    const reply = await spec.run(mesh, config, parseToolArgs(spec, task.args));
    appendFileSync(result, JSON.stringify({ seq: task.seq, reply }) + "\n");
  } catch (error) {
    appendFileSync(result, JSON.stringify({ seq: task.seq, error: String(error) }) + "\n");
  } finally { busy = false; }
}, 50);
const stop = () => { clearInterval(timer); void mesh.stop().finally(() => process.exit(0)); };
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
