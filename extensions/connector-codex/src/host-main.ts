import { runCodexHost } from "./host.js";

runCodexHost().catch((e) => {
  const err = e as Error;
  // Order matters, and only for one reason: the LAST line is what a detached operator sees. The
  // manager reports a failed launch as "<name> exited on launch - last output: <last line>", and
  // then reaps the agent, so `cotal attach` is already gone by the time they read it. Ending on
  // the stack would hand them `at …/host.js:1234`, when the actual cause is something they can
  // act on — no credentials, no codex on PATH, a tool server that never came up. So: stack first
  // for whoever reads the whole log, the cause LAST for whoever gets one line.
  const stack = err.stack?.split("\n").slice(1).join("\n");
  if (stack?.trim()) process.stderr.write(`${stack}\n`);
  process.stderr.write(`[cotal-codex] fatal: ${err.message || String(e)}\n`);
  process.exit(1);
});
