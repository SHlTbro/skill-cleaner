import { packageFingerprint } from './core/package-fingerprint.mjs';
import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync, lstatSync, readdirSync, readFileSync, readlinkSync,
  realpathSync, statSync, writeFileSync, mkdirSync
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readJson } from './runtime/json.mjs';
import { parseOptions } from './runtime/arguments.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function sha256(value) { return createHash('sha256').update(value).digest('hex'); }
function norm(value) {
  const absolute = path.resolve(value);
  return process.platform === 'win32' ? absolute.replaceAll('/', '\\').toLowerCase() : absolute;
}
function parseArgs(args) {
  const {options,positionals}=parseOptions(args.map(arg=>arg==='-h'?'--help':arg),{values:['scan','scope','candidate-evidence','m3-out','m4-out'],flags:['help']});
  if(positionals.length)throw new Error('UNEXPECTED_ARGUMENT');
  return {...options,candidateEvidence:options['candidate-evidence'],m3:options['m3-out'],m4:options['m4-out']};
}

export { packageFingerprint } from './core/package-fingerprint.mjs';

function targetGroups(scan) {
  const groups = new Map();
  for (const entry of scan.entries) {
    const group = groups.get(entry.target_id) || {
      target_id: entry.target_id, real_path: entry.real_target, entries: [], root_ids: [], root_kinds: [], logical_paths: []
    };
    group.entries.push(entry);
    for (const value of entry.root_ids || []) if (!group.root_ids.includes(value)) group.root_ids.push(value);
    for (const value of entry.root_kinds || []) if (!group.root_kinds.includes(value)) group.root_kinds.push(value);
    if (!group.logical_paths.includes(entry.logical_path)) group.logical_paths.push(entry.logical_path);
    groups.set(entry.target_id, group);
  }
  return [...groups.values()].map(group => ({
    ...group,
    entries: group.entries.sort((a, b) => a.logical_path.localeCompare(b.logical_path)),
    root_ids: group.root_ids.sort(), root_kinds: group.root_kinds.sort(), logical_paths: group.logical_paths.sort()
  }));
}

export function buildM3(scan, scope, runId) {
  const roots = new Map(scope.roots.map(root => [root.id, root]));
  const observed = new Map((scope.desktop_catalog_observation?.observed_yy_entries || []).map(row => [norm(row.path), row]));
  const yyEntry = scope.desktop_catalog_observation?.observed_yy_entries?.find(row => row.name === 'yy');
  const yyRoot = scope.runtime_package_roots?.yy ? norm(scope.runtime_package_roots.yy)
    : yyEntry ? norm(realpathSync.native(path.dirname(yyEntry.path))) : null;
  const assets = targetGroups(scan).map(group => {
    const primary = group.entries[0];
    const packagePath = primary.package_path || path.dirname(primary.logical_path);
    const pkg = packageFingerprint(packagePath);
    const name = primary.metadata?.name || null;
    const tags = [];
    const aliasPaths = [...new Set(group.logical_paths)];
    if (aliasPaths.length > 1) tags.push('SAME_REAL_TARGET');
    if (group.root_kinds.includes('SYSTEM_MANAGED')) tags.push('MANAGED_SYSTEM');
    if (group.root_kinds.includes('PLUGIN_MANAGED')) tags.push('MANAGED_PLUGIN');
    if (group.root_kinds.includes('RUNTIME_MANAGED')) tags.push('MANAGED_RUNTIME');
    if (group.logical_paths.some(value => /_pre-.+-junction_\d{8}-/i.test(value))) tags.push('HISTORICAL_COPY');
    if (yyRoot && norm(pkg.real_root || '') !== yyRoot && norm(pkg.real_root || '').startsWith(`${yyRoot}${path.sep.toLowerCase()}`)) tags.push('NESTED_RUNTIME_CHILD');
    if (yyRoot && norm(pkg.real_root || '') === yyRoot) tags.push('YY_TOP_LEVEL_PACKAGE');
    if (group.root_kinds.includes('PROJECT_LOCAL')) tags.push('PROJECT_LOCAL');
    if (primary.metadata?.status !== 'parsed' || pkg.status !== 'COMPLETE' || group.root_kinds.length === 0) tags.push('UNKNOWN');
    return {
      canonical_id: `canonical-${group.target_id}`,
      canonical_status: 'physical-target-only; semantic canonical not approved',
      target_id: group.target_id,
      name,
      logical_paths: group.logical_paths,
      real_path: group.real_path,
      source_root_ids: group.root_ids,
      source_kinds: group.root_kinds,
      entry_sha256_values: [...new Set(group.entries.map(entry => entry.entry_sha256))].sort(),
      package: {
        package_root: pkg.logical_root,
        real_package_root: pkg.real_root,
        package_content_hash: pkg.content_hash,
        package_fingerprint: pkg.fingerprint,
        status: pkg.status,
        file_count: pkg.file_count,
        files: pkg.files,
        link_relations: pkg.links,
        issues: pkg.issues,
        volatile_generated_exclusions: pkg.volatile_generated_exclusions
      },
      desktop_observation: observed.get(norm(group.logical_paths[0])) || group.logical_paths.map(value => observed.get(norm(value))).find(Boolean) || null,
      classification_tags: tags
    };
  });

  const byEntryHash = new Map();
  const byPackageHash = new Map();
  const byName = new Map();
  const byReal = new Map();
  for (const asset of assets) {
    for (const hash of asset.entry_sha256_values) byEntryHash.set(hash, [...(byEntryHash.get(hash) || []), asset.canonical_id]);
    if (asset.package.status === 'COMPLETE' && asset.package.package_content_hash) byPackageHash.set(asset.package.package_content_hash, [...(byPackageHash.get(asset.package.package_content_hash) || []), asset.canonical_id]);
    if (asset.name) {
      const key = asset.name.trim().toLowerCase();
      byName.set(key, [...(byName.get(key) || []), asset]);
    }
    byReal.set(norm(asset.real_path), [...(byReal.get(norm(asset.real_path)) || []), asset.canonical_id]);
  }
  const entryHashGroups = [...byEntryHash].filter(([, ids]) => ids.length > 1).map(([hash, ids]) => ({ entry_sha256: hash, canonical_ids: [...new Set(ids)].sort() }));
  const packageHashGroups = [...byPackageHash].filter(([, ids]) => ids.length > 1).map(([hash, ids]) => ({ package_content_hash: hash, canonical_ids: [...new Set(ids)].sort() }));
  const realTargetGroups = [...byReal].filter(([, ids]) => ids.length > 1).map(([real_path, ids]) => ({ real_path, canonical_ids: [...new Set(ids)].sort() }));
  const nameGroups = [...byName].filter(([, rows]) => rows.length > 1).map(([name, rows]) => {
    const differentEntry = new Set(rows.flatMap(row => row.entry_sha256_values)).size > 1;
    const allPackagesComplete = rows.every(row => row.package.status === 'COMPLETE');
    const differentPackage = allPackagesComplete && new Set(rows.map(row => row.package.package_content_hash)).size > 1;
    const contentDifferent = differentPackage || differentEntry;
    if (contentDifferent) for (const row of rows) if (!row.classification_tags.includes('SAME_NAME_DIFFERENT_CONTENT')) row.classification_tags.push('SAME_NAME_DIFFERENT_CONTENT');
    return {
      name,
      canonical_ids: rows.map(row => row.canonical_id).sort(),
      different_entry_content: differentEntry,
      different_package_content: differentPackage,
      different_content: contentDifferent,
      difference_basis: differentPackage ? 'package_content_hash' : differentEntry ? 'entry_sha256; whole_package_equivalence_not_implied' : 'none'
    };
  });
  for (const group of realTargetGroups) for (const id of group.canonical_ids) {
    const row = assets.find(asset => asset.canonical_id === id);
    if (row && !row.classification_tags.includes('SAME_REAL_TARGET')) row.classification_tags.push('SAME_REAL_TARGET');
  }
  for (const group of entryHashGroups) for (const id of group.canonical_ids) {
    const row = assets.find(asset => asset.canonical_id === id);
    if (row && !row.classification_tags.includes('SAME_ENTRY_HASH')) row.classification_tags.push('SAME_ENTRY_HASH');
  }
  for (const group of packageHashGroups) for (const id of group.canonical_ids) {
    const row = assets.find(asset => asset.canonical_id === id);
    if (row && !row.classification_tags.includes('SAME_PACKAGE_HASH')) row.classification_tags.push('SAME_PACKAGE_HASH');
  }

  const brokenLinks = (scan.errors || []).filter(error => /not_found_or_broken_link|link/i.test(error.code)).map(error => {
    let linkTarget = (scan.links || []).find(link => norm(link.logical_path) === norm(error.path))?.link_target || null;
    let linkType = null;
    let beforeState = null;
    try {
      const info = lstatSync(error.path);
      if (info.isSymbolicLink()) linkTarget = readlinkSync(error.path);
      linkType = info.isSymbolicLink() ? 'junction-or-symbolic-link' : info.isDirectory() ? 'directory' : 'other';
      beforeState = { mode: info.mode, size_bytes: info.size, modified_at: info.mtime.toISOString(), target_exists: linkTarget ? existsSync(linkTarget) : null };
    } catch (readError) { beforeState = { read_error: readError.code || 'lstat_error' }; }
    return {
      candidate_id: `candidate-broken-${sha256(norm(error.path)).slice(0, 16)}`,
      classification_tags: ['BROKEN_LINK', 'UNKNOWN'],
      root_id: error.root_id,
      logical_path: error.path,
      real_path: null,
      link_type: linkType,
      link_target: linkTarget,
      before_state: beforeState,
      error_code: error.code,
      evidence: error.message
    };
  });
  const categoryCounts = {};
  for (const category of ['SAME_REAL_TARGET','SAME_ENTRY_HASH','SAME_PACKAGE_HASH','SAME_NAME_DIFFERENT_CONTENT','NESTED_RUNTIME_CHILD','PROJECT_LOCAL','HISTORICAL_COPY','BROKEN_LINK','MANAGED_SYSTEM','MANAGED_PLUGIN','MANAGED_RUNTIME','UNKNOWN']) {
    categoryCounts[category] = assets.filter(asset => asset.classification_tags.includes(category)).length + brokenLinks.filter(item => item.classification_tags.includes(category)).length;
  }
  return {
    schema: 'sgs/canonical-conflict-ledger@1',
    run_id: runId,
    generated_at: new Date().toISOString(),
    source_scan_run_id: scan.run_id,
    source_inventory_fingerprint: scan.inventory_fingerprint,
    scan_coverage: scan.scope.coverage,
    semantics: {
      canonical_id: 'Identifies a current physical target only; it does not assert semantic equivalence or authorize merge/removal.',
      package_hash_vs_fingerprint: 'package_content_hash compares included relative paths, file bytes, and package-relative symlink topology; package_fingerprint additionally binds logical/real package paths and resolved symlink/junction targets.',
      package_exclusions: 'Only explicit volatile/generated exclusions in each package record are omitted. All other files, including scripts/, references/, assets/, manifests, lockfiles, and data, are included.'
    },
    counts: {
      target_candidates: assets.length,
      broken_link_candidates: brokenLinks.length,
      all_candidates: assets.length + brokenLinks.length,
      classification_memberships: categoryCounts,
      entry_hash_duplicate_groups: entryHashGroups.length,
      entry_hash_duplicate_assets: entryHashGroups.reduce((n, group) => n + group.canonical_ids.length, 0),
      entry_hash_excess_copies: entryHashGroups.reduce((n, group) => n + group.canonical_ids.length - 1, 0),
      package_hash_duplicate_groups: packageHashGroups.length,
      package_hash_duplicate_assets: packageHashGroups.reduce((n, group) => n + group.canonical_ids.length, 0),
      same_name_groups: nameGroups.length,
      same_name_different_content_groups: nameGroups.filter(group => group.different_content).length,
      same_name_different_entry_content_groups: nameGroups.filter(group => group.different_entry_content).length,
      same_name_different_package_content_groups: nameGroups.filter(group => group.different_package_content).length,
      same_name_same_package_content_groups: nameGroups.filter(group => !group.different_package_content).length,
      same_real_target_alias_groups: realTargetGroups.length
    },
    conflicts: {
      same_real_target: realTargetGroups,
      same_entry_hash: entryHashGroups,
      same_package_hash: packageHashGroups,
      same_name: nameGroups
    },
    assets,
    broken_link_candidates: brokenLinks,
    package_fingerprint_rules: {
      included: 'Every readable regular file recursively under package root, keyed by package-relative path and SHA-256; internal symlink file/directory targets are followed only when their resolved real path remains inside package real root; all links are recorded.',
      omitted: ['.git/**','__pycache__/**','.pytest_cache/**','.mypy_cache/**','.ruff_cache/**','coverage/**','.DS_Store','Thumbs.db','desktop.ini','*.pyc','*.pyo','*.log'],
      incomplete_when: 'A file/directory cannot be read, a link is broken, or a package symlink points outside its package real root.'
    }
  };
}

export function buildM4(m3, scan, scope, runId, candidateEvidence = null) {
  const observed = new Map((scope.desktop_catalog_observation?.observed_yy_entries || []).map(row => [norm(row.path), row]));
  for (const row of candidateEvidence?.catalog_observation?.entries || []) {
    observed.set(norm(row.path), { ...row, role: 'targeted candidate observation', evidence_type: candidateEvidence.catalog_observation.evidence_type });
  }
  const rootKinds = new Map(scope.roots.map(root => [root.id, root.kind]));
  const yyRootAsset = m3.assets.find(asset => asset.classification_tags.includes('YY_TOP_LEVEL_PACKAGE'));
  const proposedCandidate = candidateEvidence?.candidate || null;
  const proposedAsset = proposedCandidate ? m3.assets.find(asset => asset.canonical_id === proposedCandidate.candidate_canonical_id) : null;
  const canonicalAsset = proposedCandidate ? m3.assets.find(asset => asset.canonical_id === proposedCandidate.canonical_alternative_id) : null;
  const observedCandidatePaths = new Set((candidateEvidence?.catalog_observation?.entries || []).map(row => norm(row.path)));
  if (proposedCandidate && (!proposedAsset || !canonicalAsset)) throw new Error('Candidate evidence references an asset that is not in the M3 ledger.');
  if (proposedCandidate && (proposedAsset.package.status !== 'COMPLETE' || canonicalAsset.package.status !== 'COMPLETE' || proposedAsset.package.package_content_hash !== canonicalAsset.package.package_content_hash || JSON.stringify(proposedAsset.entry_sha256_values) !== JSON.stringify(canonicalAsset.entry_sha256_values))) {
    throw new Error('Candidate evidence does not match complete, byte-equivalent M3 package and entry hashes.');
  }
  if (proposedCandidate && (!observedCandidatePaths.has(norm(proposedCandidate.candidate_logical_path)) || !observedCandidatePaths.has(norm(proposedCandidate.canonical_alternative_logical_path)))) {
    throw new Error('Candidate evidence lacks direct targeted catalog observations for both duplicate entries.');
  }
  const actions = m3.assets.map(asset => {
    const isManaged = asset.source_kinds.some(kind => ['SYSTEM_MANAGED', 'PLUGIN_MANAGED', 'RUNTIME_MANAGED'].includes(kind));
    const observedRow = asset.logical_paths.map(logical => observed.get(norm(logical))).find(Boolean) || null;
    let action;
    let reason;
    let proposedScope;
    let confidence;
    const isPreparedRemoval = proposedCandidate && asset.canonical_id === proposedCandidate.candidate_canonical_id;
    if (isManaged) {
      action = 'MANAGED_NO_TOUCH';
      proposedScope = 'managed-current-scope';
      reason = 'System, plugin, and runtime managed assets are excluded from automatic cleanup or relocation.';
      confidence = 'high';
    } else if (isPreparedRemoval) {
      action = proposedCandidate.proposed_action;
      proposedScope = 'preserved-outside-default-discovery';
      reason = proposedCandidate.reason;
      confidence = 'medium-high';
    } else if (observedRow) {
      action = 'KEEP_ACTIVE';
      proposedScope = 'current-desktop-discovery';
      reason = 'This exact logical path is directly present in the active Desktop session catalog observation; scoped evidence only.';
      confidence = 'high';
    } else {
      action = 'HOLD_UNKNOWN';
      proposedScope = 'unchanged-pending-evidence';
      reason = asset.classification_tags.includes('HISTORICAL_COPY')
        ? 'Path naming provides historical-copy evidence, but dependencies, ownership, replacement completeness, and safe restoration are unverified.'
        : 'Exact current Desktop discovery, package-level dependency use, or signed per-asset disposition is not established.';
      confidence = 'low';
    }
    const sourceRootIds = asset.logical_paths.flatMap(logical => {
      const entry = scan.entries.find(row => norm(row.logical_path) === norm(logical));
      return entry?.root_ids || [];
    });
    const primaryRoot = sourceRootIds[0];
    const rootKind = rootKinds.get(primaryRoot) || asset.source_kinds[0] || 'UNKNOWN';
    return {
      canonical_id: asset.canonical_id,
      logical_path: asset.logical_paths[0] || null,
      logical_paths: asset.logical_paths,
      real_path: asset.real_path,
      package_fingerprint: asset.package.package_fingerprint,
      package_content_hash: asset.package.package_content_hash,
      source_owner: {
        root_id: primaryRoot || null,
        source: rootKind,
        owner: rootKind === 'USER_SKILLS' ? 'user-level skill location; original author/license unverified' : rootKind === 'AGENT_SKILLS' ? 'agent-level skill location; original author/license unverified' : 'host/plugin/runtime managed'
      },
      current_scope: observedRow ? `active-catalog:${observedRow.role}` : rootKind,
      proposed_scope: proposedScope,
      action,
      reason,
      dependencies: isPreparedRemoval
        ? { status: candidateEvidence.candidate.dependency_review.status, evidence: candidateEvidence.candidate.dependency_review, canonical_alternative_id: candidateEvidence.candidate.canonical_alternative_id }
        : asset.classification_tags.includes('NESTED_RUNTIME_CHILD') && yyRootAsset
        ? { status: 'STRUCTURAL_PARENT_KNOWN_SEMANTIC_USE_UNVERIFIED', parent_canonical_id: yyRootAsset.canonical_id, evidence: 'The entry is physically nested in the deployed YY package. This establishes package containment, not that YY execution requires independent discovery of this child.' }
        : { status: 'UNKNOWN', evidence: 'No complete cross-package dependency graph is available for this candidate.' },
      restore_path: isPreparedRemoval ? proposedCandidate.restore_path : 'No change proposed; original logical path is preserved in place.',
      confidence,
      evidence_tags: asset.classification_tags,
      direct_desktop_observation: observedRow
    };
  });
  const counts = Object.fromEntries(['KEEP_ACTIVE','REMOVE_FROM_DEFAULT_DISCOVERY','MOVE_TO_REPO_LOCAL','MOVE_TO_RUNTIME_INTERNAL','MANAGED_NO_TOUCH','HOLD_UNKNOWN'].map(action => [action, actions.filter(item => item.action === action).length]));
  const brokenLinkCandidates = m3.broken_link_candidates.map(item => {
    const rootKind = rootKinds.get(item.root_id) || 'UNKNOWN';
    return {
      canonical_id: item.candidate_id,
      logical_path: item.logical_path,
      logical_paths: [item.logical_path],
      real_path: item.real_path,
      package_fingerprint: null,
      source_owner: { root_id: item.root_id, source: rootKind, owner: rootKind === 'AGENT_SKILLS' ? 'agent-level link; original owner unverified' : 'unverified' },
      current_scope: 'scan-error; current Desktop discovery not established',
      proposed_scope: 'unchanged-pending-evidence',
      action: 'HOLD_UNKNOWN',
      reason: 'Broken junction is not a discovered Skill target; target is missing and no canonical replacement, owner approval, or dependency proof exists.',
      dependencies: { status: 'UNKNOWN', evidence: 'Target is unavailable; consumers and replacement behavior were not established.' },
      restore_path: 'No change proposed; preserve the original reparse point and exact target path.',
      confidence: 'low',
      evidence_tags: item.classification_tags,
      broken_link_evidence: item
    };
  });
  const reasons = new Map();
  for (const item of actions.filter(action => action.action === 'HOLD_UNKNOWN')) reasons.set(item.reason, (reasons.get(item.reason) || 0) + 1);
  return {
    schema: 'sgs/governance-actions@1',
    run_id: runId,
    generated_at: new Date().toISOString(),
    source_ledger_run_id: m3.run_id,
    source_scan_run_id: scan.run_id,
    current_scope_targets: actions.length,
    current_host_observed: {
      observed_yy_entry_subset: scope.desktop_catalog_observation?.observed_yy_entries?.length || 0,
      observed_yy_nested_subset: scope.desktop_catalog_observation?.observed_yy_entries?.filter(entry => entry.role === 'nested entry').length || 0,
      separately_targeted_entry_count: candidateEvidence?.catalog_observation?.entries?.length || 0,
      separately_targeted_entries: candidateEvidence?.catalog_observation?.entries || [],
      global_desktop_catalog_count: scope.desktop_catalog_observation?.global_catalog_count ?? null
    },
    same_name_conflict_summary: {
      groups: m3.counts.same_name_groups,
      different_package_content_groups: m3.counts.same_name_different_package_content_groups,
      different_entry_content_groups: m3.counts.same_name_different_entry_content_groups,
      same_package_content_groups: m3.counts.same_name_same_package_content_groups
    },
    prepared_apply_candidate: proposedCandidate ? {
      canonical_id: proposedCandidate.candidate_canonical_id,
      canonical_alternative_id: proposedCandidate.canonical_alternative_id,
      action: proposedCandidate.proposed_action,
      restore_path: proposedCandidate.restore_path,
      apply_status: proposedCandidate.apply_readiness.status,
      apply_gate: proposedCandidate.apply_readiness.blocks_apply
    } : null,
    counts,
    error_candidate_counts: { HOLD_UNKNOWN: brokenLinkCandidates.length },
    error_candidates: brokenLinkCandidates,
    suggested_reduction: actions.filter(item => ['REMOVE_FROM_DEFAULT_DISCOVERY','MOVE_TO_REPO_LOCAL','MOVE_TO_RUNTIME_INTERNAL'].includes(item.action)).length,
    hold_unknown_reasons: [...reasons].map(([reason, count]) => ({ reason, count })).sort((a,b) => b.count-a.count),
    actions
  };
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write('Usage: node src/build-governance-ledgers.mjs --scan <scan.json> --scope <scope.json> [--candidate-evidence <screen.json>] [--m3-out <ledger.json>] [--m4-out <actions.json>]\n');
    return 0;
  }
  if (!options.scan || !options.scope) throw new Error('--scan and --scope are required');
  const scanPath = path.resolve(options.scan);
  const scopePath = path.resolve(options.scope);
  if (!existsSync(scanPath) || !existsSync(scopePath)) throw new Error('Input scan or scope file does not exist.');
  const scan = readJson(scanPath);
  const scope = readJson(scopePath);
  const candidateEvidence = options.candidateEvidence ? readJson(path.resolve(options.candidateEvidence)) : null;
  if (scan.schema !== 'sgs/scan-result@1') throw new Error('Input scan must use sgs/scan-result@1.');
  const m3 = buildM3(scan, scope, randomUUID());
  const m4 = buildM4(m3, scan, scope, randomUUID(), candidateEvidence);
  const m3Path = path.resolve(options.m3 || path.join(ROOT, 'outputs/runs/canonical-conflict-ledger.json'));
  const m4Path = path.resolve(options.m4 || path.join(ROOT, 'outputs/runs/governance-actions.json'));
  mkdirSync(path.dirname(m3Path), { recursive: true });
  mkdirSync(path.dirname(m4Path), { recursive: true });
  writeFileSync(m3Path, `${JSON.stringify(m3, null, 2)}\n`, 'utf8');
  writeFileSync(m4Path, `${JSON.stringify(m4, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify({ m3_output: m3Path, m3_run_id: m3.run_id, ...m3.counts, m4_output: m4Path, m4_run_id: m4.run_id, m4_counts: m4.counts, recommended_reduction: m4.suggested_reduction })}\n`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { process.exitCode = main(); }
  catch (error) { process.stderr.write(`${error.stack || error.message}\n`); process.exitCode = 1; }
}
