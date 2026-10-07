import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, openSync, closeSync, readFileSync,
  readdirSync, readlinkSync, realpathSync, renameSync, unlinkSync, writeFileSync, fsyncSync } from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { packageFingerprint } from './package-fingerprint.mjs';
import { readJson, readReceiptCollection } from '../runtime/json.mjs';

const hash = (data) => createHash('sha256').update(data).digest('hex');
const norm = (value) => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
const inside = (child, parent) => {
  const rel = path.relative(norm(parent), norm(child));
  return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel));
};
const exists = (value) => { try { lstatSync(value); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } };
export class GovernanceError extends Error {
  constructor(code, detail) { super(`${code}: ${detail}`); this.code = code; }
}
const fail = (code, detail) => { throw new GovernanceError(code, detail); };

function aclSnapshot(entries) {
  if (process.platform !== 'win32') return entries.map(() => null);
  const script = `[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false); $ErrorActionPreference='Stop'; $paths=([Console]::In.ReadToEnd()|ConvertFrom-Json); $rows=@(); foreach($p in $paths){$a=Get-Acl -LiteralPath $p; $i=Get-Item -LiteralPath $p -Force; $rows+=@{sddl=$a.Sddl;attributes=[int]$i.Attributes;link_type=$i.LinkType}}; ConvertTo-Json -InputObject $rows -Compress`;
  const env = { ...process.env }; delete env.PSModulePath;
  const text = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
    { input: JSON.stringify(entries), encoding: 'utf8', env, windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
  return JSON.parse(text.replace(/^\uFEFF/, '').trim());
}

export function observeInstallation(folder) {
  const logical = path.resolve(folder);
  if (!exists(logical)) return { exists: false, logical_path: logical };
  const rootStat = lstatSync(logical);
  const rootLink = rootStat.isSymbolicLink();
  const raw = rootLink ? readlinkSync(logical) : null;
  if (rootLink && !path.isAbsolute(raw)) fail('UNSUPPORTED_RELATIVE_ROOT_LINK', logical);
  const pkg = packageFingerprint(logical);
  if (pkg.status !== 'COMPLETE') fail('PACKAGE_INCOMPLETE', JSON.stringify(pkg.issues));
  const entries = [];
  const paths = [];
  function walk(full, relative) {
    const info = lstatSync(full);
    const type = info.isSymbolicLink() ? 'LINK' : info.isDirectory() ? 'DIRECTORY' : info.isFile() ? 'FILE' : 'OTHER';
    if (type === 'OTHER') fail('UNSUPPORTED_ENTRY_TYPE', full);
    const row = { path: relative, type, mode: info.mode, mtime_ms: info.mtimeMs,
      birthtime_ms: info.birthtimeMs, size: type === 'FILE' ? info.size : null,
      content_hash: type === 'FILE' ? hash(readFileSync(full)) : null,
      link_target: type === 'LINK' ? readlinkSync(full) : null };
    entries.push(row); paths.push(full);
    if (type === 'DIRECTORY') for (const name of readdirSync(full).sort()) walk(path.join(full, name), relative === '.' ? name : `${relative}/${name}`);
  }
  // A root junction is moved as an entry; its source is read only for identity.
  walk(logical, '.');
  const acl = aclSnapshot(paths);
  entries.forEach((row, i) => { row.acl = acl[i]; });
  const rootType = rootLink ? (acl[0]?.link_type || 'SYMLINK') : 'DIRECTORY';
  return { exists: true, logical_path: logical, real_path: realpathSync.native(logical),
    entry_type: rootType, root_link_target: raw,
    package_content_hash: pkg.content_hash, package_fingerprint: pkg.fingerprint,
    fingerprint_rules: 'Existing M3 packageFingerprint; transactional entry manifest includes volatile files as well.',
    package_files: pkg.file_count, entry_manifest: entries,
    state_hash: hash(JSON.stringify({ package_content_hash: pkg.content_hash, root_link_target: raw, entries })) };
}

function atomicJson(file, record) {
  mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${randomUUID()}.tmp`;
  const fd = openSync(temp, 'wx');
  try { writeFileSync(fd, JSON.stringify(record, null, 2) + '\n', 'utf8'); fsyncSync(fd); }
  finally { closeSync(fd); }
  renameSync(temp, file);
}

export class FilesystemExposureBackend {
  constructor({ discoveryRoots, coldStore, desktopCapability = null }) {
    this.roots = discoveryRoots.map((r) => path.resolve(r));
    this.cold = path.resolve(coldStore);
    if (this.roots.some((r) => inside(this.cold, r) || inside(r, this.cold))) fail('COLD_STORE_OVERLAPS_DISCOVERY', this.cold);
    this.capability = desktopCapability;
  }
  target(folder) {
    const full = path.resolve(folder);
    if (!this.roots.some((r) => norm(path.dirname(full)) === norm(r))) fail('OUTSIDE_USER_DISCOVERY_ENTRY', full);
    if (['yy', '.system'].includes(path.basename(full).toLowerCase()) || path.basename(full).startsWith('.')) fail('PROTECTED_TARGET', full);
    // Discovery roots and cold-store parents must themselves be ordinary folders.
    for (const parent of [path.dirname(full), this.cold]) {
      if (exists(parent) && lstatSync(parent).isSymbolicLink()) fail('ALIASED_CONTROL_ROOT', parent);
    }
    return full;
  }
  file(id) {
    if (!/^[A-Z0-9][A-Z0-9_-]{1,100}$/.test(id)) fail('INVALID_CHANGESET_ID', id);
    return path.join(this.cold, 'changesets', `${id}.json`);
  }
  get(id) { try { return readJson(this.file(id)); } catch(cause) { if(cause.code==='ENOENT')throw cause; fail('CORRUPT_RECEIPT',this.file(id)); } }
  save(record) { record.updated_at = new Date().toISOString(); atomicJson(this.file(record.id), record); }
  observe(folder) { return observeInstallation(this.target(folder)); }
  plan({ id, target, owner, reason, alternative = null, producer = 'UNKNOWN', dependencies = [], probe = false }) {
    const full = this.target(target);
    if (owner !== 'USER') fail('OWNER_NOT_USER', owner);
    if (probe && !path.basename(full).startsWith('sgs-fs-exposure-probe-')) fail('INVALID_PROBE', full);
    if (exists(this.file(id))) fail('CHANGESET_EXISTS', id);
    const before = this.observe(full);
    if (!before.exists) fail('TARGET_MISSING', full);
    const coldPath = path.join(this.cold, 'installations', path.basename(full), id);
    if (path.parse(full).root.toLowerCase() !== path.parse(coldPath).root.toLowerCase()) fail('CROSS_VOLUME_MOVE_NOT_ALLOWED', full);
    const alt = alternative ? observeInstallation(alternative) : null;
    if (!probe && (!alt?.exists || norm(alt.logical_path) === norm(full) || alt.package_content_hash !== before.package_content_hash)) fail('CANONICAL_ALTERNATIVE_NOT_EQUAL', alternative);
    const blockers = [];
    if (!probe && producer === 'KNOWN_ACTIVE_OVERWRITER') blockers.push('P1_ACTIVE_PRODUCER');
    if (!probe && dependencies.some((d) => d.blocks_move)) blockers.push('P1_PATH_DEPENDENCY');
    if (!probe && this.capability?.desktop_status !== 'PASS') blockers.push('P1_FILESYSTEM_DESKTOP_NOT_VERIFIED');
    const record = { schema: 'sgs/filesystem-changeset@1', id, backend: 'FilesystemExposureBackend',
      state: 'PLANNED', target: full, cold_path: coldPath, owner, reason, probe,
      before, desired: { installation_in_discovery: false, asset_deleted: false },
      alternative: alt, producer, dependencies, blockers,
      evidence_limitations: producer === 'UNKNOWN' ? ['P2_PRODUCER_UNKNOWN_RESURRECTION_POSSIBLE'] : [],
      restore_path: full, risk: probe ? 'DISPOSABLE_PROBE' : 'REVERSIBLE_SINGLE_INSTALLATION',
      history: [], authorization: null };
    this.save(record); return record;
  }
  lock(record, work) {
    const lockPath = path.join(this.cold, 'locks', `${hash(norm(record.target))}.lock`);
    mkdirSync(path.dirname(lockPath), { recursive: true });
    let fd;
    try { fd = openSync(lockPath, 'wx'); } catch (e) { if (e.code === 'EEXIST') fail('CONCURRENT_TRANSACTION', record.target); throw e; }
    try { writeFileSync(fd, JSON.stringify({ pid: process.pid, changeset: record.id })); return work(); }
    finally { closeSync(fd); unlinkSync(lockPath); }
  }
  disable(id, { authorized = false, afterMove = null } = {}) {
    const record = this.get(id);
    if (!authorized) fail('AUTHORIZATION_REQUIRED', id);
    const desktopPass = this.capability?.desktop_status === 'PASS' && this.capability.phase === 'COMPLETE'
      && this.capability.baseline === 'VISIBLE' && this.capability.disabled_visibility === 'NOT_VISIBLE'
      && this.capability.rollback_visibility === 'VISIBLE' && this.capability.cleanup?.completed === true
      && this.capability.cleanup.temporary_residuals === 0;
    const blockers = record.blockers.filter(b => !(b === 'P1_FILESYSTEM_DESKTOP_NOT_VERIFIED' && desktopPass));
    if (!record.probe && !desktopPass && !blockers.includes('P1_FILESYSTEM_DESKTOP_NOT_VERIFIED')) blockers.push('P1_FILESYSTEM_DESKTOP_NOT_VERIFIED');
    if (blockers.length) fail('P1_BLOCKED', blockers.join(','));
    return this.lock(record, () => {
      this.target(record.target);
      if (!['PLANNED', 'RESTORED'].includes(record.state)) fail('INVALID_STATE', record.state);
      const current = this.observe(record.target);
      if (current.state_hash !== record.before.state_hash || current.package_fingerprint !== record.before.package_fingerprint) fail('CONCURRENT_MODIFICATION', record.target);
      if (exists(record.cold_path)) fail('COLD_STORE_CONFLICT', record.cold_path);
      if (record.alternative && observeInstallation(record.alternative.logical_path).state_hash !== record.alternative.state_hash) fail('CANONICAL_ALTERNATIVE_CHANGED', id);
      mkdirSync(path.dirname(record.cold_path), { recursive: true });
      if (norm(realpathSync.native(path.dirname(record.cold_path))) !== norm(path.dirname(record.cold_path))) fail('ALIASED_COLD_PARENT', record.cold_path);
      record.state = 'MOVE_INTENT'; record.authorization = { explicit: true, at: new Date().toISOString() }; this.save(record);
      let moved = false;
      try {
        if (exists(record.cold_path)) fail('COLD_STORE_CONFLICT', record.cold_path);
        renameSync(record.target, record.cold_path);
        moved = true;
        record.after = observeInstallation(record.cold_path);
        if (record.after.state_hash !== record.before.state_hash || exists(record.target)) fail('POST_MOVE_DRIFT', record.target);
        if (afterMove) afterMove();
        record.state = 'COLD'; record.history.push({ action: 'disable', result: 'PASS', at: new Date().toISOString() });
        this.save(record); return record;
      } catch (error) {
        if (moved && exists(record.cold_path) && !exists(record.target) && observeInstallation(record.cold_path).state_hash === record.before.state_hash) {
          renameSync(record.cold_path, record.target);
          record.state = 'RESTORED_AFTER_FAILURE';
        } else record.state = 'RECOVERY_REQUIRED';
        record.failure = { code: error.code || 'ERROR', message: error.message };
        this.save(record); throw error;
      }
    });
  }
  rollback(id, { afterMove = null } = {}) {
    const record = this.get(id);
    return this.lock(record, () => {
      this.target(record.target);
      if (!['COLD', 'MOVE_INTENT', 'ROLLBACK_INTENT', 'RECOVERY_REQUIRED'].includes(record.state)) fail('INVALID_STATE', record.state);
      if (exists(record.target)) {
        const restored = this.observe(record.target);
        if (['ROLLBACK_INTENT', 'RECOVERY_REQUIRED'].includes(record.state) && !exists(record.cold_path) && restored.state_hash === record.before.state_hash && restored.package_fingerprint === record.before.package_fingerprint) {
          record.state = 'RESTORED'; record.restored = restored;
          record.history.push({ action: 'recover-rollback', result: 'PASS', at: new Date().toISOString() });
          this.save(record); return record;
        }
        fail('CONCURRENT_MODIFICATION', 'Original path occupied; no overwrite');
      }
      const current = observeInstallation(record.cold_path);
      if (!current.exists || current.state_hash !== (record.after?.state_hash ?? record.before.state_hash)) fail('CONCURRENT_MODIFICATION', 'Cold package changed');
      record.state = 'ROLLBACK_INTENT'; this.save(record);
      renameSync(record.cold_path, record.target);
      try {
        const restored = this.observe(record.target);
        if (restored.state_hash !== record.before.state_hash || restored.package_fingerprint !== record.before.package_fingerprint) fail('RESTORE_VERIFICATION_FAILED', id);
        if (afterMove) afterMove();
        record.state = 'RESTORED'; record.restored = restored;
        record.history.push({ action: 'rollback', result: 'PASS', at: new Date().toISOString() });
        this.save(record); return record;
      } catch (error) {
        record.state = 'RECOVERY_REQUIRED'; record.failure = { message: error.message }; this.save(record); throw error;
      }
    });
  }
  enable(id) { return this.rollback(id); }
  verify(id) {
    const record = this.get(id);
    const active = exists(record.target) ? this.observe(record.target) : null;
    const cold = exists(record.cold_path) ? observeInstallation(record.cold_path) : null;
    return { id, receipt_state: record.state, active_exists: Boolean(active), cold_exists: Boolean(cold),
      asset_preserved: Boolean(active?.state_hash === record.before.state_hash || cold?.state_hash === record.before.state_hash),
      exact_before_restored: Boolean(active?.state_hash === record.before.state_hash && active?.package_fingerprint === record.before.package_fingerprint),
      resurrection: record.state === 'COLD' && Boolean(active) ? 'RESURRECTION_DETECTED' : 'NOT_OBSERVED',
      desktop_visibility: 'REQUIRES_SAME_HOST_OBSERVATION' };
  }
  changes(options = {}) {
    const folder = path.join(this.cold, 'changesets');
    return readReceiptCollection(folder,{...options,validate:row=>Boolean(row?.id&&row?.state&&Array.isArray(row.blockers))});
  }
}
