// Makes this Node report a version below the seat entry's floor, so the refusal can be driven on
// the Node that CI actually runs. v22.9.0 is the last release with no `flushCompileCache`.
Object.defineProperty(process.versions, "node", { value: "22.9.0", configurable: true });
