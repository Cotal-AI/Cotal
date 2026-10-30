'use client';
import { useState } from 'react';
import { AGENT_PROMPT } from '../prompt';
export function AgentPrompt() {
 const [status, setStatus] = useState('Copy');
 return <button type="button" className="agent-prompt" aria-label="Copy the setup prompt" onClick={async () => { try { await navigator.clipboard.writeText(AGENT_PROMPT); setStatus('Copied'); } catch { setStatus('Copy failed. Select the prompt to copy it.'); } }}><code>{AGENT_PROMPT}</code><span role="status">{status}</span></button>;
}
