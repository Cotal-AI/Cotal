// The one-liner a visitor pastes into their coding agent. Rendered by the hero
// pill (CopyPrompt) and the landing prompt card (AgentPrompt); the Quickstart
// carries the same line as plain Markdown (docs/getting-started.md).
// Plain JavaScript so the docs sync (Node) imports the same value the site renders.
export const AGENT_PROMPT =
  'Read https://docs.cotal.ai/prompt.md, then set up Cotal on this machine: install it, start a local mesh, and put an agent on it.';

// The Quickstart's fence for the prompt: the docs sync swaps it for the card
// and the page's Markdown twin restores it, so both must build the same string.
export const PROMPT_FENCE = '```text wrap\n' + AGENT_PROMPT + '\n```';
