import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, delimiter } from 'node:path';
import { inspectInstalledUpdateRoute } from './daemon-cell-diagnostics.mjs';
import { inspectGenerationStore } from './generation-store-census.mjs';

/** pnpm 11 gives each global install a group, selected by an active hash symlink. */
export function pnpmGlobalPackage(listing) {
  assert(Array.isArray(listing)&&listing.length<=1000,'pnpm global group census exceeds bound');
  const matches=[];
  for(const group of listing){
    const dependency=group.dependencies?.['cotal-ai'];
    if(!dependency)continue;
    assert(typeof dependency.path==='string'&&dependency.path.startsWith('/'),'pnpm list must identify installed package path');
    const path=dependency.path;
    const metadata=JSON.parse(readFileSync(join(path,'package.json')));
    assert.equal(metadata.name,'cotal-ai');
    assert.equal(metadata.version,dependency.version);
    matches.push({group:group.path,path:realpathSync(path)});
  }
  assert.equal(matches.length,1,'one active pnpm cotal-ai installation group required');
  return matches[0];
}

export function packageLayoutAssertions(report,cell){
  const calls=report.calls??[];
  const clean=row=>row?.exit===0&&row.signal===null&&row.timeout===false;
  const version=(label,target)=>{const row=calls.find(item=>item.label===label);return clean(row)&&row.stdout.split(/\r?\n/,1)[0]===`cotal-ai ${target}`;};
  const extensions=report.assertions?.find(row=>row.name==='recorded extensions reach target')?.observed;
  const assertions={
    'layout-source-version':version('installed source public version',cell.sourceVersion),
    'layout-update-success':clean(calls.find(row=>row.label==='package-manager installed public updater')),
    'layout-target-version':version('installed target public version',cell.targetVersion)&&report.route?.selectedCliVersion===cell.targetVersion,
    'layout-extensions':Array.isArray(extensions)&&extensions.length>=7&&extensions.every(row=>row.recorded===cell.targetVersion&&row.installed===cell.targetVersion),
    'layout-status':clean(calls.find(row=>row.label==='installed target public status')),
    'layout-prefix-preserved':cell.layoutProbe==='nvm'?report.prefixAfter===report.installation?.prefix:report.pnpmVersion==='11.28.2'&&calls.some(row=>row.label==='pnpm global list after'&&clean(row)),
    'generation-store-protected':report.store?.passed===true,
  };
  return {assertions,passed:report.passed===true&&!report.error&&cell.requiredAssertions.every(name=>assertions[name]===true)};
}

/** Exercise actual package-manager global commands. An unsupported updater remains a red result. */
export async function packageLayoutCell({ layout, registry, output, nodePrefix }) {
  assert.equal(process.env.GITHUB_ACTIONS,'true');
  assert.equal(process.env.RUNNER_ENVIRONMENT,'github-hosted');
  assert.equal(process.platform,'linux');
  assert(['pnpm','nvm'].includes(layout));
  assert(/^http:\/\/127\.0\.0\.1:[0-9]+$/.test(registry.url));
  const root=mkdtempSync(join(process.env.RUNNER_TEMP,'package-layout-'));
  const home=join(root,'home');
  for(const path of [home,join(home,'.cotal'),join(home,'config'),join(root,'tmp'),output])mkdirSync(path,{recursive:true,mode:0o700});
  const env={...process.env};for(const key of Object.keys(env))if(key.startsWith('COTAL_')||/^npm_config_prefix$/i.test(key))delete env[key];
  Object.assign(env,{HOME:home,COTAL_HOME:join(home,'.cotal'),XDG_CONFIG_HOME:join(home,'config'),TMPDIR:join(root,'tmp'),DO_NOT_TRACK:'1',COTAL_TELEMETRY:'off',COTAL_SKIP_CONNECTOR_SEED:'1',npm_config_registry:registry.url,npm_config_cache:join(root,'cache')});
  const report={layout,source:registry.identity.source,sourceVersion:registry.identity.sourceVersion,targetVersion:registry.identity.targetVersion,calls:[],assertions:[],cleanup:{owner:'disposable hosted runner teardown',noServiceRequested:true},environment:{nodeVersion:process.versions.node}};
  const check=(name,passed,observed)=>report.assertions.push({name,passed,observed});
  async function call(label,file,argv){
    const startedAt=new Date().toISOString();
    const result=await new Promise(resolve=>{
      const child=spawn(file,argv,{env,cwd:root,stdio:['ignore','pipe','pipe']});let stdout='',stderr='',timeout=false;
      const timer=setTimeout(()=>{timeout=true;child.kill('SIGTERM');},180000);
      child.stdout.on('data',b=>{stdout+=b;});child.stderr.on('data',b=>{stderr+=b;});
      child.once('error',error=>{clearTimeout(timer);resolve({exit:null,signal:null,timeout,stdout,stderr:stderr+String(error)});});
      child.once('close',(exit,signal)=>{clearTimeout(timer);resolve({exit,signal,timeout,stdout,stderr});});
    });
    report.calls.push({label,file,argv,startedAt,finishedAt:new Date().toISOString(),...result});
    writeFileSync(join(output,'package-layout.json'),JSON.stringify(report,null,2),{mode:0o600});
    assert(!result.timeout&&!result.signal,`${label}: outcome unknown, runner teardown owns cleanup`);
    return result;
  }
  const ok=(row,label)=>{assert.equal(row.exit,0,`${label}: ${row.stdout}${row.stderr}`);return row;};
  try{
    let prefix,bin,pkg,cli,install;
    if(layout==='nvm'){
      assert(nodePrefix&&nodePrefix.includes('/.nvm/versions/node/v24.18.0'),'actual nvm prefix required');
      env.PATH=join(nodePrefix,'bin')+delimiter+env.PATH;
      const npm=join(nodePrefix,'bin/npm');
      prefix=ok(await call('nvm selected npm prefix',npm,['config','get','prefix']),'nvm prefix').stdout.trim();
      assert.equal(realpathSync(prefix),realpathSync(nodePrefix),'npm prefix differs from actual nvm Node');
      assert.equal(ok(await call('nvm selected Node',join(nodePrefix,'bin/node'),['--version']),'nvm Node').stdout.trim(),'v24.18.0');
      bin=join(prefix,'bin');pkg=join(prefix,'lib/node_modules/cotal-ai');cli=join(bin,'cotal');
      install=version=>call('nvm npm install '+version,npm,['install','-g',`cotal-ai@${version}`,'--ignore-scripts','--no-audit','--no-fund']);
    }else{
      env.PNPM_HOME=join(home,'pnpm');mkdirSync(env.PNPM_HOME,{mode:0o700});
      report.pnpmVersion=ok(await call('pinned pnpm version','pnpm',['--version']),'pnpm version').stdout.trim();assert.equal(report.pnpmVersion,'11.28.2');
      ok(await call('actual pnpm setup','pnpm',['setup']),'pnpm setup');
      env.PATH=join(env.PNPM_HOME,'bin')+delimiter+env.PATH;
      bin=ok(await call('pnpm global bin','pnpm',['bin','-g']),'pnpm bin').stdout.trim();
      env.PATH=bin+delimiter+env.PATH;cli=join(bin,'cotal');
      install=version=>call('pnpm global install '+version,'pnpm',['add','-g',`cotal-ai@${version}`,'--ignore-scripts']);
    }
    ok(await install(report.sourceVersion),'source install');
    if(layout==='pnpm'){
      const globalRoot=ok(await call('pnpm actual global root','pnpm',['root','-g']),'pnpm root').stdout.trim();
      report.packageManagerBefore=ok(await call('pnpm global list before','pnpm',['list','-g','--json']),'pnpm list').stdout;
      report.pnpmGroup=pnpmGlobalPackage(JSON.parse(report.packageManagerBefore));pkg=report.pnpmGroup.path;prefix=globalRoot;
    }
    report.installation={prefix,bin,pkg:realpathSync(pkg),cli,shimSha256:createHash('sha256').update(readFileSync(cli)).digest('hex')};
    const sourceManifest=JSON.parse(readFileSync(join(pkg,'package.json')));assert.equal(sourceManifest.version,report.sourceVersion);
    const source=await call('installed source public version',cli,['--version']);
    check('source version selected',source.exit===0&&source.stdout.split(/\r?\n/,1)[0]===`cotal-ai ${report.sourceVersion}`,source);
    ok(await call('seed source connectors',cli,['ext','seed']),'source seed');
    registry.activateTarget();
    report.update=await call('package-manager installed public updater',cli,['update','--self']);
    check('installed updater exits zero',report.update.exit===0,report.update);
    report.version=await call('installed target public version',cli,['--version']);
    check('target version selected',report.version.exit===0&&report.version.stdout.split(/\r?\n/,1)[0]===`cotal-ai ${report.targetVersion}`,report.version);
    const manifestPath=join(home,'config/cotal/extensions/extensions.json');
    report.extensions=JSON.parse(readFileSync(manifestPath,'utf8')).extensions;
    const extensionVersions=report.extensions.map(entry=>({pkg:entry.pkg,recorded:entry.version,installed:JSON.parse(readFileSync(join(home,'config/cotal/extensions/node_modules',entry.pkg,'package.json'),'utf8')).version}));
    check('recorded extensions reach target',extensionVersions.length>=7&&extensionVersions.every(entry=>entry.recorded===report.targetVersion&&entry.installed===report.targetVersion),extensionVersions);
    report.status=await call('installed target public status',cli,['status']);check('public status healthy',report.status.exit===0,report.status);
    report.route=inspectInstalledUpdateRoute(pkg,process.platform);
    check('selected route reaches target',report.route.selectedCliVersion===report.targetVersion,report.route);
    report.store=inspectGenerationStore(join(dirname(dirname(realpathSync(pkg))),'.cotal-generations'),{required:report.route.updateRoute==='staged'});
    check('generation store protected',report.store.passed,report.store);
    if(layout==='pnpm')report.packageManagerAfter=ok(await call('pnpm global list after','pnpm',['list','-g','--json']),'pnpm list after').stdout;
    else report.prefixAfter=ok(await call('nvm npm prefix after',join(nodePrefix,'bin/npm'),['config','get','prefix']),'nvm prefix after').stdout.trim();
    check('package-manager layout remains selected',layout==='pnpm'?JSON.parse(report.packageManagerAfter).length>0:report.prefixAfter===prefix,report.installation);
    report.passed=report.assertions.every(row=>row.passed);
  }catch(error){report.passed=false;report.error=error.message;}
  const bytes=JSON.stringify(report,null,2);writeFileSync(join(output,'package-layout.json'),bytes,{mode:0o600});
  writeFileSync(join(output,'package-layout.sha256'),`${createHash('sha256').update(bytes).digest('hex')}  package-layout.json\n`,{mode:0o600});
  return report;
}
