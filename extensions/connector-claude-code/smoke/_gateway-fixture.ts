/** The local plugin server's gateway in a child process, for live suites that must crash or restart
 * it. It serves the same stdio surface and shutdown as `mcp.ts`; native binding is a fixture input. */
import { serveGatewayStdio } from "@cotal-ai/connector-core";
import { createAppHost } from "../src/app-host.js";

export async function serveFixtureGateway(o: { cli: string[]; cwd: string; sessions: Array<{ session: string; path: string }> }): Promise<void> {
  const host = createAppHost({ cotal: () => o.cli, cwd: o.cwd, env: process.env });
  for (const { session, path } of o.sessions)
    await host.nativeEvent({ hook_event_name: "SessionStart", session_id: session, transcript_path: path, source: "startup", cwd: o.cwd });
  const served = await serveGatewayStdio(host, { source: "claude-local", connectContext: true });
  let ending: Promise<void> | undefined;
  const end = () => (ending ??= host.closeAll().then(() => served.close()).finally(() => process.exit(0)));
  process.stdin.on("end", end);
  process.on("SIGTERM", end);
}
