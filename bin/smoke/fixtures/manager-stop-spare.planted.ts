// Planted positive control for smoke:manager-stop-spare-guard. Not imported.
// A live-PTY Manager smoke that spare-stops: the regex must see this, or a
// zero hit count in the real tree would mean nothing.
// Still compiled: `bin/tsconfig.smoke.json` typechecks every `**/*.ts` under bin/,
// including fixtures nothing imports. tsx never sees this file, so a green
// guard run is not a compile proof. Use the workspace package, not a relative
// path that would resolve to the nonexistent `bin/src/manager.js`.
import { Manager } from "@cotal-ai/manager";

const manager = new Manager({ space: "planted", runtime: "pty", workspaceRoot: "/tmp/planted" });
await manager.start();
await manager.startAgent({ name: "leak", agent: "seatcon" });
await manager?.stop().catch(() => {});
