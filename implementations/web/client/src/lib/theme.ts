// The theme choices, with no browser in them, so the shell can name them while it renders on the
// server. Reading, saving and applying a choice is `../theme.ts`, which runs in the browser only.

export type Theme = "system" | "light" | "dark";

/** Every choice, in the order the Settings menu lists them. */
export const THEMES: readonly Theme[] = ["system", "light", "dark"];
