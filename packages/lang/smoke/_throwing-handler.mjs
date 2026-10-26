// Imported inside the built worker, where the suite's TypeScript loader need not reach.
export function createHandler(config) {
  const error = new Error("original message");
  error.name = "ForeignError";
  error.message = config.message;
  throw error;
}
