// Reduced-motion rule for the render suite. Reduce Motion replaces movement with fades: under it an
// animation may only fade (opacity, colour, visibility), and none may repeat. The setting is on before
// the page loads, as a person's would be, so switching it on can't restart an animation mid-way. Every
// animation that started is recorded, including one that ends before the check.

/** Properties an animation may change under reduce: fades and colour changes, never movement or size. */
export const REDUCED_ALLOWED = new Set(["opacity", "color", "background-color", "border-top-color", "border-right-color", "border-bottom-color", "border-left-color", "outline-color", "visibility"]);

/** Elements that animate in normal motion and must be present but static under reduce. */
export const MOTION_ELEMENTS = ".icon-spinner, .app-bar";

/** Installed before the app's scripts: records each animation once, from its start event and on demand. */
export function recordMotion() {
  const seen = window.__motionSeen = [];
  const record = animation => {
    if (!animation || seen.some(entry => entry.animation === animation)) return;
    const timing = animation.effect?.getTiming() ?? {};
    const frames = animation.effect?.getKeyframes?.() ?? [];
    const properties = animation.transitionProperty ? [animation.transitionProperty]
      : [...new Set(frames.flatMap(frame => Object.keys(frame).filter(key => !["offset", "computedOffset", "easing", "composite"].includes(key))))];
    const target = animation.effect?.target;
    const label = target?.id || (typeof target?.className === "string" ? target.className : target?.className?.baseVal) || target?.tagName || "unknown";
    seen.push({ animation, target: label, name: animation.animationName || animation.transitionProperty || "script", properties, iterations: timing.iterations === Infinity ? "infinite" : timing.iterations });
  };
  window.__recordMotion = () => { for (const animation of document.getAnimations({ subtree: true })) record(animation); };
  for (const type of ["animationstart", "transitionrun"]) document.addEventListener(type, () => window.__recordMotion(), true);
}

/** Every animation the page has started so far, without the live Animation objects. */
export const readMotion = page => page.evaluate(() => { window.__recordMotion(); return window.__motionSeen.map(({ animation, ...entry }) => entry); });

/** Movement or repetition found under reduce, one line per offending animation. */
export function reducedViolations(entries) {
  return entries.filter(entry => entry.iterations !== 1 || entry.properties.some(property => !REDUCED_ALLOWED.has(property)))
    .map(entry => `${entry.name} on ${entry.target} changes ${entry.properties.join(", ")}${entry.iterations === 1 ? "" : `, repeats ${entry.iterations}`}`);
}

/** Loads the scenario in a fresh window, so nothing a check paused or cancelled carries over, and returns what animated. */
async function freshRun(browser, address, nativeStub, scenario, viewport, theme, reducedMotion) {
  const context = await browser.newContext({ viewport, colorScheme: theme, reducedMotion });
  try {
    const page = await context.newPage();
    await page.addInitScript(recordMotion);
    await page.addInitScript(nativeStub, scenario.state);
    await page.goto(address);
    await page.waitForFunction(() => window.__renderState.paintReports === 1);
    if (scenario.prepare) { await scenario.prepare(page); await page.waitForTimeout(300); }
    if (scenario.act) await scenario.act(page);
    await page.waitForTimeout(300);
    const entries = await readMotion(page);
    const elements = await page.evaluate(selector => [...document.querySelectorAll(selector)].filter(el => el.getClientRects().length).map(el => el.getAnimations({ subtree: true }).some(a => a.playState === "running")), MOTION_ELEMENTS);
    return { entries, elements };
  } finally { await context.close(); }
}

/** The control: in normal motion every visible spinner and progress bar moves, so the reduce check can't pass by showing nothing. */
export async function normalRun(browser, address, nativeStub, scenario, viewport, theme) {
  const { entries, elements } = await freshRun(browser, address, nativeStub, scenario, viewport, theme, "no-preference");
  return { entries, shown: elements.length, moving: elements.filter(Boolean).length };
}

/** Loads the scenario with reduce already on and returns what animated and how many motion elements stood still. */
export async function reducedRun(browser, address, nativeStub, scenario, viewport, theme) {
  const { entries, elements } = await freshRun(browser, address, nativeStub, scenario, viewport, theme, "reduce");
  return { entries, still: elements.filter(moving => !moving).length };
}
