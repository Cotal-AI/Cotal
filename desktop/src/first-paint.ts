// A hidden native window may have no frame clock. Prepare layout and let
// visibility trigger painting, without waiting for daemon status or fonts.
export async function reportFirstPaint(mark: HTMLImageElement, header: HTMLElement, report: () => Promise<unknown>): Promise<void> {
  await mark.decode();
  void header.offsetHeight;
  await report();
}
