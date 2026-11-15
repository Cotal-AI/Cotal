import assert from 'node:assert/strict';
import test from 'node:test';
import {packageLayoutCell} from './package-layout-cell.mjs';
test('actual package-manager layout cell refuses local execution before any install',async()=>{
 if(process.env.GITHUB_ACTIONS==='true'&&process.env.RUNNER_ENVIRONMENT==='github-hosted')return;
 await assert.rejects(()=>packageLayoutCell({layout:'pnpm'}),/Assertion/);
 await assert.rejects(()=>packageLayoutCell({layout:'nvm'}),/Assertion/);
});
