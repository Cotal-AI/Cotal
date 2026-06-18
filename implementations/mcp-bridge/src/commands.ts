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
import type { McpServerSpec } from "./transport.js";
import { runOAuthLogin, DEFAULT_CALLBACK_PORT } from "./oauth.js";
import { c } from "./ui.js";

const OPTIONS = {
  space: { type: "string" },
  server: { type: "string" },
  creds: { type: "string" },
  name: { type: "string" }, // bridge presence name (default "mcp-bridge")
  service: { type: "string" }, // control-plane service peers address (default "mcp")
  "mcp-name": { type: "string" }, // logical server name: tool namespace + OAuth token key
  url: { type: "string" }, // remote MCP server URL (alternative to a stdio `-- <command>`)
  sse: { type: "boolean" }, // use the legacy SSE transport instead of Streamable HTTP
  oauth: { type: "boolean" }, // authenticate with OAuth tokens cached by `login`
  bearer: { type: "string" }, // static bearer token
  header: { type: "string", multiple: true }, // static header(s): "Name: value"
  scope: { type: "string" }, // OAuth scope (login)
  "callback-port": { type: "string" }, // OAuth loopback port (login)
} as const;

/** The space to operate on: explicit `--space`, else this folder's `.cotal/auth` space, else the
 *  default — matching the manager so a manually-run bridge joins the folder's mesh. */
function spaceFor(space?: string): string {
  return space ?? loadSpaceAuth(authDir(findCotalRoot()))?.space ?? DEFAULT_SPACE;
}

/** Merge `--bearer` + `--header "Name: value"` into a headers object (undefined if empty). */
function parseHeaders(list: string[] | undefined, bearer?: string): Record<string, string> | undefined {
  const headers: Record<string, string> = {};
  if (bearer) headers["Authorization"] = `Bearer ${bearer}`;
  for (const item of list ?? []) {
    const i = item.indexOf(":");
    if (i < 0) throw new Error(`bad --header ${JSON.stringify(item)} (use "Name: value")`);
    headers[item.slice(0, i).trim()] = item.slice(i + 1).trim();
  }
  return Object.keys(headers).length ? headers : undefined;
}

/** `cotal mcp-bridge login --url <oauth mcp server>` — interactive OAuth, caches tokens to disk. */
async function runLogin(argv: string[]): Promise<void> {
  const { values } = parseArgs({ args: argv, options: OPTIONS, allowPositionals: false });
  if (!values.url) {
    console.error(c.red("✗ --url <oauth mcp server> is required for login"));
    process.exit(1);
  }
  const service = values["mcp-name"] ?? new URL(values.url).host;
  const port = values["callback-port"] ? Number(values["callback-port"]) : DEFAULT_CALLBACK_PORT;
  try {
    const { tools } = await runOAuthLogin({
      url: values.url,
      service,
      sse: values.sse,
      scope: values.scope,
      callbackPort: port,
    });
    console.log(
      c.green(`✓ authorized ${service}`) +
        c.dim(` — ${tools} tools; tokens cached.`) +
        c.dim(`\n  run: cotal mcp-bridge --url ${values.url} --oauth --mcp-name ${service}`),
    );
  } catch (e) {
    console.error(c.red(`✗ login failed: ${(e as Error).message}`));
    process.exit(1);
  }
}

/**
 * Run an mcp-bridge daemon: connect to one MCP server (stdio or remote) and serve its tools on
 * the "mcp" control service, then block until SIGINT/SIGTERM.
 *
 *   stdio:  cotal mcp-bridge --space demo -- npx -y @modelcontextprotocol/server-everything
 *   remote: cotal mcp-bridge --space demo --url https://host/mcp --oauth
 */
async function runBridge(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true });
  const remote = Boolean(values.url);
  if (remote && positionals.length) {
    console.error(c.red("✗ pass either --url (remote) OR `-- <command>` (stdio), not both"));
    process.exit(1);
  }
  if (!remote && !positionals.length) {
    console.error(
      c.red("✗ give a stdio MCP command after `--`, or a remote server with --url") +
        c.dim("\n  stdio:  cotal mcp-bridge --space demo -- npx -y @modelcontextprotocol/server-everything") +
        c.dim("\n  remote: cotal mcp-bridge --space demo --url https://host/mcp --oauth"),
    );
    process.exit(1);
  }
  const space = spaceFor(values.space);
  const server = values.server ?? DEFAULT_SERVER;
  if (!(await isReachable(server))) {
    console.error(c.red(`Can't reach NATS at ${server}. Run: cotal up`));
    process.exit(1);
  }
  const creds = values.creds ? readFileSync(values.creds, "utf8") : undefined;

  let spec: McpServerSpec;
  if (remote) {
    const url = values.url as string;
    spec = {
      name: values["mcp-name"] ?? new URL(url).host,
      url,
      sse: values.sse,
      headers: parseHeaders(values.header, values.bearer),
      oauth: values.oauth,
    };
  } else {
    const [command, ...args] = positionals;
    spec = { name: values["mcp-name"] ?? basename(command), command, args };
  }

  const bridge = new McpBridge({
    space,
    servers: server,
    creds,
    name: values.name,
    service: values.service,
    mcp: [spec],
  });
  try {
    await bridge.start();
  } catch (e) {
    console.error(c.red(`✗ ${(e as Error).message}`));
    process.exit(1);
  }
  console.log(
    c.green("✓ mcp-bridge up") +
      c.dim(` (space ${space} · ${bridge.catalog.length} tools on service "${values.service ?? "mcp"}")`) +
      c.dim("\n  peers: cotal_tools to list · cotal_tool to call   (Ctrl-C to shut down)"),
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
    "bridge an MCP server's tools onto the mesh as a shared service — " +
    "stdio: `-- <cmd> [args]`; remote: `--url <u> [--oauth | --bearer <t>]`; `login` for OAuth",
  run: (argv) => (argv[0] === "login" ? runLogin(argv.slice(1)) : runBridge(argv)),
};

registry.register(mcpBridgeCommand);
