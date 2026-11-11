// Two frame callbacks leave a rendering opportunity between layout and the report.
// Only the mark is needed for that frame, not daemon status or document.fonts.ready.
export async function reportFirstPaint(mark: HTMLImageElement, report: () => Promise<unknown>): Promise<void> {
  await mark.decode();
  await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  await report();
}
