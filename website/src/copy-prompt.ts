// The click handler behind both setup-prompt buttons (the hero pill and the
// prompt card), kept in one place so their copy feedback cannot drift apart.
// The idle label is read from the markup so each component states it once.
export function copyPromptOnClick(selector: string): void {
  for (const btn of document.querySelectorAll<HTMLButtonElement>(selector)) {
    const { prompt } = btn.dataset;
    const label = btn.querySelector('.label');
    if (prompt === undefined || !label)
      throw new Error(`${selector} needs a data-prompt and a .label`);
    const idle = label.textContent;
    btn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(prompt);
        label.textContent = 'Copied';
        btn.classList.add('copied');
      } catch {
        label.textContent = 'Copy failed';
      }
      setTimeout(() => {
        label.textContent = idle;
        btn.classList.remove('copied');
      }, 2000);
    });
  }
}
