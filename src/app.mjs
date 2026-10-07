import { existsSync, writeFileSync, mkdirSync, accessSync, constants } from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { FilesystemExposureBackend } from './core/filesystem-exposure-backend.mjs';
import { assertProductionAuthorization } from './core/production-authorization.mjs';
import { defaultProfile, readJson, requireWritableHost } from './runtime/config.mjs';
import { readDesktopCatalogObservations } from './desktop-catalog-evidence.mjs';
import { prepareCleanupBatch, applyCleanupBatch, verifyCleanupBatch, cleanupSummary, readBatches, rollbackCleanupBatch } from './cleanup.mjs';
import { parseOptions } from './runtime/arguments.mjs';
import { bootstrap, installEntry, rebindEntry } from './deployment.mjs';

export function commandHelp() {
  return { schema: 'sgs/help@1', usage: 'node src/sgs.mjs [--config <profile.json>] <command>',
    commands: [
      { command: 'help | --help | -h', effect: 'Show commands without loading a host profile' },
      { command: 'doctor', effect: 'Read runtime dependencies, platform limits and profile readiness' },
      { command: 'init', effect: 'Create a missing local profile, default read-only; never overwrite' },
      { command: 'bootstrap', effect: 'Build read-only inventory using existing scanner and ledgers; never enable writes' },
      { command: 'install-entry [--root <user discovery root>] [--node <executable>]', effect: 'Install a thin entry without overwriting; restart/new Desktop session required' },
      { command: 'rebind-entry --entry <folder> [--project <SGS project>] [--node <executable>]', effect: 'Atomically rebind runtime pointer and save backup; preserve Skill content' },
      { command: 'status | audit', effect: 'Read configured evidence and receipts; current observation includes its timestamp' },
      { command: 'changes | inspect <ID> | verify <ID>', effect: 'Read receipts or compare filesystem state; verify does not prove Desktop exposure' },
      { command: 'plan [ID]', effect: 'Show candidates; with ID may prepare a ChangeSet receipt, never apply' },
      { command: 'apply <ID> --authorized', effect: 'Move one authorized installation after existing safety gates' },
      { command: 'rollback <ID>', effect: 'Restore one installation with concurrent-change rejection' },
      { command: 'cleanup --safe', effect: 'Read the configured cleanup plan' },
      { command: 'cleanup --safe --batch <ID> --authorization <JSON> [--max-items <N>]', effect: 'Prepare an exact batch and authorization; never apply' },
      { command: 'cleanup --apply --batch <ID> --authorized', effect: 'Apply the prepared batch' },
      { command: 'cleanup --verify --batch <ID> --evidence <JSON> --checks <JSON>', effect: 'Verify Desktop delta and smoke; failure can roll back this batch' },
      { command: 'cleanup --rollback --batch <ID>', effect: 'Roll back this batch with conflict checks' },
    ], requirements: { node: '>=24', dependencies: 'Node built-ins; PowerShell for Windows package metadata',
      production_platform: 'Windows only, with matching profile and host-specific Desktop evidence' },
    configuration_precedence: ['--config', 'SGS_CONFIG', 'project .sgs.local.json', 'read-only defaults'],
    migration_guide: 'docs/MIGRATION.md' };
}

function doctor(runtime) {
  const nodeSupported = Number(process.versions.node.split('.')[0]) >= 24;
  let powershell = { required_for: 'Windows package metadata', available: null, version: null };
  if (process.platform === 'win32') {
    try {
      powershell.available = true;
      powershell.version = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.ToString()'],
        { encoding: 'utf8', timeout: 5000, windowsHide: true }).trim();
    } catch (error) { powershell.available = false; powershell.error = error.code ?? 'POWERSHELL_UNAVAILABLE'; }
  }
  const schemas={index:['sgs/federated-observation-index@1','sgs/observed-index@1'],ledger:['sgs/canonical-conflict-ledger@1'],actions:['sgs/governance-actions@1'],reconciliation:['sgs/reconciliation-dry-run@1','sgs/reconciliation-dry-run@2'],pilot:['sgs/live-pilot@1'],filesystem_capability:['sgs/filesystem-desktop-capability@1','sgs/filesystem-desktop-probe@2'],producer:['sgs/producer-ledger@1'],cleanup_baseline:['sgs/cleanup-baseline@1'],scan:['sgs/scan-result@1'],dry_run:['sgs/profile-dry-run@1','sgs/profile-dry-run@2']};
  const artifacts = Object.fromEntries(Object.entries(runtime.artifactPaths).map(([key, file]) => {
    const row={path:file,exists:existsSync(file),readable:false,valid_json:false,schema:null,schema_valid:false,error:null};
    try{accessSync(file,constants.R_OK);row.readable=true;const data=readJson(file);row.valid_json=true;row.schema=data?.schema??null;
      row.schema_valid=Boolean(schemas[key]?.includes(data?.schema));
      if(key==='index')row.schema_valid&&=Boolean(data?.counts&&typeof data.counts==='object'&&!Array.isArray(data.counts));
      if(['ledger','actions'].includes(key))row.schema_valid&&=Boolean(data?.counts);
      if(key==='filesystem_capability')row.schema_valid&&=typeof data?.desktop_status==='string';
      if(!row.schema_valid)row.error='ARTIFACT_SCHEMA_INVALID';
    }catch(error){row.error=error.code??error.message;}return[key,row];
  }));
  const limitations = [];
  if (!nodeSupported) limitations.push('NODE_24_REQUIRED');
  if (process.platform !== 'win32') limitations.push('PRODUCTION_WRITES_NOT_VERIFIED_ON_PLATFORM');
  if (powershell.available === false) limitations.push('WINDOWS_PACKAGE_METADATA_DEPENDENCY_MISSING');
  if (!runtime.configured) limitations.push('PROFILE_NOT_INITIALIZED');
  if (!runtime.hostMatches) limitations.push('HOST_BINDING_NOT_MATCHED');
  if (Object.values(artifacts).some(row => !row.exists)) limitations.push('CONFIGURED_ARTIFACT_MISSING');
  if (Object.values(artifacts).some(row => row.exists&&!row.schema_valid)) limitations.push('CONFIGURED_ARTIFACT_INVALID');
  if (runtime.desktopCapability?.desktop_status !== 'PASS') limitations.push('DESKTOP_CAPABILITY_NOT_PROVEN');
  const volumeConflicts=process.platform==='win32'?runtime.discoveryRoots.filter(folder=>path.parse(folder).root.toLowerCase()!==path.parse(runtime.coldStore).root.toLowerCase()).map(folder=>({discovery_root:folder,cold_store:runtime.coldStore,root_volume:path.parse(folder).root,cold_store_volume:path.parse(runtime.coldStore).root})):[];
  if(volumeConflicts.length)limitations.push('CROSS_VOLUME_COLD_STORE');
  let boundaryError=null;try{backendFor(runtime);}catch(error){boundaryError={code:error.code,message:error.message,discovery_roots:runtime.discoveryRoots,cold_store:runtime.coldStore};limitations.push(error.code);}
  return { schema: 'sgs/doctor@1', node: process.versions.node, node_supported: nodeSupported,
    platform: process.platform, project_root: runtime.projectRoot, config: runtime.configPath,
    configured: runtime.configured, host_key: runtime.hostKey, host_binding_matches: runtime.hostMatches,
    discovery_roots: runtime.discoveryRoots.map(folder => ({ path: folder, exists: existsSync(folder),
      same_volume_as_cold_store: process.platform === 'win32' ? path.parse(folder).root.toLowerCase() === path.parse(runtime.coldStore).root.toLowerCase() : null })),
    cold_store: runtime.coldStore, production_writes_enabled: runtime.writesEnabled,
    desktop_capability: runtime.desktopCapability?.desktop_status ?? 'UNKNOWN', artifacts,
    dependencies: { powershell }, limitations,volume_conflicts:volumeConflicts,boundary_error:boundaryError,
    capabilities: { read_only_commands: nodeSupported, windows_package_metadata: process.platform === 'win32' && powershell.available === true,
      production_platform_verified: process.platform === 'win32', configured_host_write_switch: runtime.writesEnabled,
      apply_authorized: false, apply_authorization_scope: 'Each exact ChangeSet is checked separately; doctor grants no authorization',
      desktop_evidence_scope: 'Specific matching host; not inherited on migration' },
    next_action: !nodeSupported ? 'Install Node 24 or later'
      : !runtime.configured ? 'Run init to create a read-only local profile'
      : volumeConflicts.length ? 'Configure cold_store on the same volume as the intended discovery_root'
      : boundaryError ? 'Configure cold_store outside every discovery_root, with neither containing the other'
      : Object.values(artifacts).some(row => !row.exists) ? 'Repair the missing configured artifact path before reading that evidence'
      : 'Use status for timestamped observations; new apply still requires its exact gates' };
}

function backendFor(runtime) {
  return new FilesystemExposureBackend({ discoveryRoots: runtime.discoveryRoots,
    coldStore: runtime.coldStore, desktopCapability: runtime.desktopCapability });
}
function batchView(runtime, batch) {
  return { schema: 'sgs/cleanup-batch-result@1', id: batch.id, state: batch.state,
    canary: batch.canary, selected: batch.selected_count, eligible: batch.eligible_count,
    moved_packages: batch.actual_exit_count ?? 0, filesystem_exposures_exited: batch.actual_exposure_exit_count ?? 0,
    desktop: batch.desktop_verification ? { status: batch.desktop_verification.status,
      before: batch.desktop_verification.before.installation_count, after: batch.desktop_verification.after.installation_count,
      observed_reduction: batch.desktop_verification.observed_catalog_reduction } : { status: 'NOT_VERIFIED', before: batch.before_desktop.installation_count, after: null },
    pending: batch.pending ?? [], failure: batch.failure, permanent_deletions: batch.permanent_deletions,
    unique_capability_loss: batch.unique_capability_loss, managed_changes: batch.managed_changes,
    receipt: path.join(runtime.coldStore, 'batches', `${batch.id}.json`),
    items: batch.items.map(item => ({ changeset_id: item.changeset_id, target: item.target,
      canonical: item.canonical_path, confidence: item.cleanup_confidence,
      cold_path: item.cold_path, exposure_count: item.exposure_paths.length,
      receipt: path.join(runtime.coldStore, 'changesets', `${item.changeset_id}.json`) })) };
}
function currentCleanupCandidates(baseline) {
  return (baseline?.installations ?? []).filter(row => row.classification === 'AUTO_CLEAN' && existsSync(row.logical_path));
}
function status(runtime, backend) {
  const index = runtime.artifact('index');
  const ledger = runtime.artifact('ledger');
  const actions = runtime.artifact('actions');
  const reconciliation = runtime.artifact('reconciliation');
  const pilot = runtime.artifact('pilot');
  const result = {
    schema: 'sgs/status@1',
    runtime: { profile: runtime.profile.profile_name, configured: runtime.configured,
      config: runtime.configPath, project_root: runtime.projectRoot, host_binding_matches: runtime.hostMatches,
      production_writes_enabled: runtime.writesEnabled,
      evidence_status: index?.schema==='sgs/observed-index@1' ? 'CURRENT_SCOPED_FILESYSTEM'
        : index ? runtime.hostMatches ? 'HISTORICAL_BOUND_HOST' : 'HISTORICAL_UNBOUND_HOST' : 'NOT_INITIALIZED' },
    native_desktop: runtime.hostMatches ? runtime.profile.native_desktop ?? 'UNKNOWN' : 'UNKNOWN',
    filesystem_desktop: runtime.desktopCapability?.desktop_status ?? 'UNKNOWN',
    index: index?.counts ?? null,
    evidence_scope: index?.evidence_scope ?? (index ? 'Historical bounded index; not a complete Desktop global baseline' : 'No inventory configured; counts are unknown, not zero'),
    changes: backend.changes({tolerant:true}).map(row => ({ id: row.id, state: row.state, probe: row.probe, blockers: row.blockers,error:row.error,path:row.path })),
    production_deletions: 0,
    cleanup: cleanupSummary(runtime),
    duplicates: ledger ? { package_groups: ledger.counts.package_hash_duplicate_groups,
      package_members: ledger.counts.package_hash_duplicate_assets, entry_groups: ledger.counts.entry_hash_duplicate_groups } : null,
    conflicts: ledger ? { same_name_different_package_groups: ledger.counts.same_name_different_package_content_groups } : null,
    actions: actions?.counts ?? null,
    reconciliation: reconciliation ? { status: reconciliation.status, readiness: reconciliation.readiness_counts,
      write_enabled: false, evidence_scope: 'Historical native-backend dry-run; live filesystem pilot is reported separately' } : null,
  };
  result.degraded=result.cleanup.degraded||result.changes.some(row=>row.error==='CORRUPT_RECEIPT');
  if (pilot) result.live_pilot = {
    id: pilot.changeset_id, phase: pilot.phase, desktop_apply: pilot.desktop_apply,
    selector_observation: pilot.selector_observation, desktop_catalog_evidence: pilot.desktop_catalog_evidence,
    rollback: pilot.rollback, canonical_smoke_exit_code: pilot.canonical_smoke?.exit_code,
    resurrection: pilot.resurrection, actual_current_reduction: pilot.actual_current_reduction ?? 0,
    installation_move_operations: pilot.production_installations_moved, assets_deleted: pilot.real_assets_deleted,
    blockers: pilot.blockers ?? [], v0_done: runtime.hostMatches && (pilot.v0_done ?? false), evidence_host_matches: runtime.hostMatches,
  };
  if (runtime.hostMatches && result.cleanup.latest_batch?.state === 'PASS' && result.cleanup.latest_batch.desktop === 'PASS')
    result.cleanup.desktop_current_installations = result.cleanup.desktop_last_observed_installations;
  result.current_discovery = { desktop_last_observed_installations: result.cleanup.desktop_last_observed_installations,
    desktop_current_installations: result.cleanup.desktop_current_installations,
    filesystem_scoped_entries: result.cleanup.current_scoped_installations,
    filesystem_counts_include_broken_entries: true,
    scope: 'Desktop session catalog and filesystem rows are separate units; not a global host completeness claim' };
  // A frozen batch acceptance is historical; a later same-workspace catalog can differ.
  const accepted = runtime.hostMatches ? readBatches(runtime,{tolerant:true}).filter(row=>!row.error).at(-1)?.desktop_verification?.after : null;
  if (accepted?.source_file && existsSync(accepted.source_file)) {
    try {
      const current = readDesktopCatalogObservations({ sessionFile: accepted.source_file, workspace: runtime.projectRoot }).at(-1);
      if (current && Date.parse(current.timestamp) >= Date.parse(accepted.timestamp)) {
        result.cleanup.desktop_accepted_batch_installations = accepted.installation_count;
        result.cleanup.desktop_accepted_batch_observed_at = accepted.timestamp;
        result.cleanup.desktop_current_installations = current.installation_count;
        result.cleanup.desktop_last_observed_installations = current.installation_count;
        result.cleanup.desktop_last_observed_at = current.timestamp;
        result.current_discovery.desktop_current_installations = current.installation_count;
        result.current_discovery.desktop_last_observed_installations = current.installation_count;
        result.current_discovery.desktop_last_observed_at = current.timestamp;
        result.current_discovery.source_file = current.source_file;
        result.current_discovery.source_line = current.source_line;
        result.current_discovery.source_record_sha256 = current.source_record_sha256;
        result.current_discovery.scope = current.scope;
      }
    } catch (error) {
      result.current_discovery.desktop_current_installations = null;
      result.current_discovery.observation_error = error.message;
    }
  }
  result.suggested_next_action = !index ? 'Initialize a local profile and explicitly supply this host inventory and Desktop evidence'
    : !runtime.hostMatches ? 'Read historical data only; establish this host profile and Desktop capability before production writes'
    : result.live_pilot?.blockers?.length ? 'Resolve the specific pilot blockers before any further apply'
    : result.live_pilot?.v0_done ? 'V0 pilot complete and restored; any new production apply requires fresh exact authorization'
    : 'Inspect the configured candidate and its current gates';
  if (result.cleanup.latest_batch) result.suggested_next_action = result.cleanup.latest_batch.state === 'APPLIED_AWAITING_DESKTOP'
    ? 'Verify the applied batch using a fresh actual Desktop catalog; subsequent batches remain gated'
    : result.cleanup.latest_batch.state === 'PREPARED' ? 'Apply the prepared batch using its new Owner authorization'
    : result.cleanup.latest_batch.state === 'PASS' ? 'Read the accepted cleanup summary and remaining candidates'
    : 'Inspect the latest batch and its specific recovery state';
  return result;
}
export function executeCommand(runtime, [command = 'status', id, ...flags] = []) {
  if (['help', '--help', '-h'].includes(command)) return commandHelp();
  if (command === 'init') {
    if (runtime.configured) throw new Error('PROFILE_EXISTS_NO_OVERWRITE');
    mkdirSync(path.dirname(runtime.configPath),{recursive:true});
    writeFileSync(runtime.configPath, JSON.stringify(defaultProfile(), null, 2) + '\n', { flag: 'wx' });
    return { schema: 'sgs/init@1', config: runtime.configPath, production_writes_enabled: false, capability: 'UNKNOWN' };
  }
  if (command === 'doctor') return doctor(runtime);
  if (['bootstrap','install-entry','rebind-entry'].includes(command)) {
    const {options,positionals}=parseOptions([id,...flags].filter(Boolean),{values:['root','entry','project','node']});
    if(positionals.length)throw new Error('UNEXPECTED_DEPLOYMENT_ARGUMENT');
    if(command==='bootstrap')return bootstrap(runtime);
    if(command==='install-entry')return installEntry(runtime,options);
    return rebindEntry(runtime,options);
  }
  const backend = backendFor(runtime);
  if (command === 'status' || command === 'audit') return status(runtime, backend);
  if (command === 'changes') {
    const batches=readBatches(runtime,{tolerant:true}),installations=backend.changes({tolerant:true});
    return {schema:'sgs/changes@2',degraded:[...batches,...installations].some(row=>row.error==='CORRUPT_RECEIPT'),
      batches:batches.map(batch=>batch.error?batch:batchView(runtime,batch)),
      installations:installations.map(row=>({id:row.id,state:row.state,target:row.target,restore_path:row.restore_path,blockers:row.blockers,error:row.error,path:row.path}))};
  }
  if (command === 'cleanup') {
    const args = [id, ...flags].filter(Boolean);
    parseOptions(args,{values:['batch','authorization','max-items','evidence','checks'],flags:['safe','apply','verify','rollback','authorized']});
    if(['--safe','--apply','--verify','--rollback'].filter(flag=>args.includes(flag)).length>1)throw Object.assign(new Error('CONFLICTING_CLEANUP_OPERATION'),{code:'CONFLICTING_CLEANUP_OPERATION'});
    const value = key => { const i = args.indexOf(key); return i >= 0 ? args[i + 1] : undefined; };
    if (args.includes('--rollback')) return batchView(runtime, rollbackCleanupBatch(runtime, value('--batch')));
    if (args.includes('--verify')) {
      const evidence = value('--evidence'), checks = value('--checks');
      return batchView(runtime, verifyCleanupBatch(runtime, value('--batch'), { desktopEvidence: evidence ? readJson(runtime.resolve(evidence)) : null,
        checks: checks ? readJson(runtime.resolve(checks)) : null }));
    }
    if (args.includes('--apply')) return batchView(runtime, applyCleanupBatch(runtime, value('--batch'), { executionAuthorized: args.includes('--authorized') }));
    if (args.includes('--safe')) {
      const baseline = runtime.artifact('cleanup_baseline');
      if (!baseline) throw new Error('CLEANUP_BASELINE_REQUIRED');
      const batchId = value('--batch');
      if (!batchId) return { schema: 'sgs/cleanup-plan@1', summary: cleanupSummary(runtime),
        candidates: currentCleanupCandidates(baseline).map(row => ({
          installation_id: row.installation_id, target: row.logical_path, canonical: row.canonical_path,
          confidence: row.cleanup_confidence, exposure_paths: row.exposure_paths })),
        next: 'Exact Owner batch authorization and --batch are required to prepare; preparation does not apply.' };
      const authorizationFile = value('--authorization');
      if (!authorizationFile) throw new Error('CLEANUP_BATCH_AUTHORIZATION_REQUIRED');
      return batchView(runtime, prepareCleanupBatch(runtime, baseline, { id: batchId,
        maxItems: Number(value('--max-items') ?? (readBatches(runtime).length ? 25 : 10)),
        authorization: readJson(runtime.resolve(authorizationFile)) }));
    }
    return cleanupSummary(runtime);
  }
  if (command === 'inspect') return backend.get(id);
  if (command === 'verify') return backend.verify(id);
  if (command === 'rollback' || command === 'enable') {
    requireWritableHost(runtime);
    return backend.rollback(id);
  }
  if (command === 'apply' || command === 'disable') {
    requireWritableHost(runtime);
    const record = backend.get(id);
    const file = path.join(runtime.authorizationDirectory, `${id}.json`);
    const authorization = existsSync(file) ? readJson(file) : null;
    assertProductionAuthorization({ record, authorization, executionAuthorized: flags.includes('--authorized') });
    return backend.disable(id, { authorized: flags.includes('--authorized') });
  }
  if (command === 'plan') {
    if (!id) return { schema: 'sgs/plan@2', cleanup: cleanupSummary(runtime),
      candidates: currentCleanupCandidates(runtime.artifact('cleanup_baseline')).map(row => ({
        installation_id: row.installation_id, logical_path: row.logical_path, canonical_path: row.canonical_path,
        confidence: row.cleanup_confidence, exposure_paths: row.exposure_paths })) };
    const existing = backend.changes().find(row => row.id === id);
    if (existing) return existing;
    const candidate = runtime.profile.candidates?.[id];
    if (!candidate) throw new Error('CANDIDATE_NOT_CONFIGURED');
    return backend.plan({ ...candidate, id, target: runtime.resolve(candidate.target),
      alternative: candidate.alternative ? runtime.resolve(candidate.alternative) : null });
  }
  throw new Error('Commands: status audit inspect plan apply rollback changes verify cleanup doctor init');
}
