// Imported inside the built worker, where no TypeScript loader is required.
export function createHandler(config) {
  if (config.native) throw new TypeError("probe-x");
  throw config.value;
}
