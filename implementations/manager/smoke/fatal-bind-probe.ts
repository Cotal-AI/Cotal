/**
 * Subprocess probe for the smoke's fatal-bind-on-squat check (section G, win32-only). Tries to start
 * a managed control server (fatalBind) on a pipe a squatter already holds; the bind must fail
 * EADDRINUSE and the process must exit(1). If it somehow binds (regression), we exit(0) after a beat
 * so the parent test sees the wrong code and fails. Argv: <path> <token>.
 */
import { startControlServer, type MeshAgent } from "@cotal-ai/connector-core";

// NB: the token rides argv here only because this is a throwaway TEST probe (a fresh per-run token
// the parent squats around). Real launches pass the token via env ONLY, never argv — see the
// connectors' buildLaunch. Don't copy this argv pattern into a production launch path.
const [path, token] = process.argv.slice(2);
startControlServer({} as unknown as MeshAgent, { path, token }, async () => ({}), { fatalBind: true });
setTimeout(() => process.exit(0), 3000);
