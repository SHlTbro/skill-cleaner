import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync,
  readdirSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { FilesystemExposureBackend, observeInstallation } from './core/filesystem-exposure-backend.mjs';
import { assertProductionAuthorization } from './core/production-authorization.mjs';
import { requireWritableHost } from './runtime/config.mjs';
import { parseSkillCatalog } from './desktop-catalog-evidence.mjs';
import { readJson, readReceiptCollection } from './runtime/json.mjs';

const hash = data => createHash('sha256').update(data).digest('hex');
const norm = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
const contained = (child, parent) => {
  const relative = path.relative(norm(parent), norm(child));
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
};
const json = readJson;
const error = (code, detail = '') => Object.assign(new Error(`${code}${detail ? `: ${detail}` : ''}`), { code });
const backendFor = runtime => new FilesystemExposureBackend({ discoveryRoots: runtime.discoveryRoots,
  coldStore: runtime.coldStore, desktopCapability: runtime.desktopCapability });
const batchDirectory = runtime => path.join(runtime.coldStore, 'batches');
function batchFile(runtime, id) {
  if (!/^BATCH-[A-Z0-9_-]{1,75}$/.test(id)) throw error('INVALID_CLEANUP_BATCH_ID');
  return path.join(batchDirectory(runtime), `${id}.json`);
}
function controlDirectory(folder) {
  mkdirSync(folder, { recursive: true });
  if (lstatSync(folder).isSymbolicLink() || norm(realpathSync.native(folder)) !== norm(folder)) throw error('ALIASED_CLEANUP_CONTROL_DIRECTORY', folder);
}
function atomicJson(file, value) {
  controlDirectory(path.dirname(file));
  const temporary = `${file}.${randomUUID()}.tmp`;
  const fd = openSync(temporary, 'wx');
  try { writeFileSync(fd, JSON.stringify(value, null, 2) + '\n'); fsyncSync(fd); }
  finally { closeSync(fd); }
  try { renameSync(temporary, file); }
  catch (cause) { try { unlinkSync(temporary); } catch {} throw cause; }
}
function save(runtime, batch) {
  batch.updated_at = new Date().toISOString();
  atomicJson(batchFile(runtime, batch.id), batch);
  return batch;
}
function withBatchLock(runtime, work) {
  const folder = path.join(runtime.coldStore, 'locks'); controlDirectory(folder);
  const file = path.join(folder, 'cleanup-batches.lock');
  let fd;
  try { fd = openSync(file, 'wx'); }
  catch (cause) { if (cause.code === 'EEXIST') throw error('CONCURRENT_CLEANUP_BATCH'); throw cause; }
  try { writeFileSync(fd, JSON.stringify({ pid: process.pid })); return work(); }
  finally { closeSync(fd); unlinkSync(file); }
}
export function readBatches(runtime, options = {}) {
  const folder = batchDirectory(runtime);
  return readReceiptCollection(folder,{...options,validate:row=>Boolean(row?.id&&row?.state&&row?.created_at&&Array.isArray(row.items))})
    .sort((a, b) => (a.created_at??'').localeCompare(b.created_at??''));
}
function assertPreviousBatch(runtime, currentId = null) {
  const prior = readBatches(runtime).filter(batch => batch.id !== currentId);
  const unfinished = prior.find(batch => !['PASS', 'ROLLED_BACK', 'FAILED_ROLLED_BACK', 'PREPARE_FAILED', 'EMPTY'].includes(batch.state));
  if (unfinished) throw error('PREVIOUS_BATCH_NOT_PASS', `${unfinished.id}: ${unfinished.state}`);
  const applied = prior.filter(batch => batch.apply_started_at).at(-1);
  if (applied && applied.state !== 'PASS') throw error('PREVIOUS_BATCH_NOT_PASS', `${applied.id}: ${applied.state}`);
  return { prior, applied, initial: !prior.some(batch => batch.state === 'PASS') };
}
function authorizeSource(authorization) {
  if (authorization?.owner_authorized !== true || authorization.scope !== 'A_AUTO_CLEAN_ONLY'
    || authorization.permanent_delete !== false || !authorization.source_path || !authorization.source_hash) throw error('CLEANUP_OWNER_AUTHORIZATION_REQUIRED');
  const source = path.resolve(authorization.source_path);
  if (hash(readFileSync(source)) !== authorization.source_hash) throw error('OWNER_AUTHORIZATION_SOURCE_CHANGED');
  return { ...authorization, source_path: source };
}
function exposurePaths(row, canonical = false) {
  const paths = canonical ? row.canonical_exposure_paths : row.exposure_paths;
  const folder = canonical ? row.canonical_path : row.logical_path;
  const values = paths?.length ? paths : [path.join(folder, 'SKILL.md')];
  const root = norm(folder);
  for (const value of values) {
    const relative = path.relative(root, norm(value));
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)
      || path.basename(value).toLowerCase() !== 'skill.md') throw error('EXPOSURE_PATH_OUTSIDE_INSTALLATION', value);
  }
  return [...new Set(values.map(value => norm(value)))];
}
// Re-read the host's developer instruction record. Caller-provided path lists are not visibility evidence.
function desktopPhase(runtime, phase, fallbackFile = null) {
  const sourceFile = phase?.source_file || fallbackFile;
  if (!sourceFile || !Number.isInteger(phase?.source_line) || !phase.source_record_sha256) throw error('DESKTOP_CATALOG_SOURCE_REQUIRED');
  const lines = readFileSync(sourceFile, 'utf8').split(/\r?\n/);
  const rows = lines.map(raw => raw ? JSON.parse(raw) : null);
  const metadata = rows.find(row => row?.type === 'session_meta')?.payload;
  if (metadata?.originator !== 'Codex Desktop') throw error('NOT_DESKTOP_SESSION');
  const index = phase.source_line - 1;
  const row = rows[index];
  if (!row || hash(lines[index]) !== phase.source_record_sha256 || row.type !== 'response_item'
    || row.payload?.role !== 'developer') throw error('DESKTOP_CATALOG_SOURCE_MISMATCH');
  const next = rows.slice(index + 1).find(item => item?.type === 'turn_context');
  if (!Number.isFinite(Date.parse(row.timestamp)) || !Number.isFinite(Date.parse(next?.timestamp))) throw error('DESKTOP_CATALOG_TIME_INVALID');
  if (!next || norm(next.payload?.cwd || '') !== norm(runtime.projectRoot)
    || Date.parse(next.timestamp) < Date.parse(row.timestamp)
    || Date.parse(next.timestamp) - Date.parse(row.timestamp) > 5000) throw error('DESKTOP_CATALOG_WORKSPACE_MISMATCH');
  const text = (row.payload.content || []).map(item => item.text || '').join('\n');
  const catalog = parseSkillCatalog(text);
  const observedAt = phase.observed_at || phase.timestamp;
  if (observedAt && observedAt !== row.timestamp) throw error('DESKTOP_CATALOG_TIME_MISMATCH');
  if (!Number.isFinite(Date.parse(row.timestamp))) throw error('DESKTOP_CATALOG_TIME_INVALID');
  return { source_file: path.resolve(sourceFile), source_line: phase.source_line,
    source_record_sha256: phase.source_record_sha256, timestamp: row.timestamp,
    originator: metadata.originator, cwd: next.payload.cwd, turn_id: next.payload.turn_id,
    logical_paths: [...new Set(catalog.entries.map(entry => norm(entry.skill_file)))],
    catalog_path_multiset: catalog.entries.map(entry => norm(entry.skill_file)).sort(),
    installation_count: catalog.entries.length, names: [...new Set(catalog.entries.map(entry => entry.name))],
    claim_scope: 'Actual session catalog; not a complete Desktop global inventory' };
}
function eligible(row) {
  return row.classification === 'AUTO_CLEAN' && Number.isFinite(row.cleanup_confidence) && row.cleanup_confidence >= 0.98
    && row.reversible === true && row.managed === false && row.critical_dependency === false
    && row.runtime_dependency === false
    && row.canonical_retained === true && row.before_state_complete === true && row.rollback_ready === true
    && row.owner === 'USER' && Boolean(row.canonical_path) && /^[a-f0-9]{64}$/.test(row.package_hash || '')
    && row.producer !== 'KNOWN_ACTIVE_OVERWRITER' && !(row.dependencies || []).some(dependency => dependency.blocks_move);
}
export function prepareCleanupBatch(runtime, baselineInput, { id, maxItems = 10, authorization } = {}) {
  requireWritableHost(runtime);
  const source = authorizeSource(authorization);
  const baselineFile = typeof baselineInput === 'string' ? path.resolve(baselineInput) : null;
  const baseline = baselineFile ? json(baselineFile) : baselineInput;
  if (baseline?.schema !== 'sgs/cleanup-baseline@1' || !Array.isArray(baseline.installations)) throw error('INVALID_CLEANUP_BASELINE');
  const beforeDesktop = desktopPhase(runtime, baseline.desktop_catalog);
  return withBatchLock(runtime, () => {
    const previous = assertPreviousBatch(runtime);
    if (!Number.isInteger(maxItems) || maxItems < 1 || maxItems > (previous.initial ? 10 : 25)) throw error('CLEANUP_BATCH_LIMIT', previous.initial ? 'Canary maximum 10' : 'Maximum 25');
    if (existsSync(batchFile(runtime, id))) throw error('CLEANUP_BATCH_EXISTS');
    const existingCold = new Set(previous.prior.flatMap(batch => batch.items || []).filter(item =>
      !existsSync(item.target) && existsSync(item.cold_path)).map(item => norm(item.target)));
    const eligibleRows = baseline.installations.filter(row => eligible(row) && !existingCold.has(norm(row.logical_path)));
    const selected = eligibleRows.slice(0, maxItems);
    const targets = new Set(selected.map(row => norm(row.logical_path)));
    if (targets.size !== selected.length) throw error('DUPLICATE_CLEANUP_TARGET');
    for (const row of selected) {
      if (targets.has(norm(row.canonical_path))) throw error('CANONICAL_SELECTED_FOR_REMOVAL', row.canonical_path);
      for (const entry of [...exposurePaths(row), ...exposurePaths(row, true)]) {
        if (!beforeDesktop.logical_paths.includes(entry)) throw error('CURRENT_DESKTOP_DISCOVERY_NOT_PROVEN', entry);
      }
    }
    const batch = { schema: 'sgs/cleanup-batch@1', id, state: selected.length ? 'PREPARING' : 'EMPTY',
      created_at: new Date().toISOString(), max_items: maxItems, canary: previous.initial,
      owner_authorization: source, baseline_source: baselineFile, baseline_hash: hash(JSON.stringify(baseline)),
      baseline_counts: baseline.counts || null, baseline_installations: baseline.installations.map(row => ({
        installation_id: row.installation_id, logical_path: row.logical_path, kind: row.kind,
        classification: row.classification, managed: row.managed,
        exposure_paths: row.exposure_paths || [path.join(row.logical_path, 'SKILL.md')] })),
      selected_count: selected.length, eligible_count: eligibleRows.length,
      rejected_auto_count: baseline.installations.filter(row => row.classification === 'AUTO_CLEAN' && !eligible(row)).length,
      before_desktop: beforeDesktop, items: [], permanent_deletions: 0, unique_capability_loss: 0,
      managed_changes: 0, rollback_plan: [], failure: null };
    save(runtime, batch);
    const backend = backendFor(runtime);
    try {
      for (const [index, row] of selected.entries()) {
        const changesetId = `${id}-${String(index + 1).padStart(3, '0')}`;
        const record = backend.plan({ id: changesetId, target: row.logical_path, owner: row.owner,
          reason: row.reason || row.classification_reason || 'Owner-authorized high-confidence redundant installation',
          alternative: row.canonical_path, producer: row.producer || 'UNKNOWN', dependencies: row.dependencies || [] });
        // Keep partial preparation reviewable even when a refreshed package no longer matches the baseline.
        const item = { installation_id: row.installation_id, changeset_id: changesetId, target: record.target,
          target_entry_type: record.before.entry_type, target_real_path: record.before.real_path,
          canonical_path: record.alternative.logical_path, package_hash: record.before.package_content_hash,
          canonical_real_path: record.alternative.real_path,
          before_state_hash: record.before.state_hash, before_package_fingerprint: record.before.package_fingerprint,
          canonical_state_hash: record.alternative.state_hash, cold_path: record.cold_path,
          exposure_paths: exposurePaths(row), canonical_exposure_paths: exposurePaths(row, true),
          cleanup_category: row.cleanup_category || row.category || null, cleanup_confidence: row.cleanup_confidence,
          authorization_file: path.join(runtime.authorizationDirectory, `${changesetId}.json`) };
        batch.items.push(item); batch.rollback_plan.push({ changeset_id: changesetId, restore_path: record.restore_path, cold_path: record.cold_path });
        save(runtime, batch);
        if (record.before.package_content_hash !== row.package_hash || (row.real_path && norm(record.before.real_path) !== norm(row.real_path))) throw error('CLEANUP_BASELINE_STALE', record.target);
        if (contained(item.canonical_path, item.target) || (item.target_entry_type === 'DIRECTORY'
          && contained(item.canonical_real_path, item.target_real_path))) throw error('CANONICAL_DEPENDS_ON_MOVED_TARGET', item.canonical_path);
        if (row.before_snapshot?.state_hash && row.before_snapshot.state_hash !== record.before.state_hash) throw error('CLEANUP_BEFORE_SNAPSHOT_CHANGED', record.target);
        if (record.blockers.length) throw error('CLEANUP_ITEM_BLOCKED', `${changesetId}: ${record.blockers.join(',')}`);
        const exactAuthorization = { schema: 'sgs/cleanup-item-authorization@1', batch_id: id,
          owner_authorized: true, source_path: source.source_path, source_hash: source.source_hash,
          scope: source.scope, permanent_delete: false, target: record.target,
          before_state_hash: record.before.state_hash, alternative: record.alternative.logical_path,
          alternative_state_hash: record.alternative.state_hash, consumed_by: null };
        if (existsSync(item.authorization_file)) throw error('CLEANUP_AUTHORIZATION_EXISTS', item.authorization_file);
        atomicJson(item.authorization_file, exactAuthorization);
      }
      for (const moved of batch.items) for (const retained of batch.items) {
        if (contained(retained.canonical_path, moved.target) || (moved.target_entry_type === 'DIRECTORY'
          && contained(retained.canonical_real_path, moved.target_real_path))) throw error('CANONICAL_DEPENDS_ON_MOVED_TARGET', retained.canonical_path);
      }
      if (batch.items.length) batch.state = 'PREPARED';
      return save(runtime, batch);
    } catch (cause) {
      batch.state = 'PREPARE_FAILED'; batch.failure = { code: cause.code || 'ERROR', message: cause.message }; save(runtime, batch); throw cause;
    }
  });
}
function preflightItem(backend, batch, item) {
  const record = backend.get(item.changeset_id);
  const authorization = json(item.authorization_file);
  if (authorization.batch_id !== batch.id || authorization.alternative !== record.alternative?.logical_path
    || authorization.alternative_state_hash !== record.alternative?.state_hash
    || authorization.source_path !== batch.owner_authorization.source_path
    || authorization.source_hash !== batch.owner_authorization.source_hash
    || authorization.scope !== batch.owner_authorization.scope || authorization.permanent_delete !== false) throw error('CLEANUP_AUTHORIZATION_SCOPE_MISMATCH');
  assertProductionAuthorization({ record, authorization, executionAuthorized: true });
  if (record.state !== 'PLANNED' || record.target !== item.target || record.before.state_hash !== item.before_state_hash) throw error('CLEANUP_RECEIPT_CHANGED', item.changeset_id);
  const current = backend.observe(item.target);
  if (current.state_hash !== item.before_state_hash || current.package_fingerprint !== item.before_package_fingerprint) throw error('CONCURRENT_MODIFICATION', item.target);
  if (observeInstallation(item.canonical_path).state_hash !== item.canonical_state_hash) throw error('CANONICAL_ALTERNATIVE_CHANGED', item.canonical_path);
  if (existsSync(item.cold_path)) throw error('COLD_STORE_CONFLICT', item.cold_path);
  return { record, authorization };
}
function rollbackMovedItems(backend, batch) {
  const results = [];
  for (const item of [...batch.items].reverse()) {
    try {
      const record = backend.get(item.changeset_id);
      if (['COLD', 'MOVE_INTENT', 'ROLLBACK_INTENT', 'RECOVERY_REQUIRED'].includes(record.state)) backend.rollback(item.changeset_id);
      const verified = backend.verify(item.changeset_id);
      const okay = verified.exact_before_restored && !verified.cold_exists;
      results.push({ changeset_id: item.changeset_id, status: okay ? 'PASS' : 'FAIL', verification: verified });
    } catch (cause) { results.push({ changeset_id: item.changeset_id, status: 'FAIL', code: cause.code || 'ERROR', message: cause.message }); }
  }
  return results;
}
function refreshActualExits(backend, batch) {
  const cold = batch.items.filter(item => backend.get(item.changeset_id).state === 'COLD'
    && !existsSync(item.target) && existsSync(item.cold_path));
  batch.actual_exit_count = cold.length;
  batch.actual_exposure_exit_count = new Set(cold.flatMap(item => item.exposure_paths)).size;
}
export function applyCleanupBatch(runtime, id, { executionAuthorized = false } = {}) {
  requireWritableHost(runtime);
  if (executionAuthorized !== true) throw error('AUTHORIZATION_REQUIRED');
  return withBatchLock(runtime, () => {
    assertPreviousBatch(runtime, id);
    const batch = json(batchFile(runtime, id));
    if (batch.state !== 'PREPARED') throw error('INVALID_CLEANUP_BATCH_STATE', batch.state);
    authorizeSource(batch.owner_authorization);
    const backend = backendFor(runtime);
    // Refuse the whole canary before its first move if any exact before state has changed.
    for (const item of batch.items) preflightItem(backend, batch, item);
    batch.state = 'APPLYING'; batch.apply_started_at = new Date().toISOString(); save(runtime, batch);
    try {
      for (const item of batch.items) {
        const { record, authorization } = preflightItem(backend, batch, item);
        assertProductionAuthorization({ record, authorization, executionAuthorized });
        backend.disable(item.changeset_id, { authorized: true });
        authorization.consumed_by = { batch_id: id, changeset_id: item.changeset_id, at: new Date().toISOString() };
        atomicJson(item.authorization_file, authorization);
        item.state = 'COLD'; save(runtime, batch);
      }
      batch.apply_completed_at = new Date().toISOString(); batch.state = 'APPLIED_AWAITING_DESKTOP';
      batch.actual_exit_count = batch.items.length;
      batch.actual_exposure_exit_count = batch.items.reduce((total, item) => total + item.exposure_paths.length, 0);
      return save(runtime, batch);
    } catch (cause) {
      batch.failure = { code: cause.code || 'ERROR', message: cause.message };
      batch.rollback_results = rollbackMovedItems(backend, batch);
      batch.state = batch.rollback_results.every(result => result.status === 'PASS') ? 'FAILED_ROLLED_BACK' : 'RECOVERY_REQUIRED';
      refreshActualExits(backend, batch);
      save(runtime, batch); throw cause;
    }
  });
}
function checksReady(batch, checks) {
  const canonicalChecks = checks?.canonical || [];
  const coreChecks = checks?.core || [];
  return batch.items.every(item => canonicalChecks.some(check => check.status === 'PASS' && norm(check.path) === norm(item.canonical_path)))
    && ['skill-governance', 'yy'].every(name => coreChecks.some(check => check.name === name && check.status === 'PASS'));
}
export function verifyCleanupBatch(runtime, id, { desktopEvidence = null, checks = null } = {}) {
  requireWritableHost(runtime);
  return withBatchLock(runtime, () => {
    const batch = json(batchFile(runtime, id));
    if (!['APPLIED_AWAITING_DESKTOP', 'PASS'].includes(batch.state)) throw error('INVALID_CLEANUP_BATCH_STATE', batch.state);
    const backend = backendFor(runtime);
    batch.filesystem_verification = batch.items.map(item => {
      try { return backend.verify(item.changeset_id); }
      catch (cause) { return { id: item.changeset_id, asset_preserved: false, code: cause.code || 'ERROR', message: cause.message }; }
    });
    const filesystemPass = batch.filesystem_verification.every(result => result.receipt_state === 'COLD'
      && result.asset_preserved && result.cold_exists && !result.active_exists && result.resurrection === 'NOT_OBSERVED');
    batch.canonical_verification = batch.items.map(item => {
      try { return { path: item.canonical_path, status: observeInstallation(item.canonical_path).state_hash === item.canonical_state_hash ? 'PASS' : 'FAIL' }; }
      catch (cause) { return { path: item.canonical_path, status: 'FAIL', code: cause.code || 'ERROR', message: cause.message }; }
    });
    const canonicalPass = batch.canonical_verification.every(result => result.status === 'PASS');
    batch.checks = checks;
    if (!filesystemPass || !canonicalPass) {
      batch.failure = { code: !filesystemPass ? 'CLEANUP_ASSET_OR_RESURRECTION_FAILURE' : 'CANONICAL_ALTERNATIVE_CHANGED' };
      batch.rollback_results = rollbackMovedItems(backend, batch);
      batch.state = batch.rollback_results.every(result => result.status === 'PASS') ? 'FAILED_ROLLED_BACK' : 'RECOVERY_REQUIRED';
      refreshActualExits(backend, batch);
      return save(runtime, batch);
    }
    if (!desktopEvidence) { batch.state = 'APPLIED_AWAITING_DESKTOP'; batch.pending = ['FRESH_DESKTOP_CATALOG', ...(!checksReady(batch, checks) ? ['CANONICAL_AND_CORE_CHECKS'] : [])]; return save(runtime, batch); }
    const before = desktopPhase(runtime, desktopEvidence.before, desktopEvidence.source_file);
    const after = desktopPhase(runtime, desktopEvidence.after, desktopEvidence.source_file);
    if (before.source_record_sha256 !== batch.before_desktop.source_record_sha256
      || before.source_line !== batch.before_desktop.source_line || norm(before.source_file) !== norm(batch.before_desktop.source_file)) throw error('CLEANUP_DESKTOP_BEFORE_MISMATCH');
    if (!Number.isFinite(Date.parse(batch.apply_completed_at)) || !Number.isFinite(Date.parse(batch.apply_started_at))) throw error('CLEANUP_APPLY_TIME_INVALID');
    if (Date.parse(before.timestamp) >= Date.parse(batch.apply_started_at)) throw error('CLEANUP_DESKTOP_BEFORE_NOT_PRE_APPLY');
    if (Date.parse(after.timestamp) <= Date.parse(batch.apply_completed_at)) throw error('FRESH_DESKTOP_CATALOG_REQUIRED');
    const targets = batch.items.flatMap(item => item.exposure_paths);
    const canonicals = batch.items.flatMap(item => item.canonical_exposure_paths);
    const unexpectedExits = before.logical_paths.filter(entry => !targets.includes(entry) && !after.logical_paths.includes(entry));
    const unexpectedAdditions = after.logical_paths.filter(entry => !before.logical_paths.includes(entry));
    const expectedAfter = before.catalog_path_multiset.filter(entry => !targets.includes(entry));
    const exactCatalogPass = JSON.stringify(expectedAfter) === JSON.stringify(after.catalog_path_multiset);
    const desktopPass = targets.every(target => before.logical_paths.includes(target) && !after.logical_paths.includes(target))
      && canonicals.every(canonical => before.logical_paths.includes(canonical) && after.logical_paths.includes(canonical))
      && unexpectedExits.length === 0 && unexpectedAdditions.length === 0 && exactCatalogPass
      && ['skill-governance', 'yy'].every(name => after.names.includes(name));
    const coreVisible = ['skill-governance', 'yy'].every(name => {
      // The raw catalog reader has already validated source and workspace; core checks supply functional results.
      return (checks?.core || []).some(check => check.name === name && check.status === 'PASS');
    });
    batch.desktop_verification = { status: desktopPass ? 'PASS' : 'FAIL', before, after,
      expected_exposure_reduction: targets.length, observed_catalog_reduction: before.installation_count - after.installation_count,
      unexpected_exits: unexpectedExits,
      unexpected_additions: unexpectedAdditions, exact_catalog_match: exactCatalogPass,
      claim_scope: 'This Desktop session catalog and exact installations; global completeness is not claimed' };
    if (!desktopPass) {
      batch.failure = { code: 'P1_DESKTOP_EXPOSURE_UNEXPLAINED' };
      batch.rollback_results = rollbackMovedItems(backend, batch);
      batch.state = batch.rollback_results.every(result => result.status === 'PASS') ? 'FAILED_ROLLED_BACK' : 'RECOVERY_REQUIRED';
      refreshActualExits(backend, batch);
    } else if (coreVisible && checksReady(batch, checks)) { batch.state = 'PASS'; batch.accepted_at = new Date().toISOString(); batch.pending = []; }
    else { batch.state = 'APPLIED_AWAITING_DESKTOP'; batch.pending = ['CANONICAL_AND_CORE_CHECKS']; }
    return save(runtime, batch);
  });
}
export function rollbackCleanupBatch(runtime, id) {
  requireWritableHost(runtime);
  return withBatchLock(runtime, () => {
    const batch = json(batchFile(runtime, id));
    if (!['APPLIED_AWAITING_DESKTOP', 'PASS', 'RECOVERY_REQUIRED', 'APPLYING'].includes(batch.state)) throw error('INVALID_CLEANUP_BATCH_STATE', batch.state);
    const backend = backendFor(runtime);
    batch.rollback_results = rollbackMovedItems(backend, batch);
    batch.state = batch.rollback_results.every(result => result.status === 'PASS') ? 'ROLLED_BACK' : 'RECOVERY_REQUIRED';
    refreshActualExits(backend, batch);
    return save(runtime, batch);
  });
}
export function cleanupSummary(runtime) {
  const rows = readBatches(runtime,{tolerant:true});
  const corrupt = rows.filter(row=>row.error==='CORRUPT_RECEIPT');
  const batches = rows.filter(row=>row.error!=='CORRUPT_RECEIPT');
  const latest = batches.at(-1);
  const coldTargets = new Set();
  const exposures = new Set();
  for (const batch of batches) for (const item of batch.items) {
    if (!existsSync(item.target) && existsSync(item.cold_path)) { coldTargets.add(norm(item.target)); for (const entry of item.exposure_paths) exposures.add(entry); }
  }
  const configuredBaseline = !latest && runtime.artifact ? runtime.artifact('cleanup_baseline') : null;
  const inventory = (latest?.baseline_installations || configuredBaseline?.installations || []).filter(row => row.kind !== 'PACKAGE_CONTAINER');
  const removed = row => coldTargets.has(norm(row.logical_path)) || row.exposure_paths?.some(entry => exposures.has(norm(entry)));
  const classificationCounts = {};
  for (const row of inventory) classificationCounts[row.classification] = (classificationCounts[row.classification] || 0) + 1;
  return { schema: 'sgs/cleanup-summary@1', baseline_scope: 'Configured roots and actual bounded Desktop catalog',
    degraded: corrupt.length>0, receipt_errors:corrupt,
    cleanup_done: Boolean(latest?.state === 'PASS' && latest?.desktop_verification?.status === 'PASS'),
    pending_gate_count: latest?.state === 'PASS' && latest?.desktop_verification?.status === 'PASS'
      ? 0 : (latest?.pending?.length ?? (latest ? 1 : 0)),
    installation_count_basis: 'Filesystem logical entry rows; PACKAGE_CONTAINER transaction rows excluded',
    desktop_current_installations: null,
    desktop_last_observed_installations: latest?.desktop_verification?.after?.installation_count
      ?? latest?.before_desktop?.installation_count ?? configuredBaseline?.desktop_catalog?.entries?.length ?? null,
    desktop_last_observed_at: latest?.desktop_verification?.after?.timestamp
      ?? latest?.before_desktop?.timestamp ?? configuredBaseline?.desktop_catalog?.timestamp ?? null,
    current_scoped_installations: inventory.length ? inventory.length - inventory.filter(removed).length : null,
    active_count: inventory.length ? inventory.filter(row => !row.managed && row.classification !== 'HOLD_UNKNOWN' && !removed(row)).length : null,
    managed_count: inventory.length ? inventory.filter(row => row.managed).length : null,
    unknown_count: inventory.length ? inventory.filter(row => row.classification === 'HOLD_UNKNOWN').length : null,
    review_count: inventory.length ? inventory.filter(row => row.classification === 'REVIEW_CANDIDATE').length : null,
    actual_exit_count: coldTargets.size, cold_store_installations: coldTargets.size,
    actual_exposure_exit_count: exposures.size, unique_capability_loss: 0, permanent_deletions: 0, managed_changes: 0,
    classification_counts: classificationCounts,
    latest_batch: latest ? { id: latest.id, state: latest.state, selected: latest.selected_count,
      actual_exit_count: latest.items.filter(item => coldTargets.has(norm(item.target))).length,
      receipts: latest.items.length, desktop: latest.desktop_verification?.status || 'NOT_VERIFIED' } : null,
    batches: batches.map(batch => ({ id: batch.id, state: batch.state, selected: batch.selected_count,
      receipt_count: batch.items.length, desktop_status: batch.desktop_verification?.status || 'NOT_VERIFIED' })) };
}
