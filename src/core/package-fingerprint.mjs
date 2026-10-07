import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync, readlinkSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';

const OMIT_DIRS = new Set(['.git', '__pycache__', '.pytest_cache', '.mypy_cache', '.ruff_cache', 'coverage']);
const OMIT_FILES = new Set(['.ds_store', 'thumbs.db', 'desktop.ini']);

function sha256(value) { return createHash('sha256').update(value).digest('hex'); }
function norm(value) {
  const absolute = path.resolve(value);
  return process.platform === 'win32' ? absolute.replaceAll('/', '\\').toLowerCase() : absolute;
}
function isInside(candidate, parent) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}
function isOmitted(rel, dir) {
  const parts = rel.split(/[\\/]/).filter(Boolean);
  if (parts.some(part => OMIT_DIRS.has(part.toLowerCase()))) return true;
  const base = path.basename(rel).toLowerCase();
  return dir ? false : OMIT_FILES.has(base) || base.endsWith('.pyc') || base.endsWith('.pyo') || base.endsWith('.log');
}
export function packageFingerprint(packagePath) {
  const logicalRoot = path.resolve(packagePath);
  let realRoot;
  try { realRoot = realpathSync.native(logicalRoot); }
  catch (error) {
    return { status: 'INCOMPLETE', logical_root: logicalRoot, real_root: null, content_hash: null, fingerprint: null, file_count: 0, files: [], links: [], issues: [{ path: logicalRoot, code: error.code || 'realpath_error' }] };
  }
  const fileRows = [];
  const links = [];
  const issues = [];
  const visitedRealDirs = new Set();

  function visit(logicalDir, realDir, relDir) {
    const realKey = norm(realDir);
    if (visitedRealDirs.has(realKey)) {
      issues.push({ path: relDir || '.', code: 'directory_cycle_or_alias' });
      return;
    }
    visitedRealDirs.add(realKey);
    let names;
    try { names = readdirSync(logicalDir).sort((a, b) => a.localeCompare(b, 'en')); }
    catch (error) { issues.push({ path: relDir || '.', code: error.code || 'readdir_error' }); return; }
    for (const name of names) {
      const rel = relDir ? `${relDir}/${name}` : name;
      let info;
      try { info = lstatSync(path.join(logicalDir, name)); }
      catch (error) { issues.push({ path: rel, code: error.code || 'lstat_error' }); continue; }
      if (isOmitted(rel, info.isDirectory())) continue;
      const full = path.join(logicalDir, name);
      if (info.isSymbolicLink()) {
        let rawTarget = null;
        let realTarget;
        let targetInfo;
        try {
          rawTarget = readlinkSync(full);
          realTarget = realpathSync.native(full);
          targetInfo = statSync(full);
        } catch (error) {
          links.push({ path: rel, raw_target: rawTarget, real_target: null, status: 'BROKEN', error: error.code || 'link_error' });
          issues.push({ path: rel, code: error.code || 'link_error' });
          continue;
        }
        const inPackage = isInside(norm(realTarget), norm(realRoot));
        links.push({ path: rel, raw_target: rawTarget, real_target: realTarget, status: inPackage ? 'INTERNAL' : 'EXTERNAL' });
        if (!inPackage) { issues.push({ path: rel, code: 'external_link_not_followed' }); continue; }
        if (targetInfo.isDirectory()) visit(full, realTarget, rel);
        else if (targetInfo.isFile()) {
          try {
            const data = readFileSync(full);
            fileRows.push({ path: rel, sha256: sha256(data), size_bytes: data.length, via_link: true });
          } catch (error) { issues.push({ path: rel, code: error.code || 'read_error' }); }
        }
      } else if (info.isDirectory()) {
        let realChild;
        try { realChild = realpathSync.native(full); }
        catch (error) { issues.push({ path: rel, code: error.code || 'realpath_error' }); continue; }
        visit(full, realChild, rel);
      } else if (info.isFile()) {
        try {
          const data = readFileSync(full);
          fileRows.push({ path: rel, sha256: sha256(data), size_bytes: data.length, via_link: false });
        } catch (error) { issues.push({ path: rel, code: error.code || 'read_error' }); }
      }
    }
  }

  visit(logicalRoot, realRoot, '');
  fileRows.sort((a, b) => a.path.localeCompare(b.path, 'en'));
  links.sort((a, b) => a.path.localeCompare(b.path, 'en'));
  const contentHash = sha256(JSON.stringify({
    files: fileRows,
    symlink_topology: links.map(link => ({ path: link.path, raw_target: link.raw_target, status: link.status }))
  }));
  let rootLink = null;
  try {
    const rootStat = lstatSync(logicalRoot);
    if (rootStat.isSymbolicLink()) rootLink = { raw_target: readlinkSync(logicalRoot), real_target: realRoot };
  } catch (error) { issues.push({ path: '.', code: error.code || 'lstat_error' }); }
  const fingerprint = sha256(JSON.stringify({
    content_hash: contentHash,
    logical_root: norm(logicalRoot),
    real_root: norm(realRoot),
    root_link: rootLink,
    internal_link_relations: links
  }));
  return {
    status: issues.length ? 'INCOMPLETE' : 'COMPLETE',
    logical_root: logicalRoot,
    real_root: realRoot,
    content_hash: contentHash,
    fingerprint,
    file_count: fileRows.length,
    files: fileRows,
    links,
    issues,
    volatile_generated_exclusions: [
      '.git/**', '__pycache__/**', '.pytest_cache/**', '.mypy_cache/**', '.ruff_cache/**', 'coverage/**',
      '.DS_Store', 'Thumbs.db', 'desktop.ini', '*.pyc', '*.pyo', '*.log'
    ]
  };
}

