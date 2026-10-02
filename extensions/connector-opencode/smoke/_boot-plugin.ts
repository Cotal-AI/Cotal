import { cotal } from "../src/plugin.js";
import { setupCotal } from "../src/plugin2.js";
import type { OpenCode2Context, OpenCode2Event, OpenCode2ToolEditor } from "../src/opencode2-types.js";

/** Boot the plugin the way its implementation is written.
 *
 *  `cotal` carries opencode's `Plugin` type, `(input: PluginInput, options?) => Promise<Hooks>`, but
 *  the implementation declares no parameters at all: it reads its whole configuration from the
 *  environment (`configFromEnv`), so a smoke that hands it a fabricated `PluginInput` would be
 *  asserting a structure nothing reads. The smokes boot it with no host input, and this is the one
 *  place that says so: the day the plugin starts reading `input`, this helper is what has to grow a
 *  real one, and every smoke picks the change up together. */
export const bootPlugin = cotal as () => ReturnType<typeof cotal>;

/** A fake OpenCode 2.x plugin context, for smokes that drive `setupCotal` with no opencode process
 *  and no real HTTP server behind it — only the fake server the smoke itself runs. `session.hook`,
 *  `tool.hook` and `permission.hook` each just record `(name, cb)`; `tool.transform` calls the
 *  handler with an editor whose `add` records every tool definition; `event.subscribe` returns an
 *  async generator the test feeds one event at a time with `feed()`, ended with `end()`. */
export interface FakeOpenCode2Context extends OpenCode2Context {
  sessionHooks: Map<string, (e: never) => void | Promise<void>>;
  toolHooks: Map<string, (e: never) => void | Promise<void>>;
  permissionHooks: Map<string, (e: never) => void | Promise<void>>;
  addedTools: Parameters<OpenCode2ToolEditor["add"]>[0][];
  feed(ev: OpenCode2Event): void;
  end(): void;
}

export function fakeOpenCode2Context(): FakeOpenCode2Context {
  const sessionHooks = new Map<string, (e: never) => void | Promise<void>>();
  const toolHooks = new Map<string, (e: never) => void | Promise<void>>();
  const permissionHooks = new Map<string, (e: never) => void | Promise<void>>();
  const addedTools: Parameters<OpenCode2ToolEditor["add"]>[0][] = [];
  const pending: OpenCode2Event[] = [];
  let wake: (() => void) | undefined;
  let ended = false;

  async function* events(): AsyncGenerator<OpenCode2Event> {
    while (!ended) {
      if (pending.length) {
        yield pending.shift()!;
        continue;
      }
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
    }
  }

  return {
    sessionHooks,
    toolHooks,
    permissionHooks,
    addedTools,
    session: {
      async hook(name: string, fn: (e: never) => void | Promise<void>) {
        sessionHooks.set(name, fn);
      },
    },
    tool: {
      async hook(name: string, fn: (e: never) => void | Promise<void>) {
        toolHooks.set(name, fn);
      },
      async transform(fn: (ed: OpenCode2ToolEditor) => void | Promise<void>) {
        await fn({
          add: (def) => addedTools.push(def),
          list: () => addedTools.map((t) => ({ id: t.name })),
        });
      },
    },
    permission: {
      async hook(name: string, fn: (e: never) => void | Promise<void>) {
        permissionHooks.set(name, fn);
      },
    },
    event: { subscribe: () => events() },
    feed(ev: OpenCode2Event) {
      pending.push(ev);
      const w = wake;
      wake = undefined;
      w?.();
    },
    end() {
      ended = true;
      const w = wake;
      wake = undefined;
      w?.();
    },
  } as FakeOpenCode2Context;
}

export const bootPlugin2 = setupCotal;
