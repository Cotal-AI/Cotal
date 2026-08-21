import { runJcodeHost } from "./host.js";

runJcodeHost().catch((error) => {
  const err = error as Error;
  const stack = err.stack?.split("\n").slice(1).join("\n");
  if (stack?.trim()) process.stderr.write(`${stack}\n`);
  process.stderr.write(`[cotal-jcode] fatal: ${err.message || String(error)}\n`);
  process.exit(1);
});
