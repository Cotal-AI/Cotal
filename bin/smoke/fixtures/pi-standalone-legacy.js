import { createRequire as __cotalCreateRequire } from 'node:module'; const require = __cotalCreateRequire(import.meta.url);
// Signature and export layout from the published @cotal-ai/pi 0.111.0 standalone bundle.
var RUNTIMES = /* @__PURE__ */ Symbol.for("cotal.pi.runtimes");
function cotalMesh() {
  throw new Error(`Pi must not execute a discovered standalone copy (${String(RUNTIMES)})`);
}
export {
  cotalMesh as default
};
