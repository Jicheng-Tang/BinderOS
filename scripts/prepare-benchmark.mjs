// Reproducible public benchmark preparation; no private sequences or credentials.
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
const source = await readFile(process.argv[2], 'utf8');
if (!source.startsWith('HEADER') || !source.includes('1WR1')) throw new Error('Expected RCSB 1WR1 PDB');
const lines = source.split(/\r?\n/); let active = false; const atoms = [], mapping = { A: [], B: [] };
for (const line of lines) {
  if (line.startsWith('MODEL ')) { if (active) break; active = true; continue; }
  if (active && line.startsWith('ENDMDL')) break;
  if (!active || !line.startsWith('ATOM  ') || !['A', 'B'].includes(line[21])) continue;
  if (line.slice(76, 78).trim() === 'H') continue;
  const ids = mapping[line[21]], original = Number(line.slice(22, 26));
  if (!ids.includes(original)) ids.push(original);
  atoms.push(line.slice(0, 22) + String(ids.indexOf(original) + 1).padStart(4) + line.slice(26));
}
if (mapping.A.length !== 76 || mapping.B.length !== 58) throw new Error('Unexpected chain lengths');
const pdb = atoms.join('\n') + '\nEND\n';
const folder = resolve(import.meta.dirname, '../gateway/benchmarks');
await mkdir(folder, { recursive: true });
await writeFile(resolve(folder, '1WR1.pdb'), pdb);
await writeFile(resolve(folder, '1WR1.json'), JSON.stringify({
  id: 'ubiquitin-dsk2-1wr1-v1', pdb_id: '1WR1', source_url: 'https://www.rcsb.org/structure/1WR1',
  download_url: 'https://files.rcsb.org/download/1WR1.pdb', organism: 'Saccharomyces cerevisiae',
  method: 'SOLUTION NMR', selected_model: 1, target_chain: 'A', design_chain: 'B',
  target_length: 76, binder_length: 58, original_residue_numbers: mapping,
  source_sha256: createHash('sha256').update(source).digest('hex'),
  prepared_sha256: createHash('sha256').update(pdb).digest('hex'),
  preparation: 'First deposited conformer; retain all protein residues and heavy atoms; renumber each chain from 1. Not de novo backbone design.',
}, null, 2) + '\n');
console.log('Prepared 1WR1: target 76 aa + UBA scaffold 58 aa, residue mapping preserved');
