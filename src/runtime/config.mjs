import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
import { readJson } from './json.mjs';
export { readJson } from './json.mjs';
const invalid=(field,expected,value)=>{throw Object.assign(new Error(`INVALID_PROFILE_FIELD: field=${field} expected=${expected} actual=${Array.isArray(value)?'array':value===null?'null':typeof value}`),{code:'INVALID_PROFILE_FIELD',field,expected,actual:Array.isArray(value)?'array':value===null?'null':typeof value});};
export function validateProfile(profile) {
  if (!profile || typeof profile!=='object' || Array.isArray(profile)) invalid('$','object',profile);
  if(profile.schema!=='sgs/runtime-profile@1') invalid('schema','sgs/runtime-profile@1',profile.schema);
  for(const key of ['profile_name','cold_store','authorization_directory','native_desktop'])
    if(typeof profile[key]!=='string'||!profile[key].trim()) invalid(key,'non-empty string',profile[key]);
  if(!Array.isArray(profile.discovery_roots)||!profile.discovery_roots.length) invalid('discovery_roots','non-empty string array',profile.discovery_roots);
  profile.discovery_roots.forEach((value,i)=>{if(typeof value!=='string'||!value.trim())invalid(`discovery_roots[${i}]`,'non-empty string',value);});
  if(profile.host_binding!==null&&typeof profile.host_binding!=='string')invalid('host_binding','string or null',profile.host_binding);
  if(typeof profile.production_writes_enabled!=='boolean')invalid('production_writes_enabled','boolean',profile.production_writes_enabled);
  for(const key of ['artifacts','candidates'])if(!profile[key]||typeof profile[key]!=='object'||Array.isArray(profile[key]))invalid(key,'object',profile[key]);
  for(const [key,value]of Object.entries(profile.artifacts))if(typeof value!=='string'||!value.trim())invalid(`artifacts.${key}`,'non-empty path string',value);
  for(const [key,value]of Object.entries(profile.candidates))if(!value||typeof value!=='object'||Array.isArray(value))invalid(`candidates.${key}`,'object',value);
  return profile;
}
export function defaultProfile() {
  return { schema: 'sgs/runtime-profile@1', profile_name: 'new-host-read-only',
    discovery_roots: ['${HOME}/.codex/skills', '${HOME}/.agents/skills'],
    cold_store: '.sgs/cold-store', authorization_directory: '.sgs/authorizations',
    host_binding: null, production_writes_enabled: false,
    native_desktop: 'UNKNOWN', artifacts: {}, candidates: {} };
}
export function loadRuntime({ configFile, env = process.env, diagnostic = false, allowMissingConfig = false } = {}) {
  const configPath = path.resolve(configFile || env.SGS_CONFIG || path.join(projectRoot, '.sgs.local.json'));
  const configured = existsSync(configPath);
  if (!configured && (configFile || env.SGS_CONFIG) && !allowMissingConfig)
    throw Object.assign(new Error(`CONFIG_NOT_FOUND: ${configPath}`), { code:'CONFIG_NOT_FOUND' });
  const profile = configured ? readJson(configPath) : defaultProfile();
  validateProfile(profile);
  const base = path.dirname(configPath);
  const home = path.resolve(process.platform==='win32' ? env.USERPROFILE || os.homedir() : env.HOME || os.homedir());
  const resolve = value => {
    if (typeof value !== 'string' || !value.trim()) throw new Error('INVALID_PROFILE_PATH');
    let expanded = value.replaceAll('${HOME}', home).replaceAll('${PROJECT}', projectRoot);
    if (expanded === '~') expanded = home;
    else if (/^~[\\/]/.test(expanded)) expanded = path.join(home, expanded.slice(2));
    if (/\$\{[^}]+\}/.test(expanded)) throw new Error('UNRESOLVED_PROFILE_PATH_VARIABLE');
    return path.resolve(base, expanded);
  };
  if (!Array.isArray(profile.discovery_roots) || !profile.discovery_roots.length) throw new Error('DISCOVERY_ROOTS_REQUIRED');
  const discoveryRoots = profile.discovery_roots.map(resolve);
  const coldStore = resolve(profile.cold_store);
  const hostKey = createHash('sha256').update(JSON.stringify({ platform: process.platform,
    hostname: os.hostname(), home: path.resolve(home), discovery_roots: discoveryRoots })).digest('hex');
  const hostMatches = profile.host_binding === hostKey;
  const artifactPaths = Object.fromEntries(Object.entries(profile.artifacts || {}).map(([key, value]) => [key, resolve(value)]));
  const artifact = key => {
    const file = artifactPaths[key];
    if (!file) return null;
    if (!existsSync(file)) throw new Error(`ARTIFACT_MISSING: ${key}: ${file}`);
    return readJson(file);
  };
  const artifactDiagnostics={};
  let desktopCapability=null;
  if(hostMatches)try{desktopCapability=artifact('filesystem_capability');}catch(error){if(!diagnostic)throw error;artifactDiagnostics.filesystem_capability=error.message;}
  return { projectRoot, configPath, configured, profile, home, hostKey, hostMatches, resolve, artifactDiagnostics,
    discoveryRoots, coldStore, authorizationDirectory: resolve(profile.authorization_directory),
    artifactPaths, artifact,
    desktopCapability,
    writesEnabled: profile.production_writes_enabled === true && hostMatches && process.platform === 'win32' };
}
export function requireWritableHost(runtime) {
  if (runtime.profile.production_writes_enabled !== true) throw new Error('READ_ONLY_PROFILE');
  if (!runtime.hostMatches) throw new Error('HOST_BINDING_MISMATCH');
  if (process.platform !== 'win32') throw new Error('PLATFORM_WRITE_NOT_VERIFIED');
}
