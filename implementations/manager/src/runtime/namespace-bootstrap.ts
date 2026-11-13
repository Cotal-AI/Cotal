import { readFileSync } from "node:fs";
import { createConnection } from "node:net";

// This process is namespace PID1. It executes no connector code before the host accepts
// kernel custody. The launcher supplies a minimal environment, never the connector's env.
const [configPath] = process.argv.slice(2);
if (!configPath || typeof process.execve !== "function") throw new Error("namespace bootstrap requires process.execve");
const config = JSON.parse(readFileSync(configPath, "utf8")) as {
  socket: string; nonce: string; command: string; args: string[]; env: Record<string, string>;
};
if (typeof config.socket !== "string" || typeof config.nonce !== "string" ||
    typeof config.command !== "string" || !config.command.startsWith("/") || !Array.isArray(config.args) ||
    config.args.some((value) => typeof value !== "string" || value.includes("\0")) ||
    !config.env || typeof config.env !== "object" || Object.entries(config.env).some(([k, v]) =>
      k.includes("=") || k.includes("\0") || typeof v !== "string" || v.includes("\0"))) {
  throw new Error("invalid namespace bootstrap configuration");
}
const socket = createConnection(config.socket);
const timer = setTimeout(() => { socket.destroy(); process.exitCode = 1; }, 10_000);
socket.once("connect", () => socket.write(`${config.nonce}\n`));
let reply = "";
socket.on("data", (chunk) => {
  reply += chunk.toString("utf8");
  if (reply.length > 2 || !"+\n".startsWith(reply)) { socket.destroy(); process.exitCode = 1; return; }
  if (reply !== "+\n") return;
  clearTimeout(timer);
  socket.destroy();
  process.execve!(config.command, [config.command, ...config.args], config.env);
});
socket.on("error", () => { clearTimeout(timer); process.exitCode = 1; });
socket.on("close", () => { clearTimeout(timer); if (reply !== "+\n") process.exitCode = 1; });
