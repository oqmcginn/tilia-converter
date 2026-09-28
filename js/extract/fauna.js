// Specimen data from the systematic-paleontology sections of vertebrate papers:
//
//   Equus sp.
//   Material and provenience
//   TxVP 44302-21, metatarsal III, right; TxVP 44302-105, P3 or P4, right; …
//   Zone 7–8 (TxVP 44302-128), Zone 15 (surface: TxVP 44302-18; blue-green clay: …).
//
// Each specimen becomes one occurrence (taxon, element, analysis unit). Elements are
// rewritten in Neotoma's vocabulary following hand conversions ("P4" → "tooth, fourth
// premolar", "metatarsal III" → "metatarsal, third"). Specimens without provenience go
// to an "Assemblage" unit, as expert conversions do.

const SECTION = /\n\s*(Material and provenience|Referred material and provenience|Referred material|Referred specimens?|Material examined|Material)\s*\n/g;
const END = /\n\s*(Diagnosis and description|Description and discussion|Diagnosis|Description|Remarks|Discussion|Comments)\s*\n/;
const CATALOG = /\b([A-Z][A-Za-z]{1,7})\s*(\d{3,6})\s*[-–−]?\s*(\d{1,5})\b/g;
const catKey = (prefix, a, b) => `${prefix}|${a}${b}`.toLowerCase();

const ORD = { 1: 'first', 2: 'second', 3: 'third', 4: 'fourth' };
const ROMAN = { I: 'first', II: 'second', III: 'third', IV: 'fourth', V: 'fifth' };

// Anatomical shorthand → Neotoma element terms
export function normalizeElement(raw) {
  let e = String(raw || '').replace(/\(Fig[^)]*\)/gi, '').replace(/\s+/g, ' ').trim();
  e = e.replace(/,?\s*\b(left|right|unworn|worn|complete|partial)\b/gi, '').replace(/\s+,/g, ',').replace(/[,\s]+$/, '').trim();
  const low = e.toLowerCase();
  // teeth: "P4", "dp3", "M1 or M2", "DP3 or DP4" (a letter + digit; bone names never start that way)
  const m = e.match(/^(d)?([PMIC])(\d)\b(?:\s*or\s*d?[PMIC]?(\d))?/i);
  if (m) {
    const kind = { p: 'premolar', m: 'molar', i: 'incisor', c: 'canine' }[m[2].toLowerCase()];
    if (m[4]) return `tooth, ${kind}`; // "P3 or P4": position unknown
    return `tooth, ${ORD[m[3]] || ''} ${m[1] ? 'deciduous ' : ''}${kind}`.replace(/\s+/g, ' ');
  }
  if (/deciduous premolar/.test(low)) return 'tooth, deciduous premolar';
  if (/caniniform|caniform/.test(low)) return 'tooth, caniform';
  if (/cheek tooth|tooth fragment|^tooth\b/.test(low)) return 'tooth';
  if (/^molar\b|molar fragment/.test(low)) return 'tooth, molar';
  if (/^premolar\b/.test(low)) return 'tooth, premolar';
  if (/^incisor/.test(low)) return 'tooth, incisor';
  if (/ungual/.test(low)) return 'phalanx';
  if (/phalanx/.test(low)) return /\bpes\b|foot|pedal/.test(low) ? 'phalanx, foot' : /manus|hand|manual/.test(low) ? 'phalanx, hand' : 'phalanx';
  const meta = low.match(/^(metacarpal|metatarsal)\s*([IV]+)?(\s*[–-]\s*[IV]+)?/i);
  if (meta) return meta[2] && !meta[3] ? `${meta[1]}, ${ROMAN[meta[2].toUpperCase()]}` : meta[1];
  if (/^(atlas|axis)\b/.test(low)) return `vertebra, ${low.match(/^(atlas|axis)/)[1]}`;
  if (/vertebra/.test(low)) return 'vertebra';
  if (/osteoderm|scute/.test(low)) return 'skin';
  if (/shell \(carapace or plastron\)|^shell\b/.test(low)) return 'bone/shell';
  if (/^carapace/.test(low)) return 'carapace';
  if (/^plastron/.test(low)) return 'plastron';
  if (/^(maxilla|dentary|mandible|premaxilla)\b/.test(low)) return low.match(/^(\w+)/)[1];
  if (/parietal/.test(low)) return 'parietal';
  // "tibia diaphysis", "humerus, distal end" → the bone name
  const bone = low.match(/^(tibia|fibula|femur|humerus|radius|ulna|scapula|pelvis|innominate|calcaneum|calcaneus|astragalus|patella|rib|skull|cranium|horn core|antler|sacrum)/);
  if (bone) return bone[1];
  return e.replace(/\s*fragment$/i, '').trim();
}

// "Hesperotestudo sp. (giant form)" → "Hesperotestudo sp. (giant form)" (lookup handles sp./indet.);
// strips the authority from headings like "Megalonyx jeffersonii Desmarest, 1822".
function taxonFromHeading(line) {
  return line.replace(/\s+(?:\(?[A-Z][\w'’.-]*(?:,?\s+(?:and|&|et al\.|[A-Z][\w'’.-]*))*,?\s+\d{4}[a-z]?\)?)$/, '').trim();
}

function unitName(zone, sub) {
  const z = `Zone ${zone.replace(/\s*[–−-]\s*/, '-')}`;
  if (!sub) return z;
  const s = sub.toLowerCase().replace(/blue\s*-?\s*green|blue(?= clay)/, 'blue-green').replace(/\s+/g, ' ').trim();
  return `${z} (${s})`;
}

// Catalog numbers in a text span, expanding ranges ("TxVP 44302-114 through TxVP 44302-120").
function catalogsIn(part) {
  const keys = [];
  const cats = [...part.matchAll(CATALOG)];
  cats.forEach((c, i) => {
    keys.push({ key: catKey(c[1], c[2], c[3]), num: c[3] });
    const next = cats[i + 1];
    if (next && /^\s*(?:through|to|[–-])\s*$/i.test(part.slice(c.index + c[0].length, next.index)) && next[1] === c[1] && next[2] === c[2]) {
      for (let n = Number(c[3]) + 1; n < Number(next[3]) && n - Number(c[3]) < 200; n++) keys.push({ key: catKey(c[1], c[2], String(n)), num: String(n) });
    }
  });
  return keys;
}

// Zone statements: "Zone 12.", "Zone 15 (blue-green clay).", "Zones 11 (TxVP 44302-31) and 12 (TxVP 44302-39)",
// "Zone 13–14 (TxVP 44302-147), Zone 15 (surface: TxVP 44302-18; blue-green clay: TxVP 44302-145)".
// Returns catalog → unit, plus the unit for specimens not named individually.
function parseZones(text) {
  const assign = new Map();
  const conflicts = [];
  const nums = new Map(); // catalog key → specimen number after the hyphen
  let all = null;
  const first = text.search(/\bZones?\s+\d/);
  if (first < 0) return { assign, all, conflicts, nums };
  const zoneRe = /(?:\bZones?\s+|,\s*(?=\d)|\band\s+(?=\d))(\d{1,3}(?:\s*[–−-]\s*\d{1,3})?)\s*(?:\(([^()]*)\))?/g;
  for (const m of text.slice(first).matchAll(zoneRe)) {
    const [, zone, inner] = m;
    if (!inner) { all ||= unitName(zone); continue; }
    let named = false;
    for (const part of inner.split(';')) {
      const label = (part.match(/^\s*([a-z][a-z -]{2,30}):/i) || [])[1];
      for (const { key: k, num } of catalogsIn(part)) {
        if (assign.has(k) && assign.get(k) !== unitName(zone, label)) conflicts.push(k);
        assign.set(k, unitName(zone, label)); nums.set(k, num); named = true;
      }
    }
    if (!named) all ||= unitName(zone, inner);
  }
  return { assign, all, conflicts, nums };
}

export function parseMaterialSections(text) {
  // drop publisher footers and running heads that interrupt paragraphs across pages
  const t = String(text).split('\n').filter((l) => !/https?:\/\/|Downloaded from|terms of use|Cambridge Core/i.test(l)).join('\n');
  const occ = [];
  const sections = [...t.matchAll(SECTION)];
  sections.forEach((s, k) => {
    const headLines = t.slice(Math.max(0, s.index - 300), s.index).split('\n').map((l) => l.trim()).filter(Boolean);
    const taxon = taxonFromHeading(headLines[headLines.length - 1] || '');
    const start = s.index + s[0].length;
    const stop = Math.min(k + 1 < sections.length ? sections[k + 1].index : t.length, start + 4000);
    let body = t.slice(start, stop);
    const end = body.search(END);
    if (end > 0) body = body.slice(0, end);
    body = body.replace(/\s+/g, ' ');
    // specimen list = up to the first sentence starting with "Zone(s)"
    const zi = body.search(/(?:^|[.)]\s+)Zones?\s+\d/);
    const listPart = zi >= 0 ? body.slice(0, zi) : body.split(/\.\s/)[0];
    const zonePart = zi >= 0 ? body.slice(zi) : '';
    const specimens = [];
    for (const piece of listPart.split(';')) {
      const c = [...piece.matchAll(CATALOG)][0];
      if (!c) continue;
      const after = piece.slice(c.index + c[0].length).replace(/^\s*,\s*/, '');
      specimens.push({ catalog: `${c[1]} ${c[2]}-${c[3]}`, key: catKey(c[1], c[2], c[3]), num: c[3], elementRaw: after.replace(/\.$/, '').trim() });
    }
    if (!taxon || !specimens.length) return;
    const { assign, all, conflicts, nums } = parseZones(zonePart);
    const bySuffix = (sp) => {
      // tolerate a mistyped collection number ("TxVP 43407-71" listed, "44302-71" in the zone text)
      const hits = [...assign.keys()].filter((x) => nums.get(x) === sp.num && !specimens.some((s2) => s2.key === x));
      return hits.length === 1 ? assign.get(hits[0]) : null;
    };
    for (const sp of specimens) {
      const unit = assign.get(sp.key) || bySuffix(sp) || all || 'Assemblage';
      const note = conflicts.includes(sp.key) ? 'paper lists this specimen in more than one zone' : '';
      occ.push({ taxon, catalog: sp.catalog, elementRaw: sp.elementRaw, element: normalizeElement(sp.elementRaw), unit, count: 1, note });
    }
  });
  return occ;
}

// Units ordered as stratigraphic zones are listed: highest zone first, "surface" before
// other sub-units, "Assemblage" last.
function unitOrder(u) {
  if (/^assemblage/i.test(u)) return [-1e9, 0];
  const m = u.match(/Zone (\d+)(?:-(\d+))?/);
  const mid = m ? (Number(m[1]) + Number(m[2] || m[1])) / 2 : -1e6;
  return [mid, /surface/i.test(u) ? 0 : /\(/.test(u) ? 1 : 0];
}

// Occurrences → a Tilia data table: one column per unit, one row per taxon × element.
export function occurrencesToDataset(occ, source) {
  if (!occ.length) return null;
  const units = [...new Set(occ.map((o) => o.unit))].sort((a, b) => {
    const [x1, y1] = unitOrder(a), [x2, y2] = unitOrder(b);
    return x2 - x1 || y1 - y2;
  });
  const rows = new Map();
  for (const o of occ) {
    const key = `${o.taxon}|${o.element}`;
    if (!rows.has(key)) rows.set(key, { name: o.taxon, rawLabel: o.taxon, element: o.element, unitHint: 'NISP', values: units.map(() => null), include: true, excludeReason: '', presence: false, specimens: [] });
    const r = rows.get(key);
    const j = units.indexOf(o.unit);
    r.values[j] = (r.values[j] || 0) + (o.count || 1);
    r.specimens.push(o.catalog);
  }
  const variables = [...rows.values()].map((v) => ({ ...v, _unitGuess: 'NISP', units: 'NISP', _autoUnits: true, _autoElement: false }));
  return {
    source, sheet: 'Specimens in paper', layout: 'specimens-from-text', roles: {},
    samples: units.map((u) => ({ name: u, depth: null, thickness: null, age: null, analyst: '' })),
    variables,
  };
}
