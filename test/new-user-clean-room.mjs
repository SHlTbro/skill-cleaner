import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const workspace=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const zip=path.resolve(process.argv[2]);
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'sgs-clean-room-'));
const home=path.join(temp,'New HOME'),portable=path.join(temp,'SGS project with spaces');
const env={...process.env,HOME:home,USERPROFILE:home,SGS_CONFIG:''};
const commands=[],checks=[];
const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
function check(name,fn){fn();checks.push({name,status:'PASS'});}
function run(args,cwd=portable){const r=spawnSync(process.execPath,['src/sgs.mjs',...args],{cwd,env,encoding:'utf8',timeout:30000});let data;try{data=JSON.parse(r.stdout);}catch{}commands.push({command:[process.execPath,'src/sgs.mjs',...args],cwd,exit:r.status,stdout:r.stdout,stderr:r.stderr});return{exit:r.status,data};}
const powershell=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',"Add-Type -AssemblyName System.IO.Compression.FileSystem; $p=([Console]::In.ReadToEnd()|ConvertFrom-Json); [IO.Compression.ZipFile]::ExtractToDirectory($p.zip,$p.out)"],{input:JSON.stringify({zip,out:portable}),encoding:'utf8',env,windowsHide:true});
assert.equal(powershell.status,0,powershell.stderr);
const manifest=JSON.parse(fs.readFileSync(path.join(portable,'PORTABLE-MANIFEST.json'),'utf8'));
check('ZIP manifest hashes',()=>{for(const item of manifest.files)assert.equal(hash(fs.readFileSync(path.join(portable,item.path))),item.sha256,item.path);});
const actualFiles=[];function files(dir,relative=''){for(const entry of fs.readdirSync(dir,{withFileTypes:true})){const name=relative?relative+'/'+entry.name:entry.name;if(entry.isDirectory())files(path.join(dir,entry.name),name);else actualFiles.push(name);}}files(portable);
check('ZIP explicit files only; no author profile/state',()=>assert.deepEqual(actualFiles.sort(),[...manifest.files.map(f=>f.path),'PORTABLE-MANIFEST.json'].sort()));
for(const root of ['.codex/skills','.agents/skills','.codex/skills/.system'])fs.mkdirSync(path.join(home,root),{recursive:true});
const fixtureFiles=[];
for(const [name,root,skill]of [['alpha','.codex/skills','alpha'],['beta','.agents/skills','beta'],['dup-a','.codex/skills','duplicate'],['dup-b','.agents/skills','duplicate'],['managed','.codex/skills/.system','managed']]){
  const file=path.join(home,root,name,'SKILL.md');fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,`---\nname: ${skill}\ndescription: isolated harmless fixture\n---\nInstruction only.\n`);fixtureFiles.push({file,hash:hash(fs.readFileSync(file))});
}
check('help',()=>assert.equal(run(['--help']).exit,0));
check('doctor before init',()=>assert.equal(run(['doctor']).exit,0));
check('init',()=>assert.equal(run(['init']).exit,0));
check('doctor after init',()=>assert.equal(run(['doctor']).exit,0));
check('bootstrap',()=>{const r=run(['bootstrap']);assert.equal(r.exit,0);assert.equal(r.data.status,'COMPLETE');assert.equal(r.data.inventory.installations,5);});
check('status inventory with duplicate group and managed action',()=>{const r=run(['status']);assert.equal(r.exit,0);assert.equal(r.data.index.installations,5);assert.equal(r.data.duplicates.package_groups,1);assert.equal(r.data.actions.MANAGED_NO_TOUCH,1);assert.equal(r.data.runtime.production_writes_enabled,false);});
check('audit',()=>assert.equal(run(['audit']).exit,0));
const installed=run(['install-entry']);
check('entry install',()=>{assert.equal(installed.exit,0);assert.equal(installed.data.next_action,'DESKTOP_RESTART_OR_NEW_SESSION_REQUIRED');assert.equal(installed.data.desktop_observation,'UNKNOWN');});
const entry=path.join(home,'.codex/skills/skill-governance'),pointerFile=path.join(entry,'references/runtime.json');
let pointer=JSON.parse(fs.readFileSync(pointerFile,'utf8'));
check('entry real files and executable/config pointers',()=>{assert.equal(pointer.project_root,portable);assert.equal(pointer.config_path,path.join(portable,'.sgs.local.json'));assert.equal(pointer.node_command,process.execPath);assert.ok(fs.existsSync(pointer.node_command));assert.equal(fs.readFileSync(path.join(entry,'SKILL.md'),'utf8'),fs.readFileSync(path.join(portable,'product/skill-governance/SKILL.md'),'utf8'));});
const entryHash=hash(fs.readFileSync(pointerFile));
check('duplicate install refuses without overwrite',()=>{assert.notEqual(run(['install-entry']).exit,0);assert.equal(hash(fs.readFileSync(pointerFile)),entryHash);});
const moved=path.join(temp,'Relocated SGS with spaces');fs.renameSync(portable,moved);
check('rebind after actual project move',()=>{const r=run(['rebind-entry','--entry',entry,'--project',moved],moved);assert.equal(r.exit,0);assert.ok(fs.existsSync(r.data.backup_path));pointer=JSON.parse(fs.readFileSync(pointerFile,'utf8'));assert.equal(pointer.project_root,moved);assert.equal(pointer.config_path,path.join(moved,'.sgs.local.json'));const backup=JSON.parse(fs.readFileSync(r.data.backup_path,'utf8'));assert.equal(hash(Buffer.from(backup.before_base64,'base64')),entryHash);});
// Bootstrap again rebinds old absolute inventory paths after code/state relocation.
check('read-only inventory refresh after relocation',()=>assert.equal(run(['bootstrap'],moved).exit,0));
check('Skill pointer status invocation',()=>{const r=spawnSync(pointer.node_command,[path.join(pointer.project_root,pointer.entry),'--config',pointer.config_path,'status'],{env,cwd:moved,encoding:'utf8',timeout:30000});assert.equal(r.status,0,r.stderr);assert.equal(JSON.parse(r.stdout).index.installations,6);commands.push({command:'Skill runtime pointer → status',exit:r.status});});
const custom=path.join(temp,'custom profile with spaces','sgs config.json');
check('custom profile path with spaces',()=>{assert.equal(run(['--config',custom,'init'],moved).exit,0);assert.equal(run([`--config=${custom}`,'bootstrap'],moved).exit,0);assert.equal(run(['--config',custom,'doctor'],moved).exit,0);});
check('new user apply stays read-only',()=>{const r=run(['apply','DOES-NOT-EXIST','--authorized'],moved);assert.notEqual(r.exit,0);assert.equal(commands.at(-1).stderr.includes('READ_ONLY_PROFILE'),true);});
check('fixture packages byte unchanged including managed',()=>{for(const f of fixtureFiles)assert.equal(hash(fs.readFileSync(f.file)),f.hash);});
check('entry Skill content unchanged by rebind',()=>assert.equal(fs.readFileSync(path.join(entry,'SKILL.md'),'utf8'),fs.readFileSync(path.join(moved,'product/skill-governance/SKILL.md'),'utf8')));
const evidence={schema:'sgs/new-user-clean-room@1',status:'PASS',zip,manifest_files:manifest.files.length,fixture:temp,isolated_home:home,checks,commands,
 desktop_ui_observation:'NOT_PERFORMED; fixture is not installed in real Desktop HOME',skill_pointer_functional_smoke:'PASS',
 real_user_skill_writes:0,real_cold_store_writes:0,yy_writes:0,plugin_system_writes:0,production_writes_enabled:false};
fs.writeFileSync(path.join(workspace,'outputs/runs/new-user-clean-room-20261005.json'),JSON.stringify(evidence,null,2)+'\n');
console.log(JSON.stringify({status:evidence.status,checks:checks.length,manifest_files:manifest.files.length,fixture:temp,real_user_skill_writes:0}));
