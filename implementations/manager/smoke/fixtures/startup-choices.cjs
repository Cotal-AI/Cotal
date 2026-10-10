const fs = require("node:fs");
const [file, mode] = process.argv.slice(2);
let phase = mode === "trusted" ? "final" : "trust";
let yes = false;
const render = () => {
  let screen;
  if (phase === "trust") screen = `Accessing workspace:\n/tmp/WARNING: Loading development channels\n${yes ? "  No, exit\n❯ Yes, I trust this folder" : "❯ No, exit\n  Yes, I trust this folder"}`;
  else if (phase === "missing") screen = "Tool approval: Allow Bash? Enter to confirm";
  else if (phase === "done") screen = "❯ No, exit\n  Yes, I trust this folder\nWARNING: Loading development channels";
  else screen = "WARNING: Loading development channels\nEnter to confirm";
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
      phase = mode === "missing" ? "missing" : "final";
    } else if (phase === "final" && key === "\r") phase = "done";
    render();
  }
});
render();
