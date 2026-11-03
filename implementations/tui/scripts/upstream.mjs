// The OpenCode commit the vendored files come from, and the files the shell imports from it.
// vendor.mjs copies the seeds plus every file they import at COMMIT, so this list names only what
// Cotal code uses directly.
export const REPO = "https://github.com/anomalyco/opencode.git"
export const COMMIT = "9425a65eb358e06221e4982d5620c50fbd86a1dd"

export const SEEDS = [
  "packages/tui/src/config/index.tsx",
  "packages/tui/src/context/clipboard.tsx",
  "packages/tui/src/context/keymap.tsx",
  "packages/tui/src/context/theme.tsx",
  "packages/tui/src/ui/dialog.tsx",
  "packages/tui/src/ui/dialog-select.tsx",
  "packages/tui/src/ui/toast.tsx",
]

// Copied as is, never imported.
export const NOTICES = ["LICENSE"]

// Non-relative specifiers inside the vendored files that name another vendored file. The typecheck
// mirrors them in tsconfig.json "paths".
export const ALIASES = {
  "#string-width": "packages/tui/src/util/string-width.node.ts",
  "@opencode/schema/vcs": "packages/schema/src/vcs.ts",
  "@opencode/theme/tui": "packages/theme/src/tui/index.ts",
  "@opencode/theme/tui/v1": "packages/theme/src/tui/v1.ts",
  "@opencode/util/duration": "packages/util/src/duration.ts",
  "@opencode/util/flock": "packages/util/src/flock.ts",
}

// Type-only specifiers that types/opencode-plugin.d.ts declares instead, because following them would
// vendor OpenCode's client types. Babel erases these imports, so the build never needs them.
export const TYPE_SHIMS = ["@opencode/plugin/tui/context"]
