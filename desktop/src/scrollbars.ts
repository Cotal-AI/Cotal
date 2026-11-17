let sheet: CSSStyleSheet | undefined;
const rules = new Map<string, number>();

/** Draw list overflow cues without depending on platform scrollbar preferences. */
export function updateScrollThumb(list: HTMLElement, key: string): void {
  let thumb = document.querySelector<HTMLElement>(`[data-scroll-thumb="${key}"]`);
  if (!list.getClientRects().length || list.closest("[hidden]")) { if (thumb) thumb.hidden = true; return; }
  if (!thumb) {
    thumb = document.createElement("span");
    thumb.dataset.scrollThumb = key;
    thumb.className = "scroll-thumb";
    thumb.setAttribute("aria-hidden", "true");
    document.body.append(thumb);
    list.addEventListener("scroll", () => updateScrollThumb(list, key));
    const observer = new ResizeObserver(() => updateScrollThumb(list, key));
    observer.observe(list);
  }
  thumb.hidden = list.scrollHeight <= list.clientHeight + 1;
  if (thumb.hidden) return;
  if (!sheet) { sheet = new CSSStyleSheet(); document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet]; }
  let index = rules.get(key);
  if (index === undefined) { index = sheet.cssRules.length; sheet.insertRule(`[data-scroll-thumb="${key}"] {}`); rules.set(key, index); }
  const box = list.getBoundingClientRect();
  let visibleTop = box.top, visibleBottom = box.bottom;
  for (let parent = list.parentElement; parent; parent = parent.parentElement) {
    if (["auto", "scroll", "hidden", "clip"].includes(getComputedStyle(parent).overflowY)) {
      const bounds = parent.getBoundingClientRect();
      visibleTop = Math.max(visibleTop, bounds.top); visibleBottom = Math.min(visibleBottom, bounds.bottom);
    }
  }
  if (visibleBottom <= visibleTop) { thumb.hidden = true; return; }
  const height = Math.min(visibleBottom - visibleTop, Math.max(18, box.height * list.clientHeight / list.scrollHeight));
  const top = visibleTop + (visibleBottom - visibleTop - height) * list.scrollTop / (list.scrollHeight - list.clientHeight);
  const style = (sheet.cssRules[index] as CSSStyleRule).style;
  style.top = `${top}px`; style.left = `${box.right - 5}px`; style.height = `${height}px`;
}
