/** The types every Cotal tool spec is written against, and the two result constructors the spec
 *  modules share. It imports nothing from the spec modules. */
import type { z } from "zod";
import type { MeshAgent } from "./agent.js";
import type { AgentConfig } from "./config.js";

/** What a Cotal tool returns: text to show the model, flagged on failure. MCP wraps it in
 *  `content`; the OpenCode plugin returns the string. `structured` is the same answer as data for
 *  hosts that show a tool's structured content in place of its text, so it repeats the text. */
export interface ToolResult {
  text: string;
  isError?: boolean;
  structured?: Record<string, unknown>;
}

export const ok = (text: string): ToolResult => ({ text });
export const err = (text: string): ToolResult => ({ text, isError: true });

/** A tool's input contract: a **CLOSED** Zod object. Closed is the whole point — an unknown
 *  top-level key is REFUSED, never stripped.
 *
 *  A plain `z.object` DROPS unknown keys, so a caller-supplied `owner`/`actor`/`caller` argument
 *  vanished silently and the tool ran as if it had never been sent. That is not a refusal; it is a
 *  refusal-shaped absence, and it is indistinguishable from the argument having been rejected. The
 *  identity a tool acts under comes from the connector's own credential and never from a tool
 *  argument, and an attempt to supply one must be visibly turned away rather than quietly ignored. */
export type CotalToolInput = z.ZodObject<z.ZodRawShape>;

/** One Cotal tool, independent of any host's tool API. */
export interface CotalToolSpec {
  name: string;
  title: string;
  description: string;
  /** The CLOSED input object — see {@link CotalToolInput}. **Always present**, empty for a
   *  no-argument tool: a tool that takes nothing still takes nothing *closed*, or `{owner, actor}`
   *  on `cotal_roster` is swallowed by the very hole this type exists to shut. Adapters render from
   *  THIS; none of them re-derives an open object, and none of them can, because
   *  {@link cotalToolSpecs} is the only source and it closes every shape on the way out. */
  schema: CotalToolInput;
  run(agent: MeshAgent, config: AgentConfig, args: any, call?: ToolCall): Promise<ToolResult> | ToolResult;
}

/** What a surface knows about the request a tool runs for. */
export interface ToolCall {
  /** Aborts when the caller can no longer receive the result. A read that finds it aborted clears
   *  nothing, so the messages stay for the next read. */
  signal?: AbortSignal;
}

/** How a tool is AUTHORED: a raw shape, which reads better inline than a wrapped object, and
 *  omitted entirely by a tool that takes no arguments. The closing happens once, in
 *  {@link cotalToolSpecs} — including the empty case, so "no arguments" and "any arguments" cannot
 *  be confused by an author's omission. */
export interface CotalToolSpecDecl extends Omit<CotalToolSpec, "schema"> {
  schema?: z.ZodRawShape;
}
