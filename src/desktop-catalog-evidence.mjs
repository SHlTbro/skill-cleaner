import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const hash = value => createHash('sha256').update(value).digest('hex');
const normalized = value => path.win32.normalize(value).toLowerCase();

// Read the host-provided index, never assistant claims, tool output, or CLI lists.
export function parseSkillCatalog(text, skillName) {
  const header = text.indexOf('### Available skills');
  if (header < 0) throw new Error('CATALOG_HEADER_MISSING');
  const roots = {};
  for (const line of text.slice(0, header).split(/\r?\n/)) {
    const match = line.match(/^- `([^`]+)` = `([^`]+)`\s*$/);
    if (match) roots[match[1]] = match[2];
  }
  const matches = [];
  let parsed = 0;
  const section = text.slice(header).split('</skills_instructions>')[0];
  for (const line of section.split(/\r?\n/)) {
    if (!line.startsWith('- ')) continue;
    const match = line.match(/^- (.+?): .*\(file: (.+)\)\s*$/);
    if (!match) throw new Error('INCOMPLETE_CATALOG_ENTRY');
    const [alias, ...parts] = match[2].replaceAll('\\', '/').split('/');
    let full;
    if (roots[alias]) full = path.win32.resolve(roots[alias], ...parts);
    else if (path.win32.isAbsolute(match[2])) full = path.win32.normalize(match[2]);
    else throw new Error('UNRESOLVED_CATALOG_ROOT');
    parsed++;
    if (skillName === undefined || match[1] === skillName) matches.push({ name: match[1], skill_file: full, original_line: line });
  }
  if (!parsed) throw new Error('EMPTY_CATALOG');
  return { roots, entries: matches };
}

// A refreshed persisted Desktop catalog is an observation, not a filesystem count.
export function readDesktopCatalogObservations({ sessionFile, workspace }) {
  const rows = readFileSync(sessionFile, 'utf8').split(/\r?\n/)
    .map((raw, i) => raw ? { ...JSON.parse(raw), source_line: i + 1, raw_hash: hash(raw) } : null).filter(Boolean);
  const meta = rows.find(row => row.type === 'session_meta')?.payload;
  if (meta?.originator !== 'Codex Desktop') throw new Error('NOT_DESKTOP_SESSION');
  const catalogs = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (row.type !== 'response_item' || row.payload?.role !== 'developer') continue;
    const text = (row.payload.content ?? []).map(item => item.text ?? '').join('\n');
    const header = text.indexOf('### Available skills');
    if (header < 0 || !text.slice(header).includes('(file: ')) continue;
    const next = rows.slice(i + 1).find(item => item.type === 'turn_context');
    if (!next || !Number.isFinite(Date.parse(row.timestamp)) || !Number.isFinite(Date.parse(next.timestamp))
      || Date.parse(next.timestamp) < Date.parse(row.timestamp)
      || Date.parse(next.timestamp) - Date.parse(row.timestamp) > 5000
      || normalized(next.payload.cwd) !== normalized(workspace)) continue;
    const catalog = parseSkillCatalog(text);
    catalogs.push({ timestamp: row.timestamp, observed_at: row.timestamp,
      source_file: sessionFile, source_line: row.source_line, source_record_sha256: row.raw_hash,
      originator: meta.originator, session_id: meta.session_id, turn_id: next.payload.turn_id,
      cwd: next.payload.cwd, roots: catalog.roots, entries: catalog.entries,
      logical_paths: catalog.entries.map(entry => path.win32.dirname(entry.skill_file)),
      installation_count: catalog.entries.length,
      scope: 'Actual Desktop session catalog; global host completeness is not asserted' });
  }
  return catalogs;
}

export function extractDesktopPilotEvidence({ sessionFile, receipt, workspace, skillName }) {
  const rows = readFileSync(sessionFile, 'utf8').split(/\r?\n/)
    .map((raw, i) => raw ? { ...JSON.parse(raw), source_line: i + 1, raw_hash: hash(raw) } : null).filter(Boolean);
  const meta = rows.find(row => row.type === 'session_meta')?.payload;
  if (meta?.originator !== 'Codex Desktop') throw new Error('NOT_DESKTOP_SESSION');
  const disable = receipt.history.findLast(row => row.action === 'disable' && row.result === 'PASS');
  const restore = receipt.history.findLast(row => row.action === 'rollback' && row.result === 'PASS');
  if (!disable || !restore || !(Date.parse(disable.at) < Date.parse(restore.at))) throw new Error('PILOT_TIMELINE_MISSING');
  const target = normalized(path.win32.join(receipt.target, 'SKILL.md'));
  const alternative = normalized(path.win32.join(receipt.alternative.logical_path, 'SKILL.md'));
  const catalogs = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (row.type !== 'response_item' || row.payload?.role !== 'developer') continue;
    const text = (row.payload.content ?? []).map(item => item.text ?? '').join('\n');
    if (!text.includes('### Available skills')) continue;
    // Older instruction templates can mention the header without supplying an index.
    if (!text.slice(text.indexOf('### Available skills')).includes('(file: ')) continue;
    // Desktop persists refreshed developer context before that turn's turn_context.
    const next = rows.slice(i + 1).find(item => item.type === 'turn_context');
    if (!next || !Number.isFinite(Date.parse(row.timestamp)) || !Number.isFinite(Date.parse(next.timestamp))
      || Date.parse(next.timestamp) < Date.parse(row.timestamp)
      || Date.parse(next.timestamp) - Date.parse(row.timestamp) > 5000
      || normalized(next.payload.cwd) !== normalized(workspace)) continue;
    const catalog = parseSkillCatalog(text, skillName);
    catalogs.push({ timestamp: row.timestamp, source_line: row.source_line, source_record_sha256: row.raw_hash,
      turn_id: next.payload.turn_id, cwd: next.payload.cwd, roots: catalog.roots,
      entries: catalog.entries, target_present: catalog.entries.some(entry => normalized(entry.skill_file) === target),
      alternative_present: catalog.entries.some(entry => normalized(entry.skill_file) === alternative) });
  }
  const before = catalogs.findLast(row => Date.parse(row.timestamp) < Date.parse(disable.at));
  const disabled = catalogs.findLast(row => Date.parse(row.timestamp) > Date.parse(disable.at) && Date.parse(row.timestamp) < Date.parse(restore.at));
  const restored = catalogs.find(row => Date.parse(row.timestamp) > Date.parse(restore.at));
  if (!before || !disabled || !restored) throw new Error('THREE_DESKTOP_PHASES_NOT_RECORDED');
  const others = row => row.entries.map(entry => normalized(entry.skill_file)).filter(file => file !== target).sort();
  const otherEntriesUnchanged = JSON.stringify(others(before)) === JSON.stringify(others(disabled))
    && JSON.stringify(others(before)) === JSON.stringify(others(restored));
  const passed = before.target_present && !disabled.target_present && restored.target_present
    && [before, disabled, restored].every(row => row.alternative_present) && otherEntriesUnchanged;
  return { schema: 'sgs/desktop-catalog-pilot-evidence@1', changeset_id: receipt.id,
    status: passed ? 'PASS_SESSION_CATALOG_EXACT_PATH' : 'FAIL_SESSION_CATALOG_EXACT_PATH',
    source: { kind: 'PERSISTED_DESKTOP_DEVELOPER_SKILL_CATALOG', file: sessionFile,
      session_id: meta.session_id, originator: meta.originator, runtime_client_version: meta.cli_version,
      limitation: 'Client runtime version is not an independently verified Desktop application build.' },
    target_skill_file: path.win32.join(receipt.target, 'SKILL.md'),
    alternative_skill_file: path.win32.join(receipt.alternative.logical_path, 'SKILL.md'),
    transaction: { disable_at: disable.at, rollback_at: restore.at, before_state_hash: receipt.before.state_hash },
    phases: { before, disabled, restored }, other_same_name_entries_unchanged: otherEntriesUnchanged,
    selector_observation: 'INCONCLUSIVE_SAME_NAME_ONLY',
    claim_scope: 'One exact installation in the actual Desktop session instruction catalog; not source identity in the dollar selector, global completeness, or implicit routing.',
    production_skill_writes: 0, host_config_writes: 0 };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { session: { type: 'string' }, receipt: { type: 'string' }, workspace: { type: 'string' }, output: { type: 'string' }, skill: { type: 'string' } } });
  const receipt = JSON.parse(readFileSync(values.receipt, 'utf8').replace(/^\uFEFF/, ''));
  const result = extractDesktopPilotEvidence({ sessionFile: values.session, receipt, workspace: values.workspace, skillName: values.skill || path.win32.basename(receipt.target) });
  writeFileSync(values.output, JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify({ status: result.status, source: result.source, phases: Object.fromEntries(Object.entries(result.phases).map(([name, row]) => [name, { at: row.timestamp, target_present: row.target_present, alternative_present: row.alternative_present, same_name_entry_count: row.entries.length }])) }, null, 2));
  if (!result.status.startsWith('PASS')) process.exitCode = 2;
}
