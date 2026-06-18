import { parseArgs } from "node:util";
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import {
  isReachable,
  DEFAULT_SERVER,
  DEFAULT_SPACE,
  authDir,
  findCotalRoot,
  loadSpaceAuth,
  registry,
  type Command,
} from "@cotal-ai/core";
import { McpBridge } from "./bridge.js";

const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;

/** The space to operate on: explicit `--space`, else this folder's `.cotal/auth` space, else the
 *  default — matching the manager so a manually-run bridge joins the folder's mesh. */
function spaceFor(space?: string): string {
  return space ?? loadSpaceAuth(authDir(findCotalRoot()))?.space ?? DEFAULT_SPACE;
}

/**
 * Run an mcp-bridge daemon: connect to one external MCP server and serve its tools on the
 * "mcp" control service, then block until SIGINT/SIGTERM.
 *
 * The MCP server command + its args are the positionals after `--`, e.g.
 *   cotal mcp-bridge --space demo -- npx -y @modelcontextprotocol/server-everything
 */
async function runBridge(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      space: { type: "string" },
      server: { type: "string" },
      creds: { type: "string" },
      name: { type: "string" },
      service: { type: "string" },
      "mcp-name": { type: "string" },
    },
  });
  if (!positionals.length) {
    console.error(
      red("✗ give the MCP server command after `--`") +
        dim("\n  e.g. cotal mcp-bridge --space demo -- npx -y @modelcontextprotocol/server-everything"),
    );
    process.exit(1);
  }
  const space = spaceFor(values.space);
  const server = values.server ?? DEFAULT_SERVER;
  if (!(await isReachable(server))) {
    console.error(red(`Can't reach NATS at ${server}. Run: cotal up`));
    process.exit(1);
  }
  const creds = values.creds ? readFileSync(values.creds, "utf8") : undefined;
  const [command, ...args] = positionals;
  const bridge = new McpBridge({
    space,
    servers: server,
    creds,
    name: values.name,
    service: values.service,
    mcp: [{ name: values["mcp-name"] ?? basename(command), command, args }],
  });
  await bridge.start();
  console.log(
    green("✓ mcp-bridge up") +
      dim(` (space ${space} · ${bridge.catalog.length} tools on service "${values.service ?? "mcp"}")`) +
      dim("\n  peers: cotal_tools to list · cotal_tool to call   (Ctrl-C to shut down)"),
  );
  const shutdown = () => void bridge.stop().then(() => process.exit(0));
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  await new Promise<void>(() => {});
}

const mcpBridgeCommand: Command = {
  kind: "command",
  name: "mcp-bridge",
  group: "Manager",
  summary:
    "bridge an external MCP server's tools onto the mesh as a shared service — " +
    "[--space <s>] [--server <url>] [--service <name>] -- <mcp-command> [args…]",
  run: runBridge,
};

registry.register(mcpBridgeCommand);
