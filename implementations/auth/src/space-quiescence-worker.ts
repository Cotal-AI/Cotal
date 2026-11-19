import { isMainThread, parentPort } from "node:worker_threads";
import { observeSpaceQuiescenceInWorker, type SpaceQuiescenceOptions } from "./space-quiescence.js";

if (isMainThread || !parentPort) throw new Error("space quiescence worker requires an owning host");
const port = parentPort;
port.once("message", async (opts: SpaceQuiescenceOptions) => {
  port.postMessage(await observeSpaceQuiescenceInWorker(opts));
  port.close();
});
