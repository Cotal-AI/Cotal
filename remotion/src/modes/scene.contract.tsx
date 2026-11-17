import type { ComponentProps } from "react";
import type { Wires } from "./scene";

type Props = ComponentProps<typeof Wires>;

export const resting: Props = { wires: [{ d: "M 0 0 L 1 1", glow: 0 }] };
export const active: Props = { wires: [{ d: "M 0 0 L 1 1", glow: 0.5 }] };
export const empty: Props = { wires: [] };

// @ts-expect-error Every wire requires a glow, including resting paths.
export const missingGlow: Props = { wires: [{ d: "M 0 0 L 1 1" }] };
// @ts-expect-error Every wire requires its own geometry.
export const missingPath: Props = { wires: [{ glow: 0 }] };
// @ts-expect-error Parallel arrays cannot describe wire/glow pairs.
export const parallelArrays: Props = { paths: ["M 0 0 L 1 1"], glow: [1] };
// @ts-expect-error A missing glow cannot be supplied as undefined.
export const undefinedGlow: Props = { wires: [{ d: "M 0 0 L 1 1", glow: undefined }] };
