import { useEffect, useState } from "react";

/** The time now, redrawn every second while `on`; one interval per caller. A part that shows a
 *  counting time (the open turn's title, a running call) passes true while it counts, and the
 *  interval stops when that stops. Times are numbers, not motion, so they count under reduced motion
 *  too. */
export function useNow(on: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [on]);
  return now;
}
