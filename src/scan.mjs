import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, readdirSync, lstatSync, realpathSync, readlinkSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { readJson } from './runtime/json.mjs';
import { parseOptions } from './runtime/arguments.mjs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(SCRIPT_DIR, '..');

function normalizedPath(value) {
  const absolute = path.resolve(value);
  return process.platform === 'win32' ? absolute.replaceAll('/', '\\').toLowerCase() : absolute;
}

function pathInside(candidate, root) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function parseFrontmatter(text) {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) return { name: null, description: null, status: 'missing_frontmatter' };
  const fields = new Map();
  for (const line of match[1].split(/\r?\n/)) {
    const field = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!field) continue;
    fields.set(field[1].toLowerCase(), field[2].trim().replace(/^(['"])(.*)\1$/, '$2'));
  }
  const name = fields.get('name') || null;
  return { name, description: fields.get('description') || null, status: name ? 'parsed' : 'missing_name' };
}

function stableError(error) {
  if (error?.code === 'EACCES' || error?.code === 'EPERM') return 'permission_denied';
  if (error?.code === 'ENOENT') return 'not_found_or_broken_link';
  if (error?.code === 'ENOTDIR') return 'not_a_directory';
  return error?.code || 'io_error';
}

export function scanScope(scope, { now = new Date(), runId = randomUUID() } = {}) {
  if (!scope || !Array.isArray(scope.roots) || !scope.roots.length) throw new Error('scope.roots must be a non-empty array');
  const declared = scope.roots.map(root => ({ ...root, absolute: path.resolve(root.path) }));
  const allowedRoots = [];
  for (const root of declared) {
    try { allowedRoots.push(realpathSync.native(root.absolute)); } catch { /* missing root is reported below */ }
  }
  for (const target of scope.follow_link_targets || []) allowedRoots.push(path.resolve(target));

  const entriesByLogical = new Map();
  const errors = [];
  const links = [];
  const rootResults = [];

  function inScope(realTarget) {
    const candidate = normalizedPath(realTarget);
    return allowedRoots.some(root => pathInside(candidate, normalizedPath(root)));
  }

  function addSkill(root, logicalPath, ancestorDirs) {
    let realTarget;
    let fileInfo;
    try {
      realTarget = realpathSync.native(logicalPath);
      fileInfo = statSync(logicalPath);
    } catch (error) {
      errors.push({ root_id: root.id, path: logicalPath, code: stableError(error), message: error.message });
      return;
    }
    let buffer;
    try { buffer = readFileSync(logicalPath); }
    catch (error) {
      errors.push({ root_id: root.id, path: logicalPath, code: stableError(error), message: error.message });
      return;
    }
    const text = buffer.toString('utf8');
    const metadata = parseFrontmatter(text);
    const key = normalizedPath(logicalPath);
    const record = {
      logical_path: path.resolve(logicalPath),
      real_target: realTarget,
      target_id: sha256(Buffer.from(normalizedPath(realTarget))).slice(0, 20),
      root_ids: [root.id],
      root_kinds: [root.kind],
      package_path: path.dirname(path.resolve(logicalPath)),
      entry_sha256: sha256(buffer),
      size_bytes: fileInfo.size,
      modified_at: fileInfo.mtime.toISOString(),
      metadata,
      path_is_alias: normalizedPath(realTarget) !== key,
      ancestor_dirs: ancestorDirs
    };
    const prior = entriesByLogical.get(key);
    if (prior) {
      if (!prior.root_ids.includes(root.id)) prior.root_ids.push(root.id);
      if (!prior.root_kinds.includes(root.kind)) prior.root_kinds.push(root.kind);
      return;
    }
    entriesByLogical.set(key, record);
  }

  function walkDirectory(root, logicalDir, realDir, ancestorRealDirs) {
    const realKey = normalizedPath(realDir);
    if (ancestorRealDirs.has(realKey)) {
      errors.push({ root_id: root.id, path: logicalDir, code: 'link_cycle', message: 'Directory target repeats an ancestor real path; traversal stopped.' });
      return;
    }
    const nextAncestors = new Set(ancestorRealDirs);
    nextAncestors.add(realKey);
    let children;
    try {
      children = readdirSync(logicalDir, { withFileTypes: true });
    } catch (error) {
      errors.push({ root_id: root.id, path: logicalDir, code: stableError(error), message: error.message });
      return;
    }
    for (const child of children) {
      const logicalChild = path.join(logicalDir, child.name);
      let childStat;
      try { childStat = lstatSync(logicalChild); }
      catch (error) {
        errors.push({ root_id: root.id, path: logicalChild, code: stableError(error), message: error.message });
        continue;
      }
      const isLink = childStat.isSymbolicLink();
      if (isLink) {
        let target;
        let targetInfo;
        let rawTarget = null;
        try {
          rawTarget = readlinkSync(logicalChild);
          target = realpathSync.native(logicalChild);
          targetInfo = statSync(logicalChild);
        } catch (error) {
          links.push({ root_id: root.id, logical_path: logicalChild, link_target: rawTarget, resolved_target: null, status: 'broken_or_unreadable', error: stableError(error) });
          errors.push({ root_id: root.id, path: logicalChild, code: stableError(error), message: error.message });
          continue;
        }
        if (!inScope(target)) {
          links.push({ root_id: root.id, logical_path: logicalChild, link_target: rawTarget, resolved_target: target, status: 'excluded_out_of_scope' });
          errors.push({ root_id: root.id, path: logicalChild, code: 'link_target_out_of_scope', message: 'Target is not within a declared or explicitly allowed scan root; not traversed.' });
          continue;
        }
        links.push({ root_id: root.id, logical_path: logicalChild, link_target: rawTarget, resolved_target: target, status: 'followed', link_kind: targetInfo.isDirectory() ? 'directory' : 'file' });
        if (targetInfo.isDirectory()) walkDirectory(root, logicalChild, target, nextAncestors);
        else if (child.name.toLowerCase() === 'skill.md') addSkill(root, logicalChild, [...nextAncestors]);
        continue;
      }
      if (childStat.isDirectory()) {
        let realChild;
        try { realChild = realpathSync.native(logicalChild); }
        catch (error) {
          errors.push({ root_id: root.id, path: logicalChild, code: stableError(error), message: error.message });
          continue;
        }
        walkDirectory(root, logicalChild, realChild, nextAncestors);
      } else if (child.name.toLowerCase() === 'skill.md' && childStat.isFile()) {
        addSkill(root, logicalChild, [...nextAncestors]);
      }
    }
  }

  for (const root of declared) {
    const startErrorCount = errors.length;
    let realRoot;
    try {
      realRoot = realpathSync.native(root.absolute);
      if (!statSync(root.absolute).isDirectory()) throw Object.assign(new Error('Configured root is not a directory.'), { code: 'ENOTDIR' });
    } catch (error) {
      errors.push({ root_id: root.id, path: root.absolute, code: stableError(error), message: error.message });
      rootResults.push({ id: root.id, kind: root.kind, path: root.absolute, status: 'ERROR', skill_paths: 0, error_count: errors.length - startErrorCount });
      continue;
    }
    walkDirectory(root, root.absolute, realRoot, new Set());
    const rootEntries = [...entriesByLogical.values()].filter(entry => entry.root_ids.includes(root.id));
    const errorCount = errors.length - startErrorCount;
    rootResults.push({ id: root.id, kind: root.kind, path: root.absolute, real_path: realRoot, status: errorCount ? 'PARTIAL' : 'COMPLETE', skill_paths: rootEntries.length, error_count: errorCount });
  }

  const entries = [...entriesByLogical.values()].map(({ ancestor_dirs: _omit, ...entry }) => entry).sort((a, b) => a.logical_path.localeCompare(b.logical_path));
  const targets = new Map();
  for (const entry of entries) {
    const key = normalizedPath(entry.real_target);
    const group = targets.get(key) || { target_id: entry.target_id, real_target: entry.real_target, logical_paths: [], entry_sha256: [] };
    group.logical_paths.push(entry.logical_path);
    if (!group.entry_sha256.includes(entry.entry_sha256)) group.entry_sha256.push(entry.entry_sha256);
    targets.set(key, group);
  }
  const aliases = [...targets.values()].filter(group => group.logical_paths.length > 1).map(group => ({ ...group, alias_count: group.logical_paths.length - 1 }));
  const uniqueContentHashes = new Set(entries.map(entry => entry.entry_sha256));
  const desktopObservation = scope.desktop_catalog_observation || null;
  const inventoryFingerprint = sha256(Buffer.from(JSON.stringify(entries.map(entry => ({
    logical_path: entry.logical_path,
    real_target: entry.real_target,
    target_id: entry.target_id,
    root_ids: [...entry.root_ids].sort(),
    entry_sha256: entry.entry_sha256,
    metadata: entry.metadata
  })))));

  return {
    schema: 'sgs/scan-result@1',
    run_id: runId,
    generated_at: now.toISOString(),
    tool: { name: 'sgs-readonly-scanner', version: '0.1.0', node: process.version },
    workspace: PROJECT_ROOT,
    host: scope.host || { product: 'unknown', version: null },
    scope: {
      id: scope.scope_id || 'unspecified',
      root_count: declared.length,
      roots: rootResults,
      follow_link_targets: scope.follow_link_targets || [],
      exclusions: ['No full-disk traversal', 'No writes to scanned roots', 'Links outside declared/allowed roots are recorded and not traversed'],
      coverage: rootResults.every(root => root.status === 'COMPLETE') && errors.length === 0 ? 'COMPLETE' : 'PARTIAL'
    },
    inventory_fingerprint: inventoryFingerprint,
    counts: {
      logical_skill_paths: entries.length,
      unique_real_targets: targets.size,
      unique_entry_content_hashes: uniqueContentHashes.size,
      linked_paths_followed: links.filter(link => link.status === 'followed').length,
      aliases_to_shared_real_targets: aliases.reduce((sum, group) => sum + group.alias_count, 0),
      current_host_discovery: desktopObservation ? {
        evidence_type: desktopObservation.evidence_type,
        observed_yy_entry_subset: desktopObservation.observed_yy_entries?.length ?? null,
        observed_yy_nested_subset: desktopObservation.observed_yy_entries?.filter(entry => entry.role === 'nested entry').length ?? null,
        observed_session_catalog_installations: desktopObservation.observed_installations ?? null,
        global_catalog_count: desktopObservation.global_catalog_count,
        global_catalog_count_status: desktopObservation.global_catalog_count_status
      } : { evidence_type: 'none', observed_yy_entry_subset: null, global_catalog_count: null }
    },
    desktop_catalog_observation: desktopObservation,
    entries,
    aliases,
    links,
    errors
  };
}

function parseArgs(args) {
  const {options,positionals}=parseOptions(args.map(arg=>arg==='-h'?'--help':arg),{values:['scope','out','discovery-out'],flags:['help']});
  if(positionals.length)throw new Error('UNEXPECTED_ARGUMENT');
  return {...options,discoveryOut:options['discovery-out']};
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write('Usage: node src/scan.mjs --scope config/desktop-scan-scope.json [--out outputs/scan-result.json] [--discovery-out outputs/discovery-ground-truth.json]\n');
    return 0;
  }
  if (!options.scope) throw new Error('--scope is required');
  const scopePath = path.resolve(options.scope);
  const scope = readJson(scopePath);
  const result = scanScope(scope);
  const outPath = path.resolve(options.out || path.join(PROJECT_ROOT, 'outputs', 'scan-result.json'));
  mkdirSync(path.dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  if (options.discoveryOut) {
    const discoveryPath = path.resolve(options.discoveryOut);
    const discovery = {
      schema: 'sgs/discovery-ground-truth@1',
      run_id: result.run_id,
      generated_at: result.generated_at,
      host: result.host,
      scope_id: result.scope.id,
      status: result.scope.coverage,
      evidence_type: result.desktop_catalog_observation?.evidence_type || 'filesystem-only; no direct host catalog observation',
      desktop_catalog_observation: result.desktop_catalog_observation,
      current_host_discovery: result.counts.current_host_discovery,
      filesystem_scan: {
        logical_skill_paths: result.counts.logical_skill_paths,
        unique_real_targets: result.counts.unique_real_targets,
        unique_entry_content_hashes: result.counts.unique_entry_content_hashes,
        inventory_fingerprint: result.inventory_fingerprint,
        coverage: result.scope.coverage
      },
      roots: result.scope.roots,
      links: result.links,
      errors: result.errors,
      caveat: 'Filesystem counts are not substituted for a Desktop discovery total. Unknown host totals remain null.'
    };
    mkdirSync(path.dirname(discoveryPath), { recursive: true });
    writeFileSync(discoveryPath, `${JSON.stringify(discovery, null, 2)}\n`, 'utf8');
  }
  process.stdout.write(`${JSON.stringify({ run_id: result.run_id, output: outPath, ...result.counts, coverage: result.scope.coverage, errors: result.errors.length })}\n`);
  return result.scope.coverage === 'COMPLETE' ? 0 : 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { process.exitCode = main(); }
  catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
