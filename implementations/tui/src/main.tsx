import { flushCompileCache } from "node:module"
import { createCliRenderer } from "@opentui/core"
import { render } from "@opentui/solid"
import { Config, ConfigProvider } from "../vendor/opencode/packages/tui/src/config"
import { ClipboardProvider } from "../vendor/opencode/packages/tui/src/context/clipboard"
import { Keymap } from "../vendor/opencode/packages/tui/src/context/keymap"
import { ThemeProvider } from "../vendor/opencode/packages/tui/src/context/theme"
import { DialogProvider } from "../vendor/opencode/packages/tui/src/ui/dialog"
import { Toast, ToastProvider } from "../vendor/opencode/packages/tui/src/ui/toast"
import { Shell } from "./app.js"

// A terminal that answers the theme query does so within a few milliseconds. tmux and some others
// never answer, so the wait is bounded and the shell starts dark. A late answer still switches the
// theme, because ThemeProvider follows the renderer's theme_mode event.
const THEME_QUERY_MS = 60
const DEFAULT_THEME_MODE = "dark"

const clipboard = {
  read: async () => {
    throw new Error("the clipboard is not wired in the shell yet")
  },
  write: async () => {
    throw new Error("the clipboard is not wired in the shell yet")
  },
}

const renderer = await createCliRenderer({ targetFps: 60, exitOnCtrlC: false, autoFocus: false, openConsoleOnError: true, useKittyKeyboard: {} })
renderer.once("destroy", () => process.exit(0))
const mode = (await renderer.waitForThemeMode(THEME_QUERY_MS)) ?? DEFAULT_THEME_MODE
const config = Config.resolve({}, { terminalSuspend: false })

// The catalog module imports @cotal-ai/workspace, the largest import in the app. Reading it only
// after the first frame keeps that cost off the time to a visible shell.
const readCatalog = async () => {
  await renderer.idle()
  const { readCatalog } = await import("./catalog.js")
  const catalog = readCatalog()
  // Node writes its compile cache at a clean exit, and a closed terminal ends the app with a signal.
  flushCompileCache()
  return catalog
}

const openSpace = async (space?: string) => {
  await renderer.idle()
  const { openSpace } = await import("./live.js")
  return openSpace(space)
}

await render(
  () => (
    <ClipboardProvider value={clipboard}>
      <ConfigProvider config={config}>
        <Keymap.Provider>
          <ToastProvider>
            <ThemeProvider mode={mode} source={{ discover: async () => ({}) }}>
              <DialogProvider>
                <Shell quit={() => renderer.destroy()} readCatalog={readCatalog} openSpace={openSpace} />
              </DialogProvider>
              <Toast />
            </ThemeProvider>
          </ToastProvider>
        </Keymap.Provider>
      </ConfigProvider>
    </ClipboardProvider>
  ),
  renderer,
)
