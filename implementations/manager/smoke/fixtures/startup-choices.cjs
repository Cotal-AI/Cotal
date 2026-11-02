const fs = require("node:fs");
const path = require("node:path");
const [file, mode] = process.argv.slice(2);
// Claude 2.1.301's raw input screen, for a harness that skips the final prompt.
// Replaying a capture must not repeat device probes on every terminal reply. Keep the paints,
// but omit the capability queries that a live Claude process handles itself.
const READY = fs.readFileSync(path.join(__dirname, "claude-2.1.301-ready.bin"), "utf8")
  .replace(/\x1b\[(?:>0q|\?u|c)|\x1b\]7501;\?\x07/g, "");
let phase = { trusted: "final", "ready-trusted": "ready", unknown: "unknown", notice: "final", silent: "final", "notice-early": "final", "ready-notice": "ready" }[mode] ?? "trust";
// Claude 2.1.314's banner for an admitted channel server, as it paints it after the prompt.
const NOTICE = "Channels (experimental) messages from server:cotal inject directly in this session · restart without --dangerously-load-development-channels to stop";
let yes = false;
const render = () => {
  let screen;
  if (phase === "trust") screen = `Accessing workspace:\n/tmp/WARNING: Loading development channels\n${yes ? "  No, exit\n❯ Yes, I trust this folder" : "❯ No, exit\n  Yes, I trust this folder"}`;
  else if (phase === "missing") screen = "Tool approval: Allow Bash? Enter to confirm";
  else if (phase === "ready") return process.stdout.write(`\x1b[2J\x1b[H${READY}`);
  else if (phase === "unknown") screen = "WARNING: Claude Code running in Bypass Permissions mode\n❯ 1. No, exit\n  2. Yes, I accept";
  else if (phase === "done") screen = `❯ No, exit\n  Yes, I trust this folder\nWARNING: Loading development channels${mode === "notice" || mode === "notice-early" ? `\n${NOTICE}` : ""}`;
  // A notice already on the prompt's own screen is not one Claude printed after the answer.
  else screen = `WARNING: Loading development channels\nEnter to confirm${mode === "notice-early" ? `\n${NOTICE}` : ""}`;
  process.stdout.write(`\x1b[2J\x1b[H${screen}\n`);
};
process.stdin.setRawMode(true);
process.stdin.resume();
process.stdin.on("data", (data) => {
  const value = data.toString();
  for (const key of value.match(/\x1b\[B|\r|[^\r]+/g) ?? []) {
    fs.appendFileSync(file, `${JSON.stringify({ key: key === "\x1b[B" ? "Down" : key === "\r" ? "Enter" : key, phase })}\n`);
    if (phase === "trust" && key === "\x1b[B") yes = true;
    else if (phase === "trust" && key === "\r") {
      if (!yes) process.exit(1);
      phase = mode === "missing" ? "missing" : mode === "ready" ? "ready" : "final";
    } else if (phase === "final" && key === "\r") phase = "done";
    render();
  }
});
render();
