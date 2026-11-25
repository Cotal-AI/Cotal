import type { EffectContext, EffectHandler } from "./effects.js";

/** Simulation-only checks on handlers in this process, not part of the effect interface. */
export const simScopeFaults = new WeakMap<EffectHandler, (ctx: EffectContext) => void>();
