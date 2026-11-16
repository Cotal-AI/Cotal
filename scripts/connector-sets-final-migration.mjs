import {existsSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {inputs,makeReport,overlay,id,tree} from './connector-sets-final-acceptance.mjs';
const options=inputs(),h=makeReport(options,'shared-store-migration'),{report,save,check,call,environment}=h;
let registry;
try {
 const context=environment('legacy'),prefix=join(context.base,'prefix'),entry=join(prefix,'lib/node_modules/cotal-ai/dist/cotal.js');
 await call(context,'install actual published pre-set release','npm',['install','-g','--prefix',prefix,'cotal-ai@0.164.18','--registry','https://registry.npmjs.org','--no-audit','--no-fund']);
 const cli=(label,args)=>call(context,label,process.execPath,[entry,...args]);
 await cli('published legacy seed',['ext','seed']);
 const legacyRoot=(await cli('published legacy extension root',['ext','root'])).stdout.trim();
 check('published release really uses shared legacy root',legacyRoot===join(context.env.XDG_CONFIG_HOME,'cotal/extensions'),legacyRoot);
 await cli('operator adds first-party tmux before migration',['ext','add','@cotal-ai/tmux']);
 await cli('person removes Hermes before migration',['ext','remove','@cotal-ai/connector-hermes']);
 const legacySeed=join(context.env.XDG_CONFIG_HOME,'cotal/seed');report.before={extensions:tree(legacyRoot),seed:tree(legacySeed)};save();
 registry=await overlay(options,context,'B');
 await call(context,'actual npm replacement by candidate B','npm',['install','-g','--prefix',prefix,'cotal-ai@0.164.1018','--no-audit','--no-fund']);
 await cli('candidate migrates real legacy inventory',['ext','seed']);const selected=id((await cli('candidate scoped root',['ext','root'])).stdout.trim());
 const inventory=JSON.parse(readFileSync(join(selected.root,'extensions.json'),'utf8')).extensions;
 check('operator tmux survives real migration core-matched',inventory.some(e=>e.pkg==='@cotal-ai/tmux'&&e.version==='0.164.1018'),inventory.map(e=>({pkg:e.pkg,version:e.version})));
 check('deliberately removed Hermes is not resurrected',!inventory.some(e=>e.pkg==='@cotal-ai/connector-hermes'));
 report.after={extensions:tree(legacyRoot),seed:tree(legacySeed)};
 check('whole legacy extensions stay byte/link identical',JSON.stringify(report.before.extensions)===JSON.stringify(report.after.extensions));
 check('whole legacy seed stays byte/link identical',JSON.stringify(report.before.seed)===JSON.stringify(report.after.seed));
 await cli('repeat migration reconciliation',['ext','seed']);
 check('repeat migration leaves legacy bytes intact',JSON.stringify(report.before.extensions)===JSON.stringify(tree(legacyRoot))&&JSON.stringify(report.before.seed)===JSON.stringify(tree(legacySeed)));
 check('both legacy stores still exist',existsSync(legacyRoot)&&existsSync(legacySeed));report.selected=selected;report.result='passed';
} catch(error){report.error={message:error.message,stack:error.stack};process.exitCode=1;}
finally{await registry?.close();save();}
console.log(JSON.stringify({result:report.result,checks:report.checks.length,error:report.error}));
