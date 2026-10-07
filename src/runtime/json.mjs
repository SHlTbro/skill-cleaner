import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
export const readJson = file => JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
export function readReceiptCollection(folder, { tolerant = false, validate = () => true } = {}) {
  if (!existsSync(folder)) return [];
  return readdirSync(folder).filter(name => name.endsWith('.json')).map(name => {
    const file=path.join(folder,name);
    try { const row=readJson(file); if (!validate(row)) throw new Error('Receipt structure invalid'); return row; }
    catch (cause) {
      if (!tolerant) throw Object.assign(new Error(`CORRUPT_RECEIPT: ${file}`), { code:'CORRUPT_RECEIPT', cause });
      return { id:path.basename(name,'.json'), state:'CORRUPT_RECEIPT', error:'CORRUPT_RECEIPT', path:file,
        message:cause.message, blockers:['CORRUPT_RECEIPT'] };
    }
  });
}
