// The browser half of the phone layout: whether the window is phone width, followed as it changes.
import { useSyncExternalStore } from "react";

/** Below 768px wide the dashboard draws the phone layout (mock section F). */
export const PHONE_QUERY = "(max-width: 767.98px)";

const subscribe = (onChange: () => void): (() => void) => {
  const query = window.matchMedia(PHONE_QUERY);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
};

/** Whether the window is phone width now, redrawing the caller when that changes. A server render
 *  has no window and draws the wide layout. Browser only. */
export function usePhone(): boolean {
  return useSyncExternalStore(subscribe, () => window.matchMedia(PHONE_QUERY).matches, () => false);
}
