import assert from 'node:assert/strict';
import { get } from 'node:http';
import { httpReferences } from '../src/http-references.js';
const origin = process.env.DOCS_TEST_ORIGIN ?? 'http://localhost:8788';
for (const [path,destination] of [['/','/docs/what-is-cotal/'],['/spec/','/docs/spec/'],['/cli/','/api-reference/cli/'],['/api-reference/','/api-reference/api-reference/'],['/api-reference.md','/api-reference/api-reference.md'],['/spec.md','/docs/spec.md'],['/agent-frameworks/','/docs/connect-pi/'],['/agent-frameworks.md','/docs/connect-pi.md']]) {
 const response = await fetch(origin + path, { redirect:'manual' });
 assert.equal(response.status,301,path);
 assert.equal(response.headers.get('location'),destination,path);
}
for (const path of ['/docs/spec/','/api-reference/cli/','/spec/','/api/auth/operations/auth-health/','/api/dashboard/operations/list-roster/', ...httpReferences.map(reference => `/${reference.base}/`)]) {
 const response=await fetch(origin+path,{headers:{Accept:'text/markdown'}});
 assert.equal(response.status,200,path);
 assert.match(response.headers.get('content-type'),/text\/markdown/);
 assert(response.headers.has('x-markdown-tokens'));
 assert.match(response.headers.get('vary'),/Accept/);
 assert((await response.text()).startsWith('# '));
}
for (const { base, docSlug } of httpReferences) {
 const response = await fetch(`${origin}/${docSlug}/`, { redirect: 'manual' });
 assert.equal(response.status, 301);
 assert.equal(new URL(response.headers.get('location'), origin).pathname, `/${base}/`);
 const markdown = await fetch(`${origin}/${base}.md`);
 assert.match(markdown.headers.get('content-type'), /text\/markdown/);
 assert((await markdown.text()).includes('## Schemas'));
}
const root=await fetch(origin,{headers:{Accept:'text/markdown'}});
assert.equal(await root.text(),await (await fetch(origin+'/llms.txt')).text());
const md=await fetch(origin+'/docs/spec.md');
assert.match(md.headers.get('content-type'),/text\/markdown/);
assert(md.headers.has('x-markdown-tokens'));
assert.match((await fetch(origin+'/docs/spec/')).headers.get('vary'),/Accept/);
for (const host of ['get.cotal.ai','install.cotal.ai']) {
 const result=await new Promise((resolve,reject)=>{
  get(origin,{headers:{Host:host}},response=>{
   let body='';response.setEncoding('utf8');
   response.on('data',chunk=>{body+=chunk;});
   response.on('end',()=>resolve({headers:response.headers,body}));
  }).on('error',reject);
 });
 assert.match(result.headers['content-type'],/text\/plain/);
 assert(result.body.startsWith('#!/bin/sh'));
}
console.log('check-runtime: redirects, Markdown negotiation, cache headers and installer hosts verified');
