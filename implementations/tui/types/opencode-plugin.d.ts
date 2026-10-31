// The keymap types vendor/opencode/packages/tui/src/context/keymap.tsx imports with `import type`
// from OpenCode's plugin package. Copied from packages/plugin/src/tui/context.ts at the commit in
// scripts/upstream.mjs, under the MIT license in vendor/opencode/LICENSE. Only the typecheck reads
// this file: Babel erases the import, so the build never needs the rest of that package.
declare module "@opencode/plugin/tui/context" {
  import type { KeyEvent, Renderable } from "@opentui/core"

  export interface KeymapCommand {
    /** Stable command and config keybind identifier. Omit for an inline command. */
    readonly id?: string
    /** Optional label used by command discovery and keyboard-help UI. */
    readonly title?: string
    /** Optional longer description. */
    readonly description?: string
    /** Groups the command in discovery and keyboard-help UI. */
    readonly group?: string
    /** Enables or disables the command. */
    readonly enabled?: boolean | (() => boolean)
    /** Configures automatic binding, or disables it for a named command. */
    readonly bind?: false | string
    /** Adds a named command to the command palette. */
    readonly palette?: true
    /** Adds a named command to prompt slash completion. */
    readonly slash?: {
      readonly name: string
      readonly aliases?: string[]
      /** Keeps the slash command in the prompt and passes its raw input to run. */
      readonly arguments?: true
    }
    /** Promotes the command in discovery UI. */
    readonly suggested?: boolean | (() => boolean)
    /** Executes the command. Keyboard dispatch includes its event; programmatic dispatch does not. Return false to continue. */
    readonly run: (input?: string, event?: KeyEvent) => void | false | Promise<void>
  }

  export interface KeymapLayer {
    /** Limits the layer to one OpenCode input mode. Use global to opt out; defaults to base. */
    readonly mode?: string
    /** Enables or disables the complete layer. */
    readonly enabled?: boolean | (() => boolean)
    /** Limits the layer to a focused renderable. */
    readonly target?: () => Renderable | null | undefined
    /** Resolves conflicts with other active layers. */
    readonly priority?: number
    /** Commands owned by this layer. */
    readonly commands?: readonly KeymapCommand[]
    /** IDs of commands whose configured bindings should be active in this layer. */
    readonly bindings?: readonly string[]
  }

  export interface KeymapPending {
    readonly key: string
    readonly token?: string
  }

  export interface KeymapActive {
    readonly key: string
    readonly title?: string
    readonly description?: string
    readonly group?: string
    readonly continues: boolean
  }
}
