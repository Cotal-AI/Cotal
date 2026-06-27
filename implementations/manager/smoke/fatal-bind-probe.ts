/**
 * Subprocess probe for the smoke's fatal-bind-on-squat check (section G, win32-only). Tries to start
 * a managed control server (fatalBind) on a pipe a squatter already holds; the bind must fail
 * EADDRINUSE and the process must exit(1). If it somehow binds (regression), we exit(0) after a beat
 * so the parent test sees the wrong code and fails. Argv: <path> <token>.
 */
import { startControlServer, type MeshAgent } from "@cotal-ai/connector-core";

const [path, token] = process.argv.slice(2);
startControlServer({} as unknown as MeshAgent, { path, token }, async () => ({}), { fatalBind: true });
setTimeout(() => process.exit(0), 3000);
