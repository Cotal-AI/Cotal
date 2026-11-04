import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { isMainEntry } from "./main-entry.mjs";

// Keep this group leader alive until the owner terminates the group, even when the client
// exits before an ignored-stdio descendant. No client inherits the supervisor's IPC channel.
if (isMainEntry(import.meta.url)) {
  assert(process.send && process.connected, "publication supervisor needs its owner's IPC channel");
  const stop = () => { process.kill(-process.pid, "SIGKILL"); };
  process.on("disconnect", stop);
  process.once("message", ({ file, args }) => {
    assert(typeof file === "string" && Array.isArray(args) && args.every((arg) => typeof arg === "string"), "invalid publication client request");
    const env = { ...process.env };
    delete env.NODE_CHANNEL_FD;
    delete env.NODE_CHANNEL_SERIALIZATION_MODE;
    const child = spawn(file, args, { env, stdio: "inherit" });
    let sent = false;
    const result = (status, signal, error) => {
      if (sent) return;
      sent = true;
      process.send({ type: "result", pid: process.pid, status, signal, error: error && { message: error.message, code: error.code } }, (failure) => { if (failure) stop(); });
    };
    child.once("error", (error) => result(null, null, error));
    child.once("exit", (status, signal) => result(status, signal));
  });
}
