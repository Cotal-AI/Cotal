/**
 * A worker entry that speaks a message kind the host does not know, ON PURPOSE.
 *
 * The host's message handler had one branch for `log` and treated EVERYTHING ELSE as the run's
 * answer, so a thread posting anything unexpected resolved the run with `undefined` and the real
 * result arrived after nobody was listening. That is reachable only from a thread, which is why the
 * probe is a thread: the entry is an input to `runInWorker`, so a suite can hand it this one.
 */

import { parentPort } from "node:worker_threads";

parentPort.postMessage({ kind: "trace", line: { scope: "", values: [] } });
parentPort.postMessage({ kind: "result", result: { ok: false, name: "Probe", message: "the real answer" } });
