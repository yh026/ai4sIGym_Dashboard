#!/usr/bin/env node
'use strict';
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const root=path.resolve(__dirname,'..'),out=path.join(root,'local-content/backend-sandbox/runtime');
const importId=process.argv[2];
if(!/^[A-Za-z0-9_-]{20,}$/.test(importId||''))throw new Error('Provide the verified sandbox import config file ID');
function wrap(name,file,imports=''){
  return 'var '+name+'=(function(){var module={exports:{}};\n'+imports+'\n'+fs.readFileSync(path.join(root,file),'utf8')+'\nreturn module.exports;})();\n';
}
const code=wrap('V2','lib/registry-v2.js')+wrap('V2Sheet','lib/registry-v2-sheet-adapter.js',"function require(name){if(name==='./registry-v2')return V2;throw new Error('Unknown module');}")+wrap('V3','lib/registry-v3.js')+fs.readFileSync(path.join(root,'google-apps-script/sandbox/SourceMounts.gs'),'utf8')+fs.readFileSync(path.join(root,'google-apps-script/sandbox/Adapter.gs'),'utf8').replace('__IMPORT_CONFIG_ID__',importId);
new vm.Script(code);
fs.mkdirSync(out,{recursive:true});fs.writeFileSync(path.join(out,'Code.gs'),code);
const manifest={timeZone:'Asia/Singapore',dependencies:{enabledAdvancedServices:[{userSymbol:'Sheets',version:'v4',serviceId:'sheets'}]},exceptionLogging:'STACKDRIVER',runtimeVersion:'V8',webapp:{executeAs:'USER_DEPLOYING',access:'ANYONE_ANONYMOUS'}};
fs.writeFileSync(path.join(out,'appsscript.json'),JSON.stringify(manifest,null,2));
console.log('Sandbox bundle written and syntax checked: '+Buffer.byteLength(code)+' bytes');
