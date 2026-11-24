/** The terminal sign-in method every Cotal ACP agent advertises, the launcher's stub included: the
 *  client runs the agent's own command again with `--auth` added, in a terminal. */
export const TERMINAL_AUTH = {
  type: "terminal" as const,
  id: "cotal-sign-in",
  name: "Sign in to Cotal",
  description: "Signs in to a hosted space, or sets up a local one.",
  args: ["--auth"],
};
