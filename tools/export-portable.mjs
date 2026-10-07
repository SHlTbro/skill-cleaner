import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, lstatSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { parseOptions } from '../src/runtime/arguments.mjs';
import { publishDirectory } from '../src/deployment.mjs';
import path from 'node:path';
import { projectRoot } from '../src/runtime/config.mjs';
const {options:values,positionals}=parseOptions(process.argv.slice(2),{values:['out']});
if(positionals.length)throw new Error('UNEXPECTED_ARGUMENT');
if(!values.out)throw new Error('--out is required');
const out=path.resolve(values.out);
const relative=path.relative(out,projectRoot);
if(relative===''||(!relative.startsWith('..')&&!path.isAbsolute(relative)))throw new Error('EXPORT_TARGET_CONTAINS_SOURCE');
if(['src','tools','docs','config','product'].includes(path.relative(projectRoot,out).split(path.sep)[0]))throw new Error('EXPORT_TARGET_INSIDE_CODE_DIRECTORY');
if(existsSync(out))throw new Error('EXPORT_OUTPUT_EXISTS_NO_OVERWRITE');
const files=[
  'package.json','LICENSE','README.md','AGENTS.md','CONTEXT.md','sgs.ps1','.gitignore','.ignore','config/sgs.example.json',
  'docs/README.md','docs/ARCHITECTURE.md','docs/MIGRATION.md',
  'release/NEW-USER-ACCEPTANCE.json','release/FINAL-DESKTOP-ACCEPTANCE.json',
  'release/KNOWN-LIMITATIONS.md','release/RELEASE-MANIFEST.json',
  'src/sgs.mjs','src/cli.mjs','src/app.mjs','src/cleanup.mjs','src/runtime/config.mjs',
  'src/deployment.mjs','src/runtime/json.mjs','src/runtime/arguments.mjs',
  'src/core/package-fingerprint.mjs','src/core/filesystem-exposure-backend.mjs','src/core/production-authorization.mjs',
  'src/filesystem-exposure-backend.mjs','src/production-authorization.mjs',
  'src/scan.mjs','src/profile-dry-run.mjs','src/build-governance-ledgers.mjs','src/desktop-catalog-evidence.mjs',
  'product/skill-governance/SKILL.md',
  'tools/render-skill-entry.mjs','tools/render-scan-scope.mjs','tools/export-portable.mjs',
  'tools/prepare-cleanup-baseline.mjs','tools/close-cleanup-candidates.mjs',
];
// Explicit files prevent exporting history, authorization, cold assets, or plugin packages.
for(const file of files){
  const source=path.join(projectRoot,file);
  const rel=path.relative(realpathSync.native(projectRoot),realpathSync.native(source));
  if(rel.startsWith('..')||path.isAbsolute(rel)||lstatSync(source).isSymbolicLink()||!lstatSync(source).isFile())throw new Error('EXPORT_SOURCE_NOT_ORDINARY_FILE');
}
const manifest=[];
publishDirectory(out,temp=>{
for(const file of files){
  const destination=path.join(temp,file);
  mkdirSync(path.dirname(destination),{recursive:true});
  copyFileSync(path.join(projectRoot,file),destination);
  const bytes=readFileSync(destination);
  manifest.push({path:file,size_bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')});
}
writeFileSync(path.join(temp,'PORTABLE-MANIFEST.json'),JSON.stringify({schema:'sgs/portable-package@1',created_at:new Date().toISOString(),files:manifest,
  excludes:['local profile','historical inventory and Desktop evidence','authorizations','receipts','cold-store assets','session logs','historical tools','YY/plugin/system assets'],
  default_production_writes_enabled:false,requires_new_host_evidence:true},null,2)+'\n');
for(const item of manifest)if(createHash('sha256').update(readFileSync(path.join(temp,item.path))).digest('hex')!==item.sha256)throw new Error('PORTABLE_MANIFEST_MISMATCH');
});
console.log(JSON.stringify({portable_directory:out,file_count:manifest.length,local_state_exported:false,authorizations_exported:false}));
