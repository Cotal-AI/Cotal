import assert from 'node:assert/strict';
import test from 'node:test';
import { assertPublishedLinks } from './check-links.mjs';

for (const [name, file, source] of [
  ['rooted HTML links', 'page.html', '<a href="/docs/glossary/">Glossary</a><img src="/assets/a.png">'],
  ['absolute and protocol-relative URLs', 'page.html', '<a href="https://example.test/a">A</a><img src="//example.test/a.png">'],
  ['anchors and schemes', 'page.html', '<a href="#here">Here</a><a href="mailto:a@example.test">Mail</a><img src="data:image/png;base64,AAAA">'],
  ['encoded root', 'page.html', '<a href="&#47;docs/glossary/">Glossary</a>'],
  ['URL whitespace normalization', 'page.html', '<a href=" &#9;https://example.test/a&#10; ">A</a>'],
  ['HTML code text', 'page.html', '<pre><code>[Glossary](../docs/glossary.md) &lt;a href="scripts/x"&gt;</code></pre>'],
  ['script text', 'page.html', '<script>const example = \'<a href="scripts/x">\';</script>'],
  ['comments', 'page.html', '<!-- <a href="../docs/x"> -->'],
  ['fenced Markdown', 'page.md', '```md\n[Glossary](../docs/glossary.md)\n<a href="scripts/x">\n```'],
  ['indented Markdown', 'page.md', '    [Glossary](../docs/glossary.md)\n'],
  ['inline Markdown code', 'page.md', 'Use `[Glossary](../docs/glossary.md)` and `<img src="assets/a.png">`.'],
  ['rooted Markdown and reference', 'page.md', '[Glossary](/docs/glossary/) and [A][ref]\n\n[ref]: https://example.test/a'],
  ['escaped root in reference', 'page.md', '[A][ref]\n\n[ref]: &#47;docs/glossary/'],
  ['fenced definitions', 'page.md', '```md\n[ref]: scripts/x\n```'],
  ['llms code samples', 'llms-full.txt', '```html\n<a href="../docs/x">\n```\n\n[A](/docs/a/)'],
  ['multiple absolute srcset candidates', 'page.html', '<img srcset="/a.png 1x, https://example.test/b.png 2x">'],
  ['data URL srcset commas', 'page.html', '<img srcset="data:image/png;base64,AAAA 1x, /b.png 2x">'],
]) {
  test(`accepts ${name}`, () => assert.doesNotThrow(() => assertPublishedLinks(source, file)));
}

for (const [name, file, source] of [
  ['parent directory', 'page.html', '<a href="../docs/x.md">A</a>'],
  ['sibling page', 'page.html', '<a href="glossary.md">A</a>'],
  ['unlisted source directory', 'page.html', '<a href="scripts/x.mjs">A</a>'],
  ['relative image', 'page.html', '<img src="assets/x.png">'],
  ['single-quoted attribute', 'page.html', "<a href='../docs/x.md'>A</a>"],
  ['unquoted attribute', 'page.html', '<a href=deploy/x>A</a>'],
  ['entity-encoded relative link', 'page.html', '<a href="&#46;&#46;/docs/x.md">A</a>'],
  ['whitespace before relative URL', 'page.html', '<a href=" &#9;docs/x.md\n">A</a>'],
  ['relative srcset second candidate', 'page.html', '<img srcset="/safe.png 1x, bin/x.png 2x">'],
  ['relative srcset after a data URL', 'page.html', '<img srcset="data:image/png;base64,AAAA 1x, assets/x.png 2x">'],
  ['relative srcset with trailing comma', 'page.html', '<img srcset="assets/x.png, /safe.png 2x">'],
  ['template content', 'page.html', '<template><a href="website/x">A</a></template>'],
  ['real link inside pre', 'page.html', '<pre><a href="docs/x">A</a></pre>'],
  ['SVG link', 'page.html', '<svg><use xlink:href="assets/x.svg#icon"></use></svg>'],
  ['query-only URL', 'page.html', '<a href="?page=2">A</a>'],
  ['empty URL', 'page.html', '<a href="">A</a>'],
  ['Markdown link', 'page.md', '[Source](scripts/x.mjs)'],
  ['Markdown image', 'page.md', '![Image](assets/x.png)'],
  ['Markdown reference', 'page.md', '[Source][ref]\n\n[ref]: deploy/x'],
  ['unused Markdown definition', 'page.md', '[ref]: website/x'],
  ['HTML in Markdown', 'page.md', '<a href="glossary.md">A</a>'],
  ['llms reference', 'llms-full.txt', '[Source][ref]\n\n[ref]: website/x'],
]) {
  test(`refuses ${name}`, () => assert.throws(() => assertPublishedLinks(source, file), error => {
    assert.match(error.message, /repo-relative link leaked/);
    assert.ok(error.message.includes(file), 'the refusal names the artifact');
    return true;
  }));
}
