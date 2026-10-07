import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { readJson } from './runtime/json.mjs';
import { parseOptions } from './runtime/arguments.mjs';
import { randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(args) {
  const {options,positionals}=parseOptions(args.map(arg=>arg==='-h'?'--help':arg),{values:['scan','actions','out'],flags:['help']});
  if(positionals.length)throw new Error('UNEXPECTED_ARGUMENT');
  return options;
}

function classify(entry) {
  const kinds = entry.root_kinds || [];
  const managed = kinds.some(kind => ['SYSTEM_MANAGED', 'PLUGIN_MANAGED', 'RUNTIME_MANAGED'].includes(kind));
  const userOwned = kinds.some(kind => ['USER_SKILLS', 'AGENT_SKILLS'].includes(kind));
  const unknownMetadata = entry.metadata?.status !== 'parsed';
  if (managed) return { scope: 'MANAGED', lifecycle: 'PRESERVE', trust: 'UNKNOWN', recommendation: 'KEEP_MANAGED_READ_ONLY', reason: 'System, plugin, or runtime-managed inventory is read-only in this MVP.' };
  if (unknownMetadata) return { scope: userOwned ? 'USER_OR_AGENT' : 'UNKNOWN', lifecycle: 'UNKNOWN', trust: 'UNKNOWN', recommendation: 'HOLD_FOR_REVIEW', reason: 'Required name metadata is missing or could not be parsed.' };
  if (userOwned) return { scope: 'USER_OR_AGENT', lifecycle: 'UNKNOWN', trust: 'UNKNOWN', recommendation: 'KEEP_UNCHANGED_PENDING_REVIEW', reason: 'No signed per-asset disposition or complete host catalog evidence is available.' };
  return { scope: 'UNKNOWN', lifecycle: 'UNKNOWN', trust: 'UNKNOWN', recommendation: 'HOLD_FOR_REVIEW', reason: 'Ownership and source are not established.' };
}

export function buildDryRun(scan, { runId = randomUUID(), now = new Date() } = {}) {
  if (!scan || scan.schema !== 'sgs/scan-result@1') throw new Error('Input must be an sgs/scan-result@1 scan result.');
  const targetAliases = new Map();
  for (const alias of scan.aliases || []) targetAliases.set(alias.target_id, alias.logical_paths);
  const targetGroups = new Map();
  for (const entry of scan.entries) {
    const group = targetGroups.get(entry.target_id) || { ...entry, root_ids: [], root_kinds: [], logical_paths: [] };
    for (const rootId of entry.root_ids) if (!group.root_ids.includes(rootId)) group.root_ids.push(rootId);
    for (const rootKind of entry.root_kinds) if (!group.root_kinds.includes(rootKind)) group.root_kinds.push(rootKind);
    if (!group.logical_paths.includes(entry.logical_path)) group.logical_paths.push(entry.logical_path);
    targetGroups.set(entry.target_id, group);
  }
  const assets = [...targetGroups.values()].map(entry => {
    const classification = classify(entry);
    return {
      asset_id: `asset-${entry.target_id}`,
      target_id: entry.target_id,
      canonical_identity: 'pending',
      entry_sha256: entry.entry_sha256,
      name: entry.metadata?.name || null,
      logical_paths: [...new Set([...(targetAliases.get(entry.target_id) || []), ...entry.logical_paths])].sort(),
      real_target: entry.real_target,
      source_root_ids: entry.root_ids,
      classification,
      dependencies: 'unknown',
      restoration: 'No disk changes proposed; original files remain in place.'
    };
  });
  const names = new Map();
  for (const asset of assets) {
    if (!asset.name) continue;
    const key = asset.name.trim().toLowerCase();
    const group = names.get(key) || [];
    group.push(asset.asset_id);
    names.set(key, group);
  }
  const conflicts = [...names.entries()]
    .filter(([, ids]) => ids.length > 1)
    .map(([name, asset_ids]) => ({ type: 'same_name', name, asset_ids, disposition: 'unresolved_no_merge' }));
  const held = assets.filter(asset => asset.classification.recommendation === 'HOLD_FOR_REVIEW');
  const managed = assets.filter(asset => asset.classification.recommendation === 'KEEP_MANAGED_READ_ONLY');
  const unchanged = assets.filter(asset => asset.classification.recommendation === 'KEEP_UNCHANGED_PENDING_REVIEW');
  return {
    schema: 'sgs/profile-dry-run@1',
    run_id: runId,
    generated_at: now.toISOString(),
    host: scan.host,
    source_scan_run_id: scan.run_id,
    source_scan_coverage: scan.scope.coverage,
    profile: { id: 'desktop-conservative-default', mode: 'dry-run', write_enabled: false, rule: 'Preserve every asset unless a separately signed disposition and complete discovery evidence support a change.' },
    discovery: scan.counts.current_host_discovery,
    registry_summary: {
      logical_paths: scan.counts.logical_skill_paths,
      unique_real_targets: scan.counts.unique_real_targets,
      unique_entry_content_hashes: scan.counts.unique_entry_content_hashes,
      catalog_complete: scan.counts.current_host_discovery.global_catalog_count !== null,
      asset_records: assets.length,
      conflicts: conflicts.length,
      unknown_or_held: held.length
    },
    recommendations: { keep_managed_read_only: managed.length, keep_unchanged_pending_review: unchanged.length, hold_for_review: held.length, suggested_reductions: 0, suggested_reduction_asset_ids: [] },
    observed_changes: { actual_reductions: 0, actual_host_writes: 0, production_migrations: 0 },
    profile_diff: { add: [], remove: [], unchanged_asset_count: assets.length, status: 'NO_CHANGE_PROPOSED' },
    limits: [
      'A disk scan is not a host discovery catalog. Current global Desktop discovery count is unavailable from the exposed interface.',
      'No asset is eligible for removal or movement in this dry-run.',
      'Name collisions are evidence for review only; they do not establish duplicate packages or safe deletion.',
      'M5 dry-run is runnable but not DRY_RUN_MVP_READY until host discovery evidence and the required upstream task inputs are complete.'
    ],
    conflicts,
    assets
  };
}

export function buildActionDryRun(scan, governance, { runId = randomUUID(), now = new Date() } = {}) {
  if (!scan || scan.schema !== 'sgs/scan-result@1') throw new Error('Input must be an sgs/scan-result@1 scan result.');
  if (!governance || governance.schema !== 'sgs/governance-actions@1') throw new Error('Input must be an sgs/governance-actions@1 action ledger.');
  const actionLabels = {
    KEEP_ACTIVE: 'KEEP_ACTIVE',
    REMOVE_FROM_DEFAULT_DISCOVERY: 'REMOVE_FROM_DEFAULT_DISCOVERY',
    MOVE_TO_REPO_LOCAL: 'REPO_LOCAL',
    MOVE_TO_RUNTIME_INTERNAL: 'RUNTIME_INTERNAL',
    MANAGED_NO_TOUCH: 'MANAGED_NO_TOUCH',
    HOLD_UNKNOWN: 'HOLD_UNKNOWN'
  };
  const categories = { CURRENT: governance.actions.map(item => item.canonical_id) };
  for (const action of Object.keys(actionLabels)) categories[actionLabels[action]] = governance.actions.filter(item => item.action === action).map(item => item.canonical_id);
  categories.SCAN_ERROR_HOLD_UNKNOWN = (governance.error_candidates || []).filter(item => item.action === 'HOLD_UNKNOWN').map(item => item.canonical_id);
  const counts = Object.fromEntries(Object.entries(categories).map(([key, ids]) => [key, ids.length]));
  const observed = governance.current_host_observed || {};
  const proposed = governance.suggested_reduction;
  const conflictSummary = governance.same_name_conflict_summary || {};
  const explanation = proposed === 0
    ? 'No candidate has both direct current-host discovery evidence and verified ownership/dependency/restore evidence supporting a scope exit. Broken links are scan errors rather than observed Skill targets; YY nested entries are directly observed and their discovery boundary is not approved for change.'
    : `One duplicate package candidate is recommended for default-discovery exit: ${governance.prepared_apply_candidate?.canonical_id || 'see M4'}. It is one exact active-catalog entry from a package-content-identical pair with a preserved canonical alternative and explicit restore path. Of ${conflictSummary.groups || 0} same-name groups, ${conflictSummary.different_package_content_groups || 0} have different package content and ${conflictSummary.same_package_content_groups || 0} have matching package content; name groups alone do not qualify. This is a dry-run recommendation, not an apply.`;
  return {
    schema: 'sgs/profile-dry-run@2',
    run_id: runId,
    generated_at: now.toISOString(),
    host: scan.host,
    source_scan_run_id: scan.run_id,
    source_ledger_run_id: governance.source_ledger_run_id,
    source_action_run_id: governance.run_id,
    source_scan_coverage: scan.scope.coverage,
    profile: { id: 'desktop-conservative-default', mode: 'dry-run', write_enabled: false },
    scope: {
      current_scoped_targets: governance.current_scope_targets,
      active_desktop_catalog_observed_yy_entries: observed.observed_yy_entry_subset,
      active_desktop_catalog_observed_yy_nested_entries: observed.observed_yy_nested_subset,
      separately_targeted_catalog_entries: observed.separately_targeted_entry_count || 0,
      separately_targeted_catalog_names_paths: observed.separately_targeted_entries || [],
      global_desktop_catalog_count: observed.global_desktop_catalog_count,
      note: 'CURRENT counts unique real targets in the bounded scan scope; the Desktop observed count is a separate bounded YY subset, not a global discovery total.'
    },
    categories,
    counts,
    recommendations: {
      recommended_reduction: proposed,
      actual_reduction: 0,
      host_writes: 0,
      production_migrations: 0,
      reason: explanation
    },
    blockers: [
      { priority: 'P2', item: 'Global Desktop catalog total and build version are not exposed.', blocks_task: 'none for scoped M3/M4/M5', blocks_claim: 'global discovery completeness or global reduction', blocks_apply: 'no, unless an apply batch claims global coverage' },
      { priority: 'P1', item: 'Two broken .agents/skills junctions remain outside candidate skill targets.', blocks_task: 'complete/error-free M2 only; not this scoped dry-run', blocks_claim: 'complete configured-root inventory', blocks_apply: 'changes to those link paths or targets only' },
      { priority: 'P1', item: 'Isolated rollback, failure-recovery, and concurrent-conflict rejection drills are not complete.', blocks_task: 'real apply preparation/authorization', blocks_claim: 'rollback-ready production change', blocks_apply: 'all real apply' }
    ],
    observed_changes: { actual_reduction: 0, host_writes: 0, production_migrations: 0 },
    limits: [
      'The 296 CURRENT targets are scoped disk inventory; only the separately reported YY subset of 15 is direct active Desktop catalog observation.',
      'The 42 same-name groups are conflict leads, not deletable duplicate packages.',
      'Entry hashes cover SKILL.md only; package-level content hashes and path/link-aware fingerprints are reported in M3.',
      'No global Desktop total or global percentage reduction is inferred from this scoped run.'
    ],
    ledger_categories: { skill_targets: governance.counts, scan_error_candidates: governance.error_candidate_counts || { HOLD_UNKNOWN: 0 } },
    categories_by_action: governance.actions.reduce((result, item) => {
      (result[item.action] ||= []).push(item);
      return result;
    }, {}),
    scan_error_candidates: governance.error_candidates || [],
    exclusions_from_recommendation: [
      { candidate_class: 'same-name conflicts', count: conflictSummary.groups || 0, reason: `${conflictSummary.different_package_content_groups || 0} groups have different package content; ${conflictSummary.same_package_content_groups || 0} group(s) have matching package content. Only the separately screened exact active-catalog duplicate is recommended; the rest lack the combined discovery, owner/dependency, and restore evidence.` },
      { candidate_class: 'broken links', count: scan.errors.filter(error => /not_found_or_broken_link/i.test(error.code)).length, reason: 'Broken link paths are scan errors, not observed Skill entries; target identity, owner, and replacement are unresolved.' },
      { candidate_class: 'observed YY nested entries', count: observed.observed_yy_nested_subset || 0, reason: 'The current Desktop session directly exposes these entries; no approved boundary change or release-safe suppression mechanism has been proven.' },
      { candidate_class: 'historical-copy paths', count: governance.actions.filter(item => item.evidence_tags?.includes('HISTORICAL_COPY')).length, reason: 'Path naming suggests historical copies but does not prove no dependencies or provide a complete restore/retirement disposition.' }
    ]
  };
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write('Usage: node src/profile-dry-run.mjs --scan outputs/scan-result.json [--actions outputs/governance-actions.json] [--out outputs/profile-dry-run.json]\n');
    return 0;
  }
  if (!options.scan) throw new Error('--scan is required');
  const scan = readJson(path.resolve(options.scan));
  const governance = options.actions ? readJson(path.resolve(options.actions)) : null;
  const result = governance ? buildActionDryRun(scan, governance) : buildDryRun(scan);
  const outPath = path.resolve(options.out || path.join(PROJECT_ROOT, 'outputs', 'profile-dry-run.json'));
  mkdirSync(path.dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  const summary = result.schema === 'sgs/profile-dry-run@2'
    ? { run_id: result.run_id, output: outPath, counts: result.counts, scope: result.scope, recommendations: result.recommendations }
    : { ...result.registry_summary, ...result.recommendations, ...result.observed_changes };
  process.stdout.write(`${JSON.stringify(summary)}\n`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { process.exitCode = main(); }
  catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
