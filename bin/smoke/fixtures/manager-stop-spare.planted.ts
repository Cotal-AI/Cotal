// Planted positive control for smoke:manager-stop-spare-guard. Not imported.
// A live-PTY Manager smoke that spare-stops: the regex must see this, or a
// zero hit count in the real tree would mean nothing.
import { Manager } from "../src/manager.js";

const manager = new Manager({ space: "planted", runtime: "pty", workspaceRoot: "/tmp/planted" });
await manager.start();
await manager.startAgent({ name: "leak", agent: "seatcon" });
await manager?.stop().catch(() => {});
