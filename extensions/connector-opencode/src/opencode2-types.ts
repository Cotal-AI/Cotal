/**
 * The structural subset of the OpenCode 2.x plugin context this adapter reads, declared here
 * rather than imported from `@opencode/plugin` (source: `@opencode/plugin@2.0.18`
 * `dist/promise/{plugin,session,tool,registration}.d.ts`). `@opencode/plugin`'s peers are
 * `solid-js`, `@opentui/*` and `@opencode/theme` — a real dependency would drag those into this
 * bundle for types alone, the same reason `agui-source.ts` declares its own `OpenCodePart` rather
 * than importing the SDK's `Part` union. This file describes what plugin2.ts actually reads, not
 * everything OpenCode 2.x may hand it.
 */

/** One event off `ctx.event.subscribe`. Same shape as `GET /api/event` (measurements.md). */
export interface OpenCode2Event {
  id?: string;
  type: string;
  data?: Record<string, unknown>;
}

export interface OpenCode2EventSubscribe {
  (opts: { signal: AbortSignal }): AsyncIterable<OpenCode2Event>;
}

export interface OpenCode2PromptEvent {
  sessionID: string;
  messageID: string;
  prompt: { text: string };
  metadata?: unknown;
  delivery?: unknown;
}

export interface OpenCode2ModelRequestEvent {
  model: { id: string; providerID: string };
  kind: "primary" | "title";
  agent: string;
}

export interface OpenCode2ToolExecuteBeforeEvent {
  tool: string;
  sessionID: string;
  agent: string;
  messageID: string;
  id: string;
  input: unknown;
}

export interface OpenCode2SessionHooks {
  hook(name: "prompt", fn: (e: OpenCode2PromptEvent) => void | Promise<void>): Promise<void>;
  hook(name: "model.request", fn: (e: OpenCode2ModelRequestEvent) => void | Promise<void>): Promise<void>;
}

export interface OpenCode2ToolEditor {
  add(def: { name: string; description: string; input: unknown; execute(input: unknown): Promise<{ content: string }> }): void;
  list(): Array<{ id: string }>;
}

export interface OpenCode2ToolHooks {
  hook(name: "execute.before", fn: (e: OpenCode2ToolExecuteBeforeEvent) => void | Promise<void>): Promise<void>;
  transform(fn: (ed: OpenCode2ToolEditor) => void | Promise<void>): Promise<void>;
}

/** The 2.x `setup(context)` argument, structurally, restricted to what plugin2.ts reads. */
export interface OpenCode2Context {
  session: OpenCode2SessionHooks;
  tool: OpenCode2ToolHooks;
  event: { subscribe: OpenCode2EventSubscribe };
}
