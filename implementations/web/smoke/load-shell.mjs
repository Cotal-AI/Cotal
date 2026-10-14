// Loads the phase 1 shell (`client/src/App.tsx`) under Node, so a suite that reads the shell's
// source as text also loads the module it reads, and an edit to the shell reaches that suite by
// import rather than only by a file read.
//
// Plain JavaScript on purpose: the shell is JSX against the DOM and is typechecked by
// `client/tsconfig.json`. The smoke typecheck is Node-only, so it must not pull App.tsx into its
// program; it sees this module through `load-shell.d.mts` instead.
//
// Loading the shell runs its module scope only: it creates the shell's store and registers the
// AG-UI renderer. It starts no dashboard, opens no feed and renders nothing.
export const shell = await import("../client/src/App.tsx");
