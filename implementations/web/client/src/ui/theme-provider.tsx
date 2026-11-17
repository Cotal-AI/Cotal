// shadcn's theme provider for Vite (https://ui.shadcn.com/docs/dark-mode/vite), with three changes,
// each marked where it is made: storage is read and written inside try, the root element already
// carries the class when this first runs, and System follows the OS setting as it changes.
import { createContext, useContext, useEffect, useState } from "react"
import { THEMES, type Theme } from "../lib/theme.js"

type ThemeProviderProps = {
  children: React.ReactNode
  defaultTheme?: Theme
  storageKey?: string
}

type ThemeProviderState = {
  theme: Theme
  setTheme: (theme: Theme) => void
}

const initialState: ThemeProviderState = {
  theme: "system",
  setTheme: () => null,
}

const ThemeProviderContext = createContext<ThemeProviderState>(initialState)

export function ThemeProvider({
  children,
  defaultTheme = "system",
  storageKey = "vite-ui-theme",
  ...props
}: ThemeProviderProps) {
  // Change 1: a browser that blocks storage throws on any use of `localStorage`, so reading it falls
  // back to the default and saving it does nothing, where the doc's version would crash the page.
  const [theme, setTheme] = useState<Theme>(() => {
    try {
      return THEMES.find((t) => t === localStorage.getItem(storageKey)) ?? defaultTheme
    } catch {
      return defaultTheme
    }
  })

  useEffect(() => {
    const root = window.document.documentElement
    // Change 2 is made before this runs: the build's theme-boot.js (lib/themeBoot.ts) puts the saved
    // choice's class on the root element before the stylesheet draws, so the page never flashes the
    // other theme while React starts, and this effect finds the right class already there.
    const apply = () => {
      root.classList.remove("light", "dark")

      if (theme === "system") {
        const systemTheme = window.matchMedia("(prefers-color-scheme: dark)")
          .matches
          ? "dark"
          : "light"

        root.classList.add(systemTheme)
        return
      }

      root.classList.add(theme)
    }

    apply()
    // Change 3: while the choice is System, follow the OS setting when it changes, as next-themes does
    // with `enableSystem`, where the doc's version reads it once.
    if (theme !== "system") return
    const media = window.matchMedia("(prefers-color-scheme: dark)")
    media.addEventListener("change", apply)
    return () => media.removeEventListener("change", apply)
  }, [theme])

  const value = {
    theme,
    setTheme: (theme: Theme) => {
      try {
        localStorage.setItem(storageKey, theme)
      } catch {
        // Change 1 again: with storage blocked the choice lasts until the page closes.
      }
      setTheme(theme)
    },
  }

  return (
    <ThemeProviderContext.Provider {...props} value={value}>
      {children}
    </ThemeProviderContext.Provider>
  )
}

export const useTheme = () => {
  const context = useContext(ThemeProviderContext)

  if (context === undefined)
    throw new Error("useTheme must be used within a ThemeProvider")

  return context
}
