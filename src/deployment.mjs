import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { readJson, validateProfile } from './runtime/config.mjs';
import { scanScope } from './scan.mjs';
import { buildM3, buildM4 } from './build-governance-ledgers.mjs';
import { buildDryRun } from './profile-dry-run.mjs';
const fail=code=>{throw Object.assign(new Error(code),{code});};
const norm=file=>process.platform==='win32'?path.resolve(file).toLowerCase():path.resolve(file);
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
export function publishDirectory(target, build) {
  if(fs.existsSync(target))fail('OUTPUT_EXISTS_NO_OVERWRITE');
  fs.mkdirSync(path.dirname(target),{recursive:true});
  const temp=target+'.tmp-'+randomUUID();fs.mkdirSync(temp);
  try { build(temp);if(fs.existsSync(target))fail('OUTPUT_EXISTS_NO_OVERWRITE');fs.renameSync(temp,target); }
  finally { if(fs.existsSync(temp))fs.rmSync(temp,{recursive:true,force:true}); }
}
function writeJson(file,data){fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,JSON.stringify(data,null,2)+'\n',{flag:'wx'});}
function replaceCompared(file,data,before) {
  const temp=file+'.tmp-'+randomUUID();
  try {writeJson(temp,data);if(sha(fs.readFileSync(file))!==sha(before))fail('CONCURRENT_MODIFICATION');fs.renameSync(temp,file);}
  finally {if(fs.existsSync(temp))fs.unlinkSync(temp);}
}
function pointer({project,config,node}) {
  const root=path.resolve(project);
  if(!fs.existsSync(path.join(root,'src/sgs.mjs'))||!fs.statSync(path.join(root,'src/sgs.mjs')).isFile())fail('SGS_PROJECT_NOT_FOUND');
  const executable=node??process.execPath;
  if(!path.isAbsolute(executable)||!fs.existsSync(executable)||!fs.statSync(executable).isFile())fail('NODE_EXECUTABLE_REQUIRED');
  if(config&&!fs.existsSync(path.resolve(config)))fail('CONFIG_NOT_FOUND');
  return {schema:'sgs/skill-runtime-pointer@1',project_root:root,entry:'src/sgs.mjs',node_command:executable,...(config?{config_path:path.resolve(config)}:{})};
}
export function renderEntry({project,config,node,out,templateProject=project}) {
  const data=pointer({project,config,node});
  const template=fs.readFileSync(path.join(templateProject,'product/skill-governance/SKILL.md'));
  publishDirectory(path.resolve(out),temp=>{
    fs.writeFileSync(path.join(temp,'SKILL.md'),template,{flag:'wx'});
    writeJson(path.join(temp,'references/runtime.json'),data);
    if(!fs.readFileSync(path.join(temp,'SKILL.md')).equals(template)||readJson(path.join(temp,'references/runtime.json')).project_root!==data.project_root)fail('ENTRY_VALIDATION_FAILED');
  });
  return {entry_directory:path.resolve(out),runtime:data,installed_into_discovery:false};
}
export function installEntry(runtime,options={}) {
  const root=path.resolve(options.root??runtime.discoveryRoots[0]);
  if(!runtime.discoveryRoots.some(folder=>norm(folder)===norm(root)))fail('ENTRY_ROOT_NOT_CONFIGURED');
  if(fs.existsSync(root)&&fs.lstatSync(root).isSymbolicLink())fail('ALIASED_ENTRY_ROOT');
  const result=renderEntry({project:runtime.projectRoot,config:runtime.configured?runtime.configPath:null,node:options.node,out:path.join(root,'skill-governance')});
  return {...result,installed_into_discovery:true,desktop_observation:'UNKNOWN',next_action:'DESKTOP_RESTART_OR_NEW_SESSION_REQUIRED'};
}
export function rebindEntry(runtime,options={}) {
  if(!options.entry)fail('ENTRY_FOLDER_REQUIRED');
  const entry=path.resolve(options.entry),file=path.join(entry,'references/runtime.json');
  if(!runtime.discoveryRoots.some(root=>norm(path.dirname(entry))===norm(root))||path.basename(entry)!=='skill-governance')fail('ENTRY_ROOT_NOT_CONFIGURED');
  if(fs.lstatSync(entry).isSymbolicLink()||fs.lstatSync(file).isSymbolicLink())fail('ALIASED_ENTRY_POINTER');
  if(!/^---\r?\nname: skill-governance\r?\n/.test(fs.readFileSync(path.join(entry,'SKILL.md'),'utf8')))fail('ENTRY_IDENTITY_MISMATCH');
  const before=fs.readFileSync(file),old=readJson(file);if(old.schema!=='sgs/skill-runtime-pointer@1')fail('ENTRY_POINTER_INVALID');
  const next=pointer({project:options.project??runtime.projectRoot,config:runtime.configured?runtime.configPath:old.config_path,node:options.node});
  const backup=path.join(path.dirname(runtime.configPath),'.sgs/deployment-receipts','rebind-'+randomUUID()+'.json');
  writeJson(backup,{schema:'sgs/entry-rebind@1',entry_path:entry,pointer_path:file,before_sha256:sha(before),before_base64:before.toString('base64'),old_pointer:old,new_pointer:next});
  replaceCompared(file,next,before);
  return {entry_directory:entry,backup_path:backup,runtime:next,desktop_observation:'UNKNOWN',next_action:'DESKTOP_RESTART_OR_NEW_SESSION_REQUIRED'};
}
export function scanScopeFor(runtime) {
  const roots=runtime.discoveryRoots.map((folder,i)=>({id:'user-'+i,kind:'USER_SKILLS',path:folder}));
  for(const folder of runtime.discoveryRoots)if(path.basename(path.dirname(folder))==='.codex'&&fs.existsSync(path.join(folder,'.system')))
    roots.push({id:'system-'+roots.length,kind:'SYSTEM_MANAGED',path:path.join(folder,'.system')});
  return {schema:'sgs/scan-scope@1',scope_id:'new-user-read-only',host:{product:'Codex Desktop',version:null,version_status:'UNKNOWN'},roots,follow_link_targets:[],desktop_catalog_observation:null};
}
export function bootstrap(runtime) {
  if(!runtime.configured)fail('INIT_REQUIRED');
  if(runtime.profile.production_writes_enabled)fail('BOOTSTRAP_REQUIRES_READ_ONLY_PROFILE');
  const before=fs.readFileSync(runtime.configPath),scope=scanScopeFor(runtime),scan=scanScope(scope);
  const ledger=buildM3(scan,scope,randomUUID()),actions=buildM4(ledger,scan,scope,randomUUID(),null),dryRun=buildDryRun(scan);
  const index={schema:'sgs/observed-index@1',generated_at:new Date().toISOString(),evidence_scope:'Current filesystem scope only; no Desktop exposure observation',
    counts:{assets:ledger.assets.length,installations:scan.entries.length,logical_paths:scan.entries.length,exposures_directly_observed:0,exposures_unknown:scan.entries.length},
    installations:scan.entries,coverage:scan.scope.coverage,errors:scan.errors};
  const folder=path.join(path.dirname(runtime.configPath),'.sgs/inventory',randomUUID());
  const mapping={index:'index.json',ledger:'ledger.json',actions:'actions.json',scan:'scan.json',dry_run:'dry-run.json'};
  publishDirectory(folder,temp=>{for(const [name,data]of Object.entries({'scope.json':scope,'scan.json':scan,'ledger.json':ledger,'actions.json':actions,'dry-run.json':dryRun,'index.json':index}))writeJson(path.join(temp,name),data);});
  const updated={...runtime.profile,production_writes_enabled:false,artifacts:{...runtime.profile.artifacts,...Object.fromEntries(Object.entries(mapping).map(([key,name])=>[key,path.join(folder,name)]))}};
  validateProfile(updated);replaceCompared(runtime.configPath,updated,before);
  return {schema:'sgs/bootstrap@1',status:scan.scope.coverage,inventory:index.counts,errors:scan.errors,artifact_directory:folder,config:runtime.configPath,
    production_writes_enabled:false,skill_changes:0,desktop_observation:'UNKNOWN',next_action:'Run status or audit; install-entry installs only the thin user entry'};
}
