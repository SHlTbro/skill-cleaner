import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { parseOptions } from '../src/runtime/arguments.mjs';
import { readJson, loadRuntime } from '../src/runtime/config.mjs';
import { observeInstallation } from '../src/core/filesystem-exposure-backend.mjs';

const { options: values } = parseOptions(process.argv.slice(2), { values:['baseline','screen','config'] });
if (!values.baseline || !values.screen) throw new Error('--baseline --screen required');
const file = path.resolve(values.baseline), screenFile = path.resolve(values.screen);
const baseline = readJson(file), screen = readJson(screenFile), runtime = loadRuntime({ configFile: values.config });
if (baseline.candidate_closure) throw new Error('BASELINE_ALREADY_CLOSED');
if (baseline.host_key !== runtime.hostKey) throw new Error('BASELINE_HOST_MISMATCH');
const norm = value => path.resolve(value).toLowerCase();
const inside = (child, root) => norm(child) === norm(root) || norm(child).startsWith(norm(root) + path.sep);
const observed = baseline.desktop_catalog.logical_paths.map(norm);
const beforeHash = createHash('sha256').update(readFileSync(file)).digest('hex');
const ready = [];
for (const candidate of screen.candidates) {
  const target = path.resolve(candidate.logical_path);
  const rows = baseline.installations.filter(row => inside(row.logical_path, target));
  if (!candidate.recommendation?.startsWith('AUTO_CLEAN_AFTER_')) {
    for (const row of rows) if (!row.managed && !row.runtime_dependency) {
      row.reason = candidate.reason;
      row.classification = candidate.category.startsWith('C4') ? 'NO_TOUCH' : candidate.category.startsWith('A1_PACKAGE_DUPLICATE_WITH') ? 'REVIEW_CANDIDATE' : 'HOLD_UNKNOWN';
      row.cleanup_confidence = candidate.cleanup_confidence ?? 0;
      row.screen_ref = candidate.id;
    }
    continue;
  }
  if (candidate.cleanup_confidence < .98 || candidate.managed || candidate.critical_dependency || candidate.runtime_dependency)
    throw new Error(`SCREEN_INELIGIBLE: ${candidate.id}`);
  if (!runtime.discoveryRoots.some(root => norm(path.dirname(target)) === norm(root))) throw new Error('TARGET_NOT_TOP_LEVEL_INSTALLATION');
  const before = observeInstallation(target), canonical = observeInstallation(candidate.canonical);
  if (!before.exists || !canonical.exists || before.package_content_hash !== candidate.package_hash
    || canonical.package_content_hash !== before.package_content_hash) throw new Error(`PACKAGE_DRIFT: ${candidate.id}`);
  if (!rows.length || rows.some(row => row.managed || row.runtime_dependency)) throw new Error(`PROTECTED_OR_MISSING_TARGET: ${candidate.id}`);
  const exposure = rows.filter(row => row.entry_path).map(row => row.entry_path);
  const canonicalExposure = exposure.map(entry => path.join(canonical.logical_path, path.relative(target, entry)));
  if (!exposure.length || exposure.some(entry => !observed.includes(norm(path.dirname(entry))))
    || canonicalExposure.some(entry => !observed.includes(norm(path.dirname(entry))))) throw new Error(`DESKTOP_PATHS_NOT_OBSERVED: ${candidate.id}`);
  const closed = { installation_id: `transaction-${candidate.id}`, kind: exposure.length === 1 && norm(rows[0].logical_path) === norm(target) ? 'SKILL_INSTALLATION' : 'PACKAGE_CONTAINER',
    logical_path: target, real_path: before.real_path, package_hash: before.package_content_hash,
    package_fingerprint: before.package_fingerprint, name: path.basename(target), scope: 'USER_GLOBAL',
    producer: 'UNKNOWN', producer_evidence: candidate.known_producer_evidence ?? candidate.producer_evidence ?? candidate.producer_limitation,
    managed: false, runtime_dependency: false, owner: 'USER', owner_evidence: candidate.owner_evidence,
    references: candidate.references, current_desktop_evidence: { status: 'DISCOVERED', source_ref: 'desktop_catalog' },
    classification: 'AUTO_CLEAN', category: candidate.category, cleanup_confidence: candidate.cleanup_confidence,
    reversible: true, critical_dependency: false, canonical_retained: true,
    before_state_complete: true, rollback_ready: true, before_snapshot: before, canonical_snapshot: canonical,
    canonical_path: canonical.logical_path, exposure_paths: exposure, canonical_exposure_paths: canonicalExposure,
    reason: candidate.reason, restore_path: target, screen_ref: candidate.id,
    dependencies: [{ blocks_move: false, reason: candidate.references.status,
      evidence: screenFile, limitation: 'Known bounded consumer scope closed; no machine-wide absence claim' }] };
  for (const row of rows) {
    if (closed.kind === 'SKILL_INSTALLATION' && norm(row.logical_path) === norm(target)) Object.assign(row, closed);
    else { row.classification = 'AUTO_CLEAN_MEMBER'; row.transaction_id = closed.installation_id; row.reason = closed.reason; }
  }
  if (closed.kind === 'PACKAGE_CONTAINER') baseline.installations.push(closed);
  for (const row of baseline.installations.filter(row => inside(row.logical_path, canonical.logical_path))) {
    if (!row.managed && !row.runtime_dependency) { row.classification = 'KEEP_ACTIVE'; row.reason = 'Retained complete canonical and current cross-host consumers'; }
  }
  ready.push({ installation_id: closed.installation_id, target, canonical: canonical.logical_path,
    before_state_hash: before.state_hash, package_hash: before.package_content_hash, exposure_count: exposure.length });
}
baseline.candidate_closure = { generated_at: new Date().toISOString(), screen_file: screenFile,
  screen_sha256: createHash('sha256').update(readFileSync(screenFile)).digest('hex'), initial_baseline_sha256: beforeHash,
  ready, authorization_required: true, all_other_objects_preserved: true };
baseline.counts.auto_clean = ready.length;
baseline.counts.auto_clean_exposures = ready.reduce((n, row) => n + row.exposure_count, 0);
baseline.counts.hold_unknown = baseline.installations.filter(row => row.classification === 'HOLD_UNKNOWN').length;
baseline.counts.review_candidates = baseline.installations.filter(row => row.classification === 'REVIEW_CANDIDATE').length;
baseline.counts.no_touch = baseline.installations.filter(row => row.classification === 'NO_TOUCH').length;
baseline.counts.keep_active = baseline.installations.filter(row => row.classification === 'KEEP_ACTIVE').length;
const backup = file.replace(/\.json$/, '.pre-closure.json');
if (existsSync(backup)) throw new Error('CLOSURE_BACKUP_EXISTS');
writeFileSync(backup, readFileSync(file), { flag: 'wx' });
writeFileSync(file, JSON.stringify(baseline, null, 2) + '\n');
console.log(JSON.stringify({ status: 'CANDIDATE_CLOSURE_READY', baseline: file, ready, counts: baseline.counts, discovery_writes: 0 }, null, 2));
