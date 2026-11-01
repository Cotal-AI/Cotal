import assert from 'node:assert/strict';
import { lexer, walkTokens } from 'marked';

const esm = /^\s*(?:import\s+(?:['"]|[^;]*?\bfrom\s*['"])|export\s+(?:default\b|(?:async\s+)?(?:function|class|const|let|var|type|interface)\b|[{*]))/;
const component = /<\/?(?:Cards?|Steps?|Tabs?|Callout|AgentPrompt|AgentSetupCard|Mermaid)(?:\s|>|\/)/;

export function assertPlainMarkdown(markdown, label) {
  assert(!markdown.includes('\0'), `Markdown has no NUL: ${label}`);
  walkTokens(lexer(markdown), token => {
    if (token.type === 'html') assert(!component.test(token.raw), `no MDX component markup: ${label}`);
    if (token.type === 'paragraph' || (token.type === 'text' && token.tokens))
      assert(!esm.test(token.raw), `no executable module declaration: ${label}`);
  });
}
