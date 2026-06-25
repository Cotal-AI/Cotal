// `pruneStaleMeshes` lives in `@cotal-ai/workspace` (`preflight.ts`) — the workstation layer the
// manager control commands share too. Re-exported from here so its CLI importers (`connect`,
// `commands/meshes`, `commands/use`) and the `spawn-from-anywhere` smokes keep resolving it from
// this module unchanged.
export { pruneStaleMeshes } from "@cotal-ai/workspace";
