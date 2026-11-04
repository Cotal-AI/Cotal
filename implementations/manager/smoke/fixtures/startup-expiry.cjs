const { appendFileSync } = require("node:fs");
const [sink, mode] = process.argv.slice(2);
let stopping = false;
const record = (event) => appendFileSync(sink, JSON.stringify(event) + "\n");
process.stdin.setRawMode(true);
process.stdin.resume();
process.stdin.on("data", (chunk) => record({ kind: "input", stopping, bytes: [...chunk] }));
process.on("SIGTERM", () => {
  stopping = true;
  record({ kind: "stop" });
  if (mode === "late") process.stdout.write("Enter to confirm\r\n");
});
record({ kind: "ready" });
if (mode === "early") process.stdout.write("Enter to confirm\r\n");
setInterval(() => {
  if (mode === "early") process.stdout.write("Enter to confirm\r\n");
}, 1000);
