#!/usr/bin/env node
/**
 * Composition root for the `cotal` operator CLI, published as `cotal-ai`. Importing an
 * implementation self-registers its commands into the shared registry — base mesh commands
 * plus `spawn`/`console` (@cotal-ai/cli) and the manager's control plane + daemon runners
 * (@cotal-ai/manager). The root just picks which surfaces to pull in; `runCli` resolves
 * whatever registered. A new surface (another connector, a control client …) is one more import line.
 */
import { runCli } from "@cotal-ai/cli"; // self-registers up / down / join / watch / spawn / console / setup
import "@cotal-ai/manager"; // self-registers supervise / cmux / start / stop / ps / attach
import "@cotal-ai/mcp-bridge"; // self-registers mcp-bridge (external MCP tools as a shared mesh service)
import "@cotal-ai/connector-claude-code"; // registers the `claude` connector that spawn / start resolve
import "@cotal-ai/connector-opencode"; // registers the `opencode` connector (native in-process plugin)
import "@cotal-ai/connector-hermes"; // registers the `hermes` connector (Nous Research gateway as a mesh peer)
import "@cotal-ai/cmux"; // opt into the cmux integration — registers the `cmux` runtime + TerminalLayout providers
import { claudeConnector } from "@cotal-ai/connector-claude-code";
import { registry } from "@cotal-ai/core";

// The manager's default agent type is "cotal"; make it a real Claude coder so a bare
// cotal_spawn / `cotal start --name x` (no --agent) brings up a Claude Code session.
registry.register({ ...claudeConnector, name: "cotal" });

// Bare `npx cotal-ai` = guided first-run setup; any argument dispatches as usual.
const argv = process.argv.length > 2 ? process.argv.slice(2) : ["setup"];
await runCli(registry, argv);
