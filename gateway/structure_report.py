"""Single-chain structure report; no binder design or functional-site inference."""
import hashlib
import io
import json
import math
import urllib.error
import urllib.request

from Bio.PDB import PDBParser, ShrakeRupley

# Explicit mapping avoids ambiguous/modified residues entering the report.
AA3 = {'ALA':'A','ARG':'R','ASN':'N','ASP':'D','CYS':'C','GLN':'Q','GLU':'E','GLY':'G','HIS':'H','ILE':'I','LEU':'L','LYS':'K','MET':'M','PHE':'F','PRO':'P','SER':'S','THR':'T','TRP':'W','TYR':'Y','VAL':'V'}


def lookup_atlas(sequence):
    digest = hashlib.md5(sequence.encode(), usedforsecurity=False).hexdigest()
    url = f'https://biohub.ai/esm/protein/api/v1alpha1/proteins/{digest}?fold_on_miss=false&topk_features=1'
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, req, fp, code, msg, headers, newurl):
            return None
    try:
        with urllib.request.build_opener(NoRedirect).open(url, timeout=20) as response:
            raw = response.read(8_000_001)
            if len(raw) > 8_000_000:
                raise ValueError('atlas_response_too_large')
            record = json.loads(raw)
        if record.get('sequence') != sequence or record.get('protein_hash') != digest or record.get('folded_on_demand'):
            return {'status': 'rejected_record', 'source_url': url}
        pdb = record.get('pdb')
        if not isinstance(pdb, str) or not pdb.strip():
            return {'status': 'record_without_structure', 'source_url': url}
        # Do not attach inferred species or treat model features as functional sites.
        return {'status': 'found', 'pdb': pdb, 'source_url': url}
    except urllib.error.HTTPError as error:
        return {'status': 'not_found' if error.code == 404 else 'lookup_failed', 'http_status': error.code, 'source_url': url}
    except Exception:
        return {'status': 'lookup_failed', 'source_url': url}


def analyze(pdb, sequence, predicted=True, confidence=None, confidence_scale_known=True):
    if not isinstance(pdb, str) or len(pdb) > 2_000_000:
        raise ValueError('invalid_pdb')
    # Reject duplicate atom records before the permissive PDB parser can hide them.
    seen = set()
    for line in pdb.splitlines():
        if not line.startswith('ATOM  '):
            continue
        key = line[12:27]
        if key in seen or len(line) < 54 or line[16] not in (' ', 'A'):
            raise ValueError('duplicate_or_alternate_atom')
        seen.add(key)
    structure = PDBParser(QUIET=True, PERMISSIVE=False).get_structure('target', io.StringIO(pdb))
    models = list(structure.get_models())
    if len(models) != 1:
        raise ValueError('single_model_required')
    chains = [c for c in models[0] if any(r.id[0] == ' ' for r in c)]
    if len(chains) != 1:
        raise ValueError('single_protein_chain_required')
    residues = [r for r in chains[0] if r.id[0] == ' ']
    observed = ''.join(AA3.get(r.resname, '?') for r in residues)
    if observed != sequence or any('CA' not in r for r in residues):
        raise ValueError('structure_sequence_mismatch')
    for atom in structure.get_atoms():
        if not all(math.isfinite(float(v)) for v in atom.coord):
            raise ValueError('invalid_coordinates')
    ShrakeRupley(probe_radius=1.4, n_points=100).compute(models[0], level='R')
    warnings = []
    rows = []
    for i, residue in enumerate(residues, 1):
        raw_b = float(residue['CA'].bfactor)
        pl = raw_b if predicted and confidence_scale_known and math.isfinite(raw_b) and 0 <= raw_b <= 100 else None
        rows.append({'position': i, 'amino_acid': sequence[i-1], 'chain': chains[0].id,
                     'pdb_residue_number': residue.id[1], 'insertion_code': residue.id[2].strip(),
                     'plddt': pl, 'ca_b_factor': raw_b if math.isfinite(raw_b) else None,
                     'sasa_angstrom2': round(float(residue.sasa), 2)})
        if not {'N', 'CA', 'C', 'O'} <= {a.name for a in residue}:
            warnings.append(f'位置 {i} 缺少部分主链原子。')
    scores = [r['plddt'] for r in rows if r['plddt'] is not None]
    low = []
    for row in rows:
        if row['plddt'] is not None and row['plddt'] < 70:
            if low and row['position'] == low[-1]['end'] + 1:
                low[-1]['end'] = row['position']
            else:
                low.append({'start': row['position'], 'end': row['position']})
    breaks = []
    for i in range(1, len(residues)):
        distance = float(residues[i]['CA'] - residues[i-1]['CA'])
        if not 2.5 <= distance <= 4.5:
            breaks.append({'positions':[i,i+1], 'ca_distance_angstrom':round(distance,3)})
    if breaks:
        warnings.append('部分相邻残基的 CA 间距异常，请检查原始结构；不是完整立体化学验证。')
    if predicted and not confidence_scale_known:
        warnings.append('Atlas PDB 置信度量纲未单独确认，未按 pLDDT 阈值分类。')
    warnings += ['溶剂可及面积由当前静态结构计算，不等于功能位点或适合结合的表位。',
                 '未执行功能位点认定、binder 设计、亲和力或实验有效性判断。']
    return {'sequence_verified': True, 'residue_count': len(rows), 'chain': chains[0].id,
            'coordinate_system': 'position: 1-based input sequence; original PDB numbering preserved separately',
            'structure_kind': 'predicted' if predicted else 'experimental_reference',
            'mean_plddt': round(sum(scores)/len(scores),2) if len(scores)==len(rows) else None,
            'plddt_scale': '0-100' if predicted and confidence_scale_known else None,
            'fraction_plddt_ge_70': sum(x>=70 for x in scores)/len(scores) if len(scores)==len(rows) else None,
            'low_confidence_regions': low, 'ca_geometry_warnings': breaks, 'residues': rows,
            'sasa_method': {'algorithm':'Shrake-Rupley','probe_radius_angstrom':1.4,'points_per_atom':100},
            'model_confidence': confidence or {}, 'warnings': warnings}
