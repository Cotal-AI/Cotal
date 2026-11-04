// Whether the reader asked for reduced motion. The phone layout follows shadcn's `useIsMobile`.

/** Whether the reader asked for reduced motion, read when called. A server render has no window and
 *  reads no. */
export const reducedMotion = (): boolean =>
  (globalThis as { matchMedia?: (q: string) => { matches: boolean } }).matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
