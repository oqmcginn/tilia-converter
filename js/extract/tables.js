// Faunal tables from PDFs. pdf.js gives each text run with its position; this rebuilds
// lines and columns so counts land under the right analysis unit:
//
//   Taxon                 6   5e  5d  5c ...  Total
//   Sorex sp. (2 taxa)        1   4   1   ...  6
//
// Rows are lines that start with a taxon name followed by counts or presence marks
// (X, +, •, ✓). Column names come from the header line above the first row. When the
// columns are time bins (MIS stages, ages) and there is a Total column, the expert
// convention is a single "Assemblage" of totals; otherwise each column is a unit.

import { findTaxon } from '../record.js';

const MARK = /^(?:x|X|\+|•|●|✓|✔|P|p|\*)$/;
const NUM = /^\d{1,6}(?:\.\d+)?$/;
const NOT_TAXON = /^(total|totals|sum|table|taxon|taxa|species|number|nisp|mni|unit|level|layer|stratum|zone|sample|site|area|depth|age|class|order|family|genus|note|notes|key|mammals?|birds?|fish|reptiles?|amphibians?|grand total|n|count|percent|%)\b/i;
const LATIN = /^[A-Z][a-z]{2,}(?:[ -](?:cf\.|aff\.|sp\.|spp\.|indet\.?|[a-z]{3,}|[A-Z]\.|\([^)]*\)|nr\.|n\. ?sp\.))*$/;

function lines(items) {
  const rows = [];
  for (const it of items) {
    if (!it.s.trim()) continue;
    let row = rows.find((r) => Math.abs(r.y - it.y) <= Math.max(1.5, it.h * 0.35));
    if (!row) { row = { y: it.y, items: [] }; rows.push(row); }
    row.items.push(it);
  }
  rows.sort((a, b) => b.y - a.y);
  for (const r of rows) {
    r.items.sort((a, b) => a.x - b.x);
    // merge runs into tokens: numbers stay separate, words join when close together
    const toks = [];
    for (const it of r.items) {
      for (const part of it.s.split(/\s{2,}/)) {
        const t = part.trim();
        if (!t) continue;
        const last = toks[toks.length - 1];
        const x0 = it.x + (part === it.s ? 0 : it.w * (it.s.indexOf(part) / Math.max(1, it.s.length)));
        const w = it.w * (t.length / Math.max(1, it.s.length));
        if (last && !NUM.test(t) && !NUM.test(last.t) && !MARK.test(t) && x0 - last.x1 < 6) { last.t += (x0 - last.x1 > 1 ? ' ' : '') + t; last.x1 = x0 + w; }
        else toks.push({ t, x0, x1: x0 + w });
      }
    }
    r.toks = toks;
  }
  return rows;
}

const isValue = (t) => NUM.test(t) || MARK.test(t);
// common names with the Latin in parentheses: "Duck (Anas sp.)", "marsupial (Lestodelphys halli)"
const cleanTaxon = (s) => {
  const t = s.replace(/\s*\((?:N\s*)?\d+\s*taxa\)/i, '').replace(/\s*\(\s*$/, '').replace(/\s+/g, ' ').trim();
  const inner = t.match(/\(([A-Z][a-z]{2,}(?: (?:cf\.|aff\.|sp\.|spp\.|[a-z]{3,}|[A-Z]\.))*)\)/);
  return inner ? inner[1] : t;
};
// ordinary English in a row label means it isn't a taxon (lithology, taphonomy, sex estimates…)
const ENGLISH = /\b(with|and|the|of|in|on|or|light|heavy|heat|digestion|silt|sand|sandy|clay|gravel|beds?|unit|layer|inferred|male|female|subtidal|intertidal|percent|organic|roots?|casts?|grey|gray|brown|dark|alteration|weathering|burn(?:ed|t)|cut|marks?|fragments?|specimens?|samples?|deposits?|level|lower|upper|middle|total)\b/i;

function rowName(tokens) {
  // name = leading text tokens before the first value
  const name = [];
  for (const t of tokens) { if (isValue(t.t)) break; name.push(t); }
  return name;
}

function looksTaxon(name) {
  const n = cleanTaxon(name);
  if (!n || NOT_TAXON.test(n) || n.length > 60) return false;
  if (findTaxon(n)) return true;
  return LATIN.test(n) && !ENGLISH.test(n);
}
const strongTaxon = (n) => !!findTaxon(n);

export function findFaunalTables(pages) {
  const tables = [];
  for (const page of pages) {
    if (!page.items?.length) continue;
    const L = lines(page.items);
    let cur = null;
    let gap = 0;
    const flush = () => { if (cur && cur.rows.length >= 2) tables.push(cur); cur = null; gap = 0; };
    L.forEach((ln, li) => {
      const nameToks = rowName(ln.toks);
      const name = nameToks.map((t) => t.t).join(' ');
      const vals = ln.toks.slice(nameToks.length).filter((t) => isValue(t.t));
      const nameX = nameToks[0]?.x0;
      if (nameToks.length && vals.length && looksTaxon(name) && (!cur || Math.abs(nameX - cur.nameX) < 12)) {
        if (!cur) cur = { page: page.page, nameX, startLine: li, rows: [], lines: L };
        // stop values at the first word token after them (prose in a neighbouring column)
        const after = ln.toks.slice(nameToks.length);
        const stop = after.findIndex((t) => !isValue(t.t));
        const own = (stop < 0 ? after : after.slice(0, stop)).map((t) => ({ v: t.t, c: (t.x0 + t.x1) / 2 }));
        cur.rows.push({ taxon: cleanTaxon(name), vals: own, y: ln.y });
        gap = 0;
        return;
      }
      if (cur) {
        // a wrapped taxon name ("Callospermophilus cf." / "lateralis")
        const only = ln.toks.filter((t) => t.x0 < cur.nameX + 60);
        if (only.length === 1 && /^[a-z]{3,}$/.test(only[0].t) && Math.abs(only[0].x0 - cur.nameX) < 14 && cur.rows.length) {
          cur.rows[cur.rows.length - 1].taxon += ` ${only[0].t}`;
          return;
        }
        gap++;
        if (gap > 3) flush();
      }
    });
    flush();
  }
  return tables.map(resolveColumns).filter(Boolean).map((t) => {
    // rank tables by how many rows are known taxa (the lab's lookup) or clean Latin names
    const strong = t.rows.filter((r) => strongTaxon(r.taxon)).length;
    t.score = strong * 2 + (t.rows.length - strong);
    return t;
  }).filter((t) => t.rows.filter((r) => strongTaxon(r.taxon)).length >= 2 || t.rows.length >= 3);
}

// Column centres from the values; names from the header line(s) above the first row.
function resolveColumns(tab) {
  const centers = tab.rows.flatMap((r) => r.vals.map((v) => v.c)).sort((a, b) => a - b);
  if (!centers.length) return null;
  const minC = centers[0] - 14, maxC = centers[centers.length - 1] + 20;
  const above = tab.lines.slice(Math.max(0, tab.startLine - 8), tab.startLine);
  const inRange = (ln) => ln.toks.filter((t) => (t.x0 + t.x1) / 2 >= minC && (t.x0 + t.x1) / 2 <= maxC && !/^table\b/i.test(t.t));
  // primary header = the line above the table with the most tokens over the value columns
  let primary = null;
  for (const ln of above) { const ts = inRange(ln); if (ts.length && (!primary || ts.length >= primary.ts.length)) primary = { ln, ts }; }
  let cols;
  if (primary && primary.ts.length >= 1) {
    cols = primary.ts.map((t) => ({ name: t.t, c: (t.x0 + t.x1) / 2 }));
    // continuation lines directly beneath ("Horizon" / "unknown")
    for (const ln of above) {
      if (ln === primary.ln || ln.y > primary.ln.y || primary.ln.y - ln.y > 13) continue;
      for (const t of inRange(ln)) {
        const c = (t.x0 + t.x1) / 2;
        const col = cols.reduce((b, x) => (Math.abs(x.c - c) < Math.abs(b.c - c) ? x : b));
        if (Math.abs(col.c - c) < 9) col.name += ` ${t.t}`;
      }
    }
  } else {
    // no header: cluster value positions
    cols = [];
    for (const c of centers) { const last = cols[cols.length - 1]; if (last && c - last.c < 8) continue; cols.push({ name: '', c }); }
    if (cols.length === 1) cols[0].name = 'Assemblage';
  }
  const rows = tab.rows.map((r) => {
    const values = cols.map(() => null);
    for (const v of r.vals) {
      const j = cols.reduce((b, x, i) => (Math.abs(x.c - v.c) < Math.abs(cols[b].c - v.c) ? i : b), 0);
      if (Math.abs(cols[j].c - v.c) > 16) continue;
      const n = MARK.test(v.v) ? 1 : Number(v.v);
      values[j] = (values[j] || 0) + n;
    }
    return { taxon: r.taxon, values, marks: r.vals.some((v) => MARK.test(v.v)) };
  });
  return { page: tab.page, columns: cols.map((c) => c.name.trim()), rows };
}

// Single-specimen papers name their taxa in the title ("Stegomastodon associated with
// Mammuthus in Arizona"): those become presence records in one "Assemblage".
export function titleTaxa(title) {
  const out = [];
  const epithet = /^[a-z]{4,}(?:us|a|um|is|i|ae|ensis|oides|ii|ianus|ica|icus|eri|alis|ior|ens|on|ops|ix)$/;
  const english = /^(associated|from|with|during|and|the|in|of|at|on|for|near|record|records|fauna|remains|evidence|during)$/;
  for (const m of String(title || '').matchAll(/\b([A-Z][a-z]{3,})(?:\s+(?:cf\.\s+)?([a-z]{4,}))?/g)) {
    const species = m[2] && epithet.test(m[2]) && !english.test(m[2]) ? `${m[1]} ${m[2]}` : null;
    const exact = (n) => findTaxon(n, null, { fuzzy: false });
    const hit = (species && exact(species)) || exact(m[1]);
    const latinGenus = /^[A-Z][a-z]+(?:us|a|um|is|on|ia|ops|ix|ys|odon|therium|odus|ia|ium|ax)$/.test(m[1]);
    if (hit) out.push(species && exact(species) ? exact(species)[0] : (species || hit[0]));
    else if (species && latinGenus) out.push(species);
  }
  return [...new Set(out)];
}

// Best faunal table → Tilia dataset (samples = analysis units, one row per taxon).
const key = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');

export function tableToDataset(tab, source, { site = '' } = {}) {
  let cols = tab.columns.map((n, i) => ({ n, i }));
  // columns that are sites ("Cement Creek Cave | Haystack Cave | Signature Cave"): keep the chosen one
  const siteCol = site ? cols.find((c) => key(c.n) && (key(c.n) === key(site) || key(c.n).includes(key(site)) || key(site).includes(key(c.n)))) : null;
  if (siteCol && cols.length > 1) cols = [{ n: 'Assemblage', i: siteCol.i }];
  const totalCol = cols.find((c) => /^(total|totals|sum|nisp total|total nisp)\b/i.test(c.n));
  const timeBins = cols.some((c) => /^(MIS|OIS)\b|\bka\b|^\d+[a-e]$/i.test(c.n)) || /^MIS\b/i.test(cols[0]?.n || '');
  let units;
  if (totalCol && (timeBins || cols.length === 1)) units = [{ name: 'Assemblage', idx: [totalCol.i] }];
  else {
    cols = cols.filter((c) => c !== totalCol && !/^(%|percent|mni)$/i.test(c.n));
    units = cols.map((c) => ({ name: c.n || 'Assemblage', idx: [c.i] }));
  }
  const presence = tab.rows.every((r) => r.values.every((v) => v == null || v === 1)) && tab.rows.some((r) => r.marks || units.length === 1);
  const variables = tab.rows.map((r) => ({
    name: r.taxon, rawLabel: r.taxon, element: 'bone', unitHint: presence ? 'presence/absence' : 'NISP',
    units: presence ? 'presence/absence' : 'NISP', _autoUnits: true, _unitGuess: presence ? 'presence/absence' : 'NISP',
    values: units.map((u) => u.idx.reduce((a, i) => (r.values[i] == null ? a : (a || 0) + r.values[i]), null)),
    include: true, excludeReason: '', presence,
  })).filter((v) => v.values.some((x) => x != null));
  return {
    source, sheet: `Table on p.${tab.page}${siteCol ? ` (${siteCol.n} column)` : ''}`, layout: 'table-from-text', roles: {},
    samples: units.map((u) => ({ name: u.name, depth: null, thickness: null, age: null, analyst: '' })),
    variables,
  };
}
