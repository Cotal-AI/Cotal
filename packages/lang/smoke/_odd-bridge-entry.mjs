/**
 * A worker entry that speaks a BRIDGE message the host does not expect, ON PURPOSE (#3216).
 *
 * The bridge's listener runs on the host's own stack, so a throw there was an uncaught exception
 * that ended the whole host process and every run on it. Measured: an in-place upgrade under a live
 * manager handed a new thread an old host's bridge, and the manager died on the first new kind. The
 * run id picks the message; the thread then never answers, so the run ends only if the host
 * refuses it.
 */

import { workerData } from "node:worker_threads";

const { request, bridge } = workerData;
bridge.port.postMessage(request.runId === "odd-bind" ? { kind: "bind-answer", bseq: 99 } : { kind: "hello" });
setInterval(() => {}, 1_000);
