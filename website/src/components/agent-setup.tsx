'use client';

import { useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { CodeBlock, Pre } from 'fumadocs-ui/components/codeblock';
import { AGENT_PROMPT } from '@cotal-ai/docs-content/agent-prompt';
import { connectorIcons } from '@/lib/connector-icons.mjs';

export function AgentPrompt() {
  return <CodeBlock><Pre className="whitespace-pre-wrap"><code>{AGENT_PROMPT}</code></Pre></CodeBlock>;
}

export function AgentSetupCard() {
  const [status, setStatus] = useState<'idle' | 'copied' | 'failed'>('idle');
  async function copyPrompt() {
    try {
      await navigator.clipboard.writeText(AGENT_PROMPT);
      setStatus('copied');
    } catch {
      setStatus('failed');
    }
  }
  return (
    <button
      type="button"
      onClick={copyPrompt}
      aria-label="Set up with your agent. Copy setup prompt"
      className="not-prose my-6 flex w-full flex-col gap-5 rounded-xl border bg-fd-card p-6 text-left text-fd-card-foreground hover:bg-fd-accent focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-fd-primary"
    >
      <span className="flex w-full flex-wrap items-center justify-between gap-4">
        <span className="text-lg font-semibold">Set up with your agent</span>
        <span className="flex items-center gap-3" aria-hidden="true">
          {[...connectorIcons].map(([name, src]) => <img key={name} src={src} alt="" width={24} height={24} className="size-6 object-contain" />)}
        </span>
      </span>
      <code className="whitespace-normal break-words text-sm leading-relaxed">{AGENT_PROMPT}</code>
      <span className="flex items-center gap-2 text-sm text-fd-muted-foreground" role="status">
        {status === 'copied' ? <Check className="size-4" aria-hidden="true" /> : <Copy className="size-4" aria-hidden="true" />}
        {status === 'copied' ? 'Prompt copied' : status === 'failed' ? 'Copy failed. Select the prompt text and copy it.' : 'Click anywhere to copy the setup prompt'}
      </span>
    </button>
  );
}
