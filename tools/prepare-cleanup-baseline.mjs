import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { parseOptions } from '../src/runtime/arguments.mjs';
import { loadRuntime, readJson } from '../src/runtime/config.mjs';
import { readDesktopCatalogObservations } from '../src/desktop-catalog-evidence.mjs';
import { scanScope } from '../src/scan.mjs';
import { packageFingerprint } from '../src/core/package-fingerprint.mjs';

// One explicit refresh using the existing scanner, not a second inventory engine.
const { options: values } = parseOptions(process.argv.slice(2), { values:['config','session','out','run-id'] });
if (!values.session || !values.out || !values['run-id']) throw new Error('--session --out --run-id required');
const runtime = loadRuntime({ configFile: values.config });
const out = path.resolve(values.out);
if (existsSync(out)) throw new Error('BASELINE_EXISTS_NO_RESCAN');
const desktop = readDesktopCatalogObservations({ sessionFile: path.resolve(values.session), workspace: runtime.projectRoot }).at(-1);
if (!desktop) throw new Error('CURRENT_DESKTOP_CATALOG_MISSING');
const norm = value => path.resolve(value).toLowerCase();
const sha = value => createHash('sha256').update(value).digest('hex');
const roots = runtime.discoveryRoots.map((folder, i) => ({ id: `user-${i}`, kind: 'USER_SKILLS', path: folder }));
for (const folder of runtime.discoveryRoots) if (path.basename(path.dirname(folder)) === '.codex')
  roots.push({ id: 'system', kind: 'SYSTEM_MANAGED', path: path.join(folder, '.system') });
// Only active plugin versions observed in this Desktop catalog are in this scope.
const pluginRoots = new Set();
for (const entry of desktop.entries) {
  const file = entry.skill_file.replaceAll('\\', '/');
  if (!file.includes('/.codex/plugins/cache/')) continue;
  const match = file.match(/^(.*\/skills)\//);
  if (match) pluginRoots.add(path.resolve(match[1]));
}
for (const [i, folder] of [...pluginRoots].entries()) roots.push({ id: `active-plugin-${i}`, kind: 'PLUGIN_MANAGED', path: folder });
const follow = [];
for (const root of runtime.discoveryRoots) for (const name of readdirSync(root)) {
  const folder = path.join(root, name);
  if (!lstatSync(folder).isSymbolicLink()) continue;
  try { follow.push(realpathSync.native(folder)); } catch { /* scanner records broken links */ }
}
const scope = { schema: 'sgs/scan-scope@1', scope_id: values['run-id'], roots, follow_link_targets: follow,
  host: { product: 'Codex Desktop', version: null }, desktop_catalog_observation: {
    evidence_type: 'PERSISTED_DESKTOP_DEVELOPER_SKILL_CATALOG', source_file: desktop.source_file,
    source_line: desktop.source_line, source_record_sha256: desktop.source_record_sha256,
    timestamp: desktop.timestamp, observed_installations: desktop.installation_count, global_catalog_count: null } };
const scan = scanScope(scope, { runId: values['run-id'] });
const producer = runtime.artifact('producer');
const observed = new Set(desktop.logical_paths.map(norm));
const installations = scan.entries.map(entry => {
  const pkg = packageFingerprint(entry.package_path);
  const relative = entry.package_path.replaceAll('\\', '/').toLowerCase();
  const managed = entry.root_kinds.some(kind => kind.includes('MANAGED'));
  const yy = relative.includes('/skills/yy/') || relative.endsWith('/skills/yy');
  const runtimeChild = yy || relative.includes('/skills/tt/') || relative.endsWith('/skills/tt');
  const nested = !runtime.discoveryRoots.some(root => norm(path.dirname(entry.package_path)) === norm(root));
  const p = (producer?.records ?? []).find(row => row.entity_type === 'skill_installation'
    && norm(path.dirname(row.installation_path)) === norm(entry.package_path));
  return { installation_id: `installation-${sha(norm(entry.package_path)).slice(0, 20)}`,
    logical_path: entry.package_path, entry_path: entry.logical_path, real_path: pkg.real_root,
    real_entry_path: entry.real_target, package_hash: pkg.content_hash,
    package_fingerprint: pkg.fingerprint, package_status: pkg.status, package_files: pkg.file_count,
    fingerprint_rules: pkg.volatile_generated_exclusions, fingerprint_issues: pkg.issues,
    name: entry.metadata.name ?? path.basename(entry.package_path), description: entry.metadata.description,
    scope: managed ? entry.root_kinds.find(kind => kind.includes('MANAGED')) : nested ? 'NESTED_USER_ENTRY' : 'USER_GLOBAL',
    producer: p?.producer ?? 'UNKNOWN', producer_evidence: p?.producer_evidence ?? [],
    owner: managed ? 'MANAGED' : 'USER_SCOPE_NOT_YET_OWNER_CLOSED', managed,
    runtime_dependency: runtimeChild, references: { status: 'NOT_SCREENED', known_consumer_scope: [] },
    current_desktop_evidence: { status: observed.has(norm(entry.package_path)) ? 'DISCOVERED' : 'NOT_IN_CURRENT_SESSION_CATALOG',
      source_ref: 'desktop_catalog', observed_at: desktop.timestamp },
    classification: managed || runtimeChild ? 'NO_TOUCH' : 'HOLD_UNKNOWN',
    reason: managed ? 'System/plugin managed' : runtimeChild ? 'Protected YY or TT runtime package' : 'Current package refreshed; candidate-specific closure required',
    cleanup_confidence: 0, reversible: false, critical_dependency: runtimeChild,
    canonical_retained: false, before_state_complete: false, rollback_ready: false };
});
for (const link of scan.links.filter(row => row.status === 'broken_or_unreadable')) installations.push({
  installation_id: `installation-${sha(norm(link.logical_path)).slice(0, 20)}`, logical_path: link.logical_path,
  real_path: null, package_hash: null, name: path.basename(link.logical_path), scope: 'USER_GLOBAL',
  producer: 'UNKNOWN', managed: false, runtime_dependency: false,
  references: { status: 'NOT_SCREENED' }, current_desktop_evidence: { status: 'NOT_IN_CURRENT_SESSION_CATALOG', source_ref: 'desktop_catalog' },
  classification: 'HOLD_UNKNOWN', reason: 'Broken user link; existing backend cannot yet transact incomplete packages',
  link_target: link.link_target, link_status: link.status, cleanup_confidence: 0,
  reversible: false, critical_dependency: false, canonical_retained: false, before_state_complete: false, rollback_ready: false });
const counts = { filesystem_logical_skill_paths: scan.counts.logical_skill_paths,
  filesystem_unique_real_targets: scan.counts.unique_real_targets, broken_entries: scan.links.filter(row => row.status === 'broken_or_unreadable').length,
  desktop_observed_installations: desktop.installation_count, desktop_global_total: null,
  managed: installations.filter(row => row.managed).length, hold_unknown: installations.filter(row => row.classification === 'HOLD_UNKNOWN').length,
  auto_clean: 0, review_candidates: 0, no_touch: installations.filter(row => row.classification === 'NO_TOUCH').length };
const baseline = { schema: 'sgs/cleanup-baseline@1', run_id: values['run-id'], generated_at: new Date().toISOString(),
  host_key: runtime.hostKey, config: runtime.configPath, scope, scan_status: scan.scope.coverage,
  scan_exit_code: scan.scope.coverage === 'COMPLETE' ? 0 : 2, scan_errors: scan.errors,
  desktop_catalog: desktop, counts, installations,
  semantics: 'Filesystem paths, broken installation entries, real targets and actual Desktop session catalog counts are distinct. The catalog is bounded, not a global host completeness claim.',
  writes_to_discovery: 0, permanent_deletes: 0 };
mkdirSync(path.dirname(out), { recursive: true });
writeFileSync(out.replace(/\.json$/, '.scan.json'), JSON.stringify(scan, null, 2) + '\n', { flag: 'wx' });
writeFileSync(out, JSON.stringify(baseline, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ output: out, scan_status: baseline.scan_status, scan_exit_code: baseline.scan_exit_code, counts, errors: scan.errors.map(row => ({ path: row.path, code: row.code })) }, null, 2));
process.exitCode = baseline.scan_exit_code;
