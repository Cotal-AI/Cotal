import { listenOwnerPipe, startProcess } from "./hermes-windows-host.js";

// Private handoff to the Hermes launcher. The CLI chooses the preload; the connector consumes
// functions without resolving any CLI path or native package. Change the key if the shape changes.
Object.defineProperty(globalThis, Symbol.for("cotal.hermes.windows-host.v1"), {
  value: Object.freeze({ startProcess, listenOwnerPipe }),
});
