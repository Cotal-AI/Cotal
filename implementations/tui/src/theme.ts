import opencode from "../vendor/opencode/packages/tui/src/theme/assets/v2/opencode.json" with { type: "json" }

/**
 * OpenCode's default theme with Cotal's gold as the accent: the website's primary, `#fff383` on a
 * dark terminal and `#885b00` on a light one. The categorical hues color agent names; they leave out
 * green, orange and red, which mark an agent's status, and gold, which marks you.
 */
const gold = {
  dark: { 100: "#fffac2", 200: "#fff383", 300: "#e6d86c", 400: "#c9bb57", 500: "#a89c45", 600: "#857b34", 700: "#615a25", 800: "#3f3a17", 900: "#201d0a" },
  light: { 100: "#6f4a00", 200: "#885b00", 300: "#9a6a0a", 400: "#ad7c1f", 500: "#c08f38", 600: "#d2a455", 700: "#e2bb78", 800: "#eed09f", 900: "#fdf5e8" },
}
const pink = {
  dark: { 100: "#f5a3d6", 200: "#e17fbf", 300: "#c46aa6", 400: "#a6578c", 500: "#884573", 600: "#6b345a", 700: "#4f2442", 800: "#33152b", 900: "#1a0915" },
  light: { 100: "#a3185f", 200: "#b8306f", 300: "#c84b83", 400: "#d66897", 500: "#e286ad", 600: "#eca5c3", 700: "#f4c3d8", 800: "#f9dfeb", 900: "#fdf2f7" },
}
const mint = {
  dark: { 100: "#7ff0dc", 200: "#4fd6be", 300: "#41b8a3", 400: "#359a88", 500: "#2a7d6e", 600: "#1f6155", 700: "#15463d", 800: "#0b2c26", 900: "#031511" },
  light: { 100: "#0b6e5f", 200: "#12806e", 300: "#2b9483", 400: "#47a898", 500: "#66bcae", 600: "#8ccfc4", 700: "#b2e1d9", 800: "#d6f0eb", 900: "#f0faf8" },
}
const categorical = ["blue", "pink", "cyan", "purple", "mint"]

export const COTAL_THEME = {
  ...opencode,
  base: { ...opencode.base, categorical },
  dark: { hue: { ...opencode.dark.hue, gold: gold.dark, pink: pink.dark, mint: mint.dark, accent: "$hue.gold", interactive: "$hue.gold" } },
  light: {
    ...opencode.light,
    categorical,
    hue: { ...opencode.light.hue, gold: gold.light, pink: pink.light, mint: mint.light, accent: "$hue.gold", interactive: "$hue.gold" },
    // OpenCode's light warning is its accent, which is gold here; a warning stays orange.
    text: { ...opencode.light.text, feedback: { ...opencode.light.text.feedback, warning: { base: "$hue.orange.100" } } },
  },
}
