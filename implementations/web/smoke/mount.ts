/** Mounts a React element into the DOM `dom-globals.ts` installed, with `react-dom/client`, so a suite
 *  can click, fire events and unmount, then read the DOM React wrote. Every render and every event
 *  runs inside `act`, so effects have run before the suite looks. Import `dom-globals.ts` before this
 *  module: React's client reads `window` and `document` when it loads. */
import { act, type ReactElement } from "react";
import { createRoot } from "react-dom/client";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

export interface Mounted {
  container: HTMLElement;
  /** Run `fn` (a click, a store write, a hash change) and let React finish what it schedules. */
  run(fn: () => void): Promise<void>;
  unmount(): Promise<void>;
}

export async function mount(element: ReactElement): Promise<Mounted> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => root.render(element));
  return {
    container,
    run: (fn) => act(async () => fn()),
    unmount: () => act(async () => root.unmount()),
  };
}

/** Every `console.error` call made while `fn` runs. React reports a duplicate key and other render
 *  defects there in development builds, which is what the suites run. */
export async function errorsDuring(fn: () => Promise<void>): Promise<string[]> {
  const seen: string[] = [];
  const real = console.error;
  console.error = (...args: unknown[]) => void seen.push(args.map(String).join(" "));
  try {
    await fn();
  } finally {
    console.error = real;
  }
  return seen;
}
