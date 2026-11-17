// A hidden native window may have no frame clock. Prepare layout and let
// visibility trigger painting, without waiting for daemon status or fonts.
export async function reportFirstPaint<T>(mark: HTMLImageElement, header: HTMLElement, report: () => Promise<T>): Promise<T> {
  await mark.decode();
  void header.offsetHeight;
  return report();
}
