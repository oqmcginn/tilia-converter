// Spreadsheet analysis: takes sheets as 2-D arrays and figures out what each one holds.
//   • data sheets    → samples (depth/age/thickness/name) × variables (taxa, measurements)
//   • metadata sheets → key/value pairs mapped onto Tilia fields
//   • date sheets    → geochronology rows
// Handles both "samples as rows" (typical Excel export) and "variables as rows" (Tilia layout).

import { findCoordinates } from './text.js';

const RE = {
  depth: /^(mid(dle|point)?[\s_-]*)?depth\b|depth[\s_]*\(?(cm|m|mm)\)?$|^depth[\s_]*(cm|m|mm)$|^cm$|composite depth|^mcd\b|^depth/i,
  top: /\b(top|upper|from|start)\b.*depth|depth.*\b(top|upper|from|start)\b|^top\b|^cm[\s_]*top\b/i,
  bottom: /\b(bottom|base|lower|to|end)\b.*depth|depth.*\b(bottom|base|lower|end)\b|^(bottom|base)\b/i,
  thick: /thick/i,
  age: /\bage\b|cal\.?\s*(yr|a|ka|bp)|yr\.?\s*b\.?p|\bb\.?p\.?\b|years? before|\bkyr\b|\bka\b|\bchron/i,
  sample: /^(sample|sample[\s_]*(id|name|no\.?|number|code|#)|lab[\s_]*(id|code|no)|id|name|level|stratum|layer|unit|analysis[\s_]*unit|horizon|spit)$/i,
  analyst: /analyst|counted by|identified by/i,
  // columns that are derived, not raw observations
  derived: /\b(total|sum|zone|concentration|influx|accumulation|par\b|pollen sum|ratio|index|dca|pca|axis)\b/i,
  varHeader: /^(taxon|taxa|name|species|variable|code|element|units?|context|taphonomy|group|ecological group|type)$/i,
};

const META_KEYS = [
  ['site.SiteName', /^(site|site[\s_]*name|lake|lake[\s_]*name|locality|location[\s_]*name|sitename)$/i],
  ['site.LatNorth', /^lat(itude)?\b|^lat[\s_]*(dd|deg|decimal)/i],
  ['site.LongEast', /^lon(g|gitude)?\b|^long[\s_]*(dd|deg|decimal)/i],
  ['site.Altitude', /^(elev(ation)?|altitude|alt)\b/i],
  ['site.Country', /^country$/i],
  ['site.State', /^(state|province|state\/province|region)$/i],
  ['site.County', /^(county|district)$/i],
  ['site.SiteDescription', /^(site[\s_]*)?description$/i],
  ['site.Notes', /^(site[\s_]*)?notes?$/i],
  ['collectionUnit.Handle', /^handle$/i],
  ['collectionUnit.CollectionName', /^(core|core[\s_]*(name|id|code)|collection[\s_]*(name|unit))$/i],
  ['collectionUnit.CollectionType', /^collection[\s_]*type$/i],
  ['collectionUnit.CollectionDevice', /device|^corer$|coring[\s_]*(method|device|equipment)/i],
  ['collectionUnit.CollectionDate', /(collection|coring|sampling|field)[\s_]*date|date[\s_]*(collected|cored|sampled)/i],
  ['collectionUnit.WaterDepth', /water[\s_]*depth/i],
  ['collectionUnit.DepositionalEnvironment', /depositional|dep[\s_.]*env/i],
  ['collectionUnit.Location', /^location$/i],
  ['dataset.DatasetType', /^(dataset[\s_]*type|proxy|data[\s_]*type)$/i],
  ['dataset.ChronologyName', /^chronology[\s_]*name$/i],
  ['dataset.AgeModel', /^age[\s_]*model$/i],
  ['publication.DOI', /^doi$/i],
  ['publication.Citation', /^(citation|reference|publication)$/i],
  ['contacts.Investigator', /investigator|^pi$|principal/i],
  ['contacts.Analyst', /analyst|counted by|identified by/i],
  ['contacts.Collector', /collector|collected by|cored by/i],
  ['contacts.Author', /^authors?$/i],
  ['contacts.Email', /e-?mail/i],
];

const DATE_COLS = {
  labNumber: /lab|sample[\s_]*(id|code|no)|^id$/i,
  age: /(14c|c-?14|radiocarbon|conventional|uncal|measured|\bage\b)/i,
  error: /±|error|\bsd\b|sigma|1σ|\+\/-|uncert/i,
  depth: /depth/i,
  thickness: /thick/i,
  material: /material|dated|sample type/i,
  method: /method|type of date/i,
};

// ---------- cell helpers ----------
// "Total Charcoal" is the raw count Tilia wants; "CHAR" (charcoal accumulation rate) and
// concentrations are derived. Other totals/sums are derived as before.
const isDerived = (label) => (RE.derived.test(label) && !/^total\s+(charcoal|char|macrocharcoal|particles?)\b/i.test(label)) || /\bCHAR\b/.test(label);

const isBlank = (v) => v == null || (typeof v === 'string' && /^\s*$/.test(v));

export function toNumber(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v !== 'string') return null;
  let s = v.trim().replace(/−/g, '-');
  if (!s) return null;
  if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(s)) s = s.replace(/,/g, '');
  else if (/^-?\d+,\d+$/.test(s)) s = s.replace(',', '.'); // European decimal comma
  if (/^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(s)) return parseFloat(s);
  return null;
}

// "x", "+", "P", "present" → 1 (presence marker); "-", "nd", "n/a" → empty
function cellValue(v) {
  const n = toNumber(v);
  if (n != null) return { value: n };
  if (isBlank(v) || /^(-|–|—|nd|n\/?a|na|\.)$/i.test(String(v).trim())) return { value: null };
  if (/^(x|\+|p|present|pres\.?|yes|y)$/i.test(String(v).trim())) return { value: 1, presence: true };
  return { value: null, text: String(v).trim() };
}

const labelOf = (v) => (isBlank(v) ? '' : String(v).replace(/\s+/g, ' ').trim());

// Strip trailing units from a column label: "Pinus (%)" → {name:"Pinus", unit:"%"}
export function splitLabel(label) {
  const m = label.match(/^(.*?)[\s_]*[([]([^()[\]]{1,20})[)\]]\s*$/);
  if (m && m[1]) return { name: m[1].trim(), unit: m[2].trim() };
  const m2 = label.match(/^(.*?)[\s_]+(%|pct|percent|cm|mm|m|ppm|ppb|g|mg)$/i);
  if (m2 && m2[1]) return { name: m2[1].trim(), unit: m2[2] };
  return { name: label.replace(/_/g, ' ').trim(), unit: '' };
}

export function normalizeUnit(unit, values) {
  const u = (unit || '').toLowerCase();
  if (u === '%' || u === 'pct' || u === 'percent') return 'percent';
  if (/^(n|count|counts|nisp|#|no\.?|grains?)$/.test(u)) return 'NISP';
  if (/mni/.test(u)) return 'MNI';
  if (u) return unit;
  const nums = values.filter((v) => v != null);
  if (nums.length && nums.every((v) => v === 0 || v === 1)) return 'present/absent';
  return '';
}

function trimTable(rows) {
  const r = rows.map((row) => (Array.isArray(row) ? row : []));
  while (r.length && r[r.length - 1].every(isBlank)) r.pop();
  let width = 0;
  for (const row of r) {
    for (let i = row.length - 1; i >= 0; i--) if (!isBlank(row[i])) { width = Math.max(width, i + 1); break; }
  }
  return r.map((row) => Array.from({ length: width }, (_, i) => row[i]));
}

const numericShare = (cells) => {
  const filled = cells.filter((c) => !isBlank(c));
  if (!filled.length) return 0;
  return filled.filter((c) => cellValue(c).value != null).length / filled.length;
};

// ---------- sheet classification ----------
function findHeaderRow(rows) {
  let best = { idx: 0, score: -1 };
  for (let i = 0; i < Math.min(rows.length - 1, 25); i++) {
    const row = rows[i];
    const filled = row.filter((c) => !isBlank(c));
    if (filled.length < 3) continue;
    const textShare = filled.filter((c) => toNumber(c) == null).length / filled.length;
    const below = rows.slice(i + 1, i + 8).flat();
    const score = filled.length * (0.5 + textShare) * (0.3 + numericShare(below));
    if (score > best.score) best = { idx: i, score };
  }
  return best.idx;
}

function metadataPairs(rows) {
  const pairs = [];
  for (const row of rows) {
    const key = labelOf(row[0]).replace(/[:=]\s*$/, '');
    const val = row.slice(1).find((c) => !isBlank(c));
    if (!key || isBlank(val)) continue;
    const hit = META_KEYS.find(([, re]) => re.test(key));
    if (hit) pairs.push({ path: hit[0], key, value: typeof val === 'string' ? val.trim() : val });
  }
  return pairs;
}

export function parseCoordValue(v, isLon) {
  const n = toNumber(v);
  if (n != null) return n;
  const s = String(v).trim();
  const m = s.match(/(-?\d{1,3}(?:\.\d+)?)\s*[°º˚\s]\s*(?:(\d{1,2}(?:\.\d+)?)\s*['’′\s]\s*(?:(\d{1,2}(?:\.\d+)?)\s*["”″]?)?)?\s*([NSEW])?/i);
  if (!m) {
    const pair = findCoordinates(s)[0];
    return pair ? (isLon ? pair.lon : pair.lat) : null;
  }
  let d = Math.abs(parseFloat(m[1])) + (parseFloat(m[2] || 0) / 60) + (parseFloat(m[3] || 0) / 3600);
  if (m[1].startsWith('-') || /[SW]/i.test(m[4] || '')) d = -d;
  return Math.round(d * 1e6) / 1e6;
}

function looksLikeMetadataSheet(rows) {
  if (!rows.length) return false;
  const width = Math.max(...rows.map((r) => r.filter((c) => !isBlank(c)).length));
  const pairs = metadataPairs(rows);
  return pairs.length >= 2 && (width <= 4 || pairs.length / rows.length > 0.4);
}

function looksLikeDateSheet(header) {
  const labels = header.map(labelOf);
  return labels.some((l) => /\blab\b|lab[\s_]*(id|code|no|number)/i.test(l)) &&
         labels.some((l) => /14c|radiocarbon|\bage\b/i.test(l));
}

// ---------- date sheet ----------
function parseDateSheet(rows, sheetName) {
  const h = findHeaderRow(rows);
  const header = rows[h].map(labelOf);
  const col = {};
  for (const [key, re] of Object.entries(DATE_COLS)) {
    const idx = header.findIndex((l, i) => re.test(l) && !Object.values(col).includes(i) && !(key === 'age' && /cal|error|±/i.test(l) && header.some((x) => /14c|uncal|conventional/i.test(x))));
    if (idx >= 0) col[key] = idx;
  }
  const out = [];
  for (const row of rows.slice(h + 1)) {
    // ages are often written "2780 ± 35" in one cell
    const pm = col.age != null && typeof row[col.age] === 'string' ? row[col.age].match(/^\s*([\d,. ]+?)\s*(?:±|\+\/-|\+-)\s*([\d.]+)/) : null;
    const age = pm ? toNumber(pm[1].replace(/[ ,]/g, '')) : (col.age != null ? toNumber(row[col.age]) : null);
    if (age == null) continue;
    let depth = col.depth != null ? row[col.depth] : null;
    let thickness = col.thickness != null ? toNumber(row[col.thickness]) : null;
    if (typeof depth === 'string' && /[-–]/.test(depth)) {
      const [a, b] = depth.split(/[-–]/).map(toNumber);
      if (a != null && b != null) { depth = (a + b) / 2; thickness = thickness ?? Math.abs(b - a); }
    }
    out.push({
      labNumber: col.labNumber != null ? labelOf(row[col.labNumber]) : '',
      age, error: pm ? toNumber(pm[2]) : (col.error != null ? toNumber(row[col.error]) : null),
      depth: toNumber(depth), thickness,
      material: col.material != null ? labelOf(row[col.material]) : '',
      method: col.method != null && labelOf(row[col.method]) ? labelOf(row[col.method]) : 'Carbon-14',
      source: `${sheetName} (sheet)`,
    });
  }
  return out;
}

// ---------- data sheet: samples as rows ----------
function parseSamplesAsRows(rows, h, sheetName, notes) {
  const header = rows[h].map(labelOf);
  const body = rows.slice(h + 1).filter((r) => r.some((c) => !isBlank(c)));
  const roles = {};
  // a composite/total depth beats per-drive depths ("Drive Top Depth" … "Total Depth")
  const composite = header.findIndex((l) => /\b(total|composite|cumulative|splice[d]?|corrected)\s+depth\b|^mcd\b/i.test(l));
  if (composite >= 0) roles.depth = composite;
  const siteCol = header.findIndex((l) => /^(site|site\s*name|lake|lake\s*name|location|locality)$/i.test(l));
  header.forEach((l, i) => {
    if (!l || i === composite) return;
    if (composite >= 0 && /depth/i.test(l)) return;
    if (roles.top == null && RE.top.test(l)) roles.top = i;
    else if (roles.bottom == null && RE.bottom.test(l)) roles.bottom = i;
    else if (roles.thick == null && RE.thick.test(l)) roles.thick = i;
    else if (roles.depth == null && RE.depth.test(l)) roles.depth = i;
    else if (RE.age.test(l) && !/error|±|sd|sigma|min|max|range|stop|start|end/i.test(l)) (roles._ages ||= []).push(i);
    else if (roles.sample == null && RE.sample.test(l)) roles.sample = i;
    else if (roles.analyst == null && RE.analyst.test(l)) roles.analyst = i;
  });
  // "OM Depth", "Abs Depth (CM)", "LOI Depth": any depth column when no standard one was found
  if (roles.depth == null && roles.top == null) {
    const d = header.findIndex((l) => /\bdepth\b/i.test(l) && !/water|range|stop|end|bottom/i.test(l));
    if (d >= 0) roles.depth = d;
  }
  // several age columns ("Age (Pb210)" in CE, "Age (smoother)" in BP): prefer one in years BP
  if (roles._ages?.length) {
    const ceLike = (i) => { const v = body.map((r) => toNumber(r[i])).filter((x) => x != null); return v.length > 2 && v.every((x) => x > 1000 && x < 2100); };
    roles.age = roles._ages.find((i) => /\bBP\b|cal/i.test(header[i]) && !ceLike(i)) ?? roles._ages.find((i) => !ceLike(i)) ?? roles._ages[0];
    roles._otherAges = roles._ages.filter((i) => i !== roles.age);
  }
  const otherAges = roles._otherAges || [];
  delete roles._ages;
  delete roles._otherAges;
  const depthScale = (i) => {
    if (i == null) return 1;
    const u = splitLabel(header[i]).unit.toLowerCase() || (header[i].match(/\b(mm|m|cm)\b/i) || [])[1]?.toLowerCase();
    if (u === 'm') { notes.push(`${sheetName}: “${header[i]}” is in metres — converted to cm.`); return 100; }
    if (u === 'mm') { notes.push(`${sheetName}: “${header[i]}” is in mm — converted to cm.`); return 0.1; }
    return 1;
  };
  const ageScale = roles.age != null && /\bka\b|kyr|kcal/i.test(header[roles.age]) ? 1000 : 1;
  if (ageScale === 1000) notes.push(`${sheetName}: ages in “${header[roles.age]}” look like ka — multiplied by 1000.`);
  // calendar years (CE/AD) → years BP (1950 − year), as hand-made files store them
  let ageCE = false;
  if (roles.age != null && ageScale === 1) {
    const lab = header[roles.age];
    const vals = body.map((r) => toNumber(r[roles.age])).filter((v) => v != null);
    const looksCE = vals.length > 2 && vals.every((v) => v > 1000 && v < 2100) && vals[0] > vals[vals.length - 1];
    if (/\b(CE|AD|A\.D\.|BCE|calendar years? (?:AD|CE))\b/.test(lab) || (!/BP|before present/i.test(lab) && looksCE)) {
      ageCE = true;
      notes.push(`${sheetName}: ages in “${lab}” are calendar years (CE) — converted to years BP (1950 − year).`);
    }
  }

  const metaCols = new Set([...Object.values(roles), ...otherAges]);
  // bookkeeping columns are not measurements: core/drive labels, other depth scales, the site column
  header.forEach((l, i) => { if (i === siteCol || /^(core|drive|section|lake|site|site\s*name|hole|segment)$/i.test(l) || (composite >= 0 && i !== composite && /depth/i.test(l))) metaCols.add(i); });
  const samples = body.map((row, r) => {
    const s = { name: '', depth: null, thickness: null, age: null, analyst: '' };
    if (siteCol >= 0) s.site = labelOf(row[siteCol]);
    const dS = depthScale(roles.depth ?? roles.top);
    if (roles.top != null && roles.bottom != null) {
      const a = toNumber(row[roles.top]), b = toNumber(row[roles.bottom]);
      if (a != null && b != null) { s.depth = ((a + b) / 2) * dS; s.thickness = Math.abs(b - a) * dS; }
    }
    if (s.depth == null && roles.depth != null) s.depth = toNumber(row[roles.depth]) != null ? toNumber(row[roles.depth]) * dS : null;
    if (s.depth == null && roles.top != null) s.depth = toNumber(row[roles.top]) != null ? toNumber(row[roles.top]) * dS : null;
    if (roles.thick != null && toNumber(row[roles.thick]) != null) s.thickness = toNumber(row[roles.thick]) * depthScale(roles.thick);
    if (roles.age != null && toNumber(row[roles.age]) != null) s.age = ageCE ? Math.round((1950 - toNumber(row[roles.age])) * 10) / 10 : toNumber(row[roles.age]) * ageScale;
    if (roles.sample != null) s.name = labelOf(row[roles.sample]);
    if (roles.analyst != null) s.analyst = labelOf(row[roles.analyst]);
    if (s.depth == null && !s.name) s.name = String(r + 1);
    if (s.depth != null) s.depth = Math.round(s.depth * 1e4) / 1e4;
    if (s.thickness != null) s.thickness = Math.round(s.thickness * 1e4) / 1e4;
    return s;
  });

  // sub-headings in the row above ("Big 250 … Small 125") apply from their column rightwards
  const above = h > 0 ? rows[h - 1].map(labelOf) : [];
  // a group runs from its sub-heading to its "Total …" column; the label is the group's cells joined ("Big 250")
  const subheadAt = (i) => {
    for (let k = i; k >= 0; k--) {
      if (k < i && /^total\b/i.test(header[k] || '')) return '';
      if (above[k]) {
        let a = k; while (a > 0 && above[a - 1]) a--;
        let b = k; while (b + 1 < above.length && above[b + 1]) b++;
        return above.slice(a, b + 1).join(' ');
      }
    }
    return '';
  };
  const variables = [];
  header.forEach((label, i) => {
    if (metaCols.has(i) || !label) return;
    const col = body.map((row) => row[i]);
    if (numericShare(col) < 0.6) {
      if (col.some((c) => !isBlank(c))) notes.push(`${sheetName}: skipped text column “${label}”.`);
      return;
    }
    const cells = col.map(cellValue);
    const values = cells.map((c) => c.value);
    const { name, unit } = splitLabel(label);
    variables.push({
      name, rawLabel: label, unitHint: unit, values, subhead: above.length ? subheadAt(i) : '',
      presence: cells.some((c) => c.presence),
      include: !isDerived(label),
      excludeReason: isDerived(label) ? 'looks like a derived value (total, sum, concentration, accumulation rate)' : '',
    });
  });
  if (roles.depth == null && roles.top == null && roles.sample == null) {
    notes.push(`${sheetName}: no depth or sample-name column recognised — samples are numbered in row order.`);
  }
  return { samples, variables, layout: 'samples-as-rows', roles: Object.fromEntries(Object.entries(roles).map(([k, i]) => [k, header[i]])) };
}

// ---------- data sheet: variables as rows (Tilia layout) ----------
function parseVariablesAsRows(rows, h, sheetName, notes) {
  const header = rows[h].map(labelOf);
  const body = rows.slice(h + 1).filter((r) => r.some((c) => !isBlank(c)));
  // leading descriptor columns: header names a descriptor, or body cells are text
  const descCols = [];
  for (let i = 0; i < Math.min(header.length, 8); i++) {
    const textish = numericShare(body.map((r) => r[i])) < 0.5;
    if (RE.varHeader.test(header[i]) || (textish && i === descCols.length)) descCols.push(i);
    else break;
  }
  if (!descCols.length) descCols.push(0);
  const role = (re) => descCols.find((i) => re.test(header[i]));
  const nameCol = role(/^(taxon|taxa|name|species|variable)$/i) ?? descCols[descCols.length > 1 && role(/^code$/i) === descCols[0] ? 1 : 0];
  const codeCol = role(/^code$/i);
  const elementCol = role(/^element$/i);
  const unitsCol = role(/^units?$/i);
  const contextCol = role(/^context$/i);
  const taphCol = role(/^taphonomy$/i);
  const groupCol = role(/^(group|ecological group)$/i);
  const sampleCols = header.map((_, i) => i).filter((i) => !descCols.includes(i));

  const samples = sampleCols.map((i) => {
    const hv = header[i];
    const n = toNumber(hv);
    return { name: n == null ? hv : '', depth: n, thickness: null, age: null, analyst: '' };
  });

  const variables = [];
  for (const row of body) {
    const label = labelOf(row[nameCol]);
    const code = codeCol != null ? labelOf(row[codeCol]) : '';
    const key = (code + ' ' + label).trim();
    const cells = sampleCols.map((i) => cellValue(row[i]));
    const values = cells.map((c) => c.value);
    // sample-metadata rows (Tilia “#” codes or plain labels)
    if (/^#?depth|^#depth/i.test(key) || RE.depth.test(label)) { values.forEach((v, j) => { if (v != null) samples[j].depth = v; }); continue; }
    if (/#thick/i.test(key) || RE.thick.test(label)) { values.forEach((v, j) => { samples[j].thickness = v; }); continue; }
    if (/#chron|#age/i.test(key) || (RE.age.test(label) && !/error/i.test(label))) { values.forEach((v, j) => { samples[j].age = v; }); continue; }
    if (/#anal\.unit|#samp\.name|#sample/i.test(key) || RE.sample.test(label)) { sampleCols.forEach((ci, j) => { samples[j].name = labelOf(row[ci]); }); continue; }
    if (/#samp\.analyst/i.test(key) || RE.analyst.test(label)) { sampleCols.forEach((ci, j) => { samples[j].analyst = labelOf(row[ci]); }); continue; }
    if (key.startsWith('#')) { notes.push(`${sheetName}: kept special row “${key}” out of the variable list.`); continue; }
    if (!label || values.every((v) => v == null)) continue;
    const { name, unit } = splitLabel(label);
    variables.push({
      name, rawLabel: label, unitHint: unitsCol != null ? labelOf(row[unitsCol]) : unit, values,
      code, element: elementCol != null ? labelOf(row[elementCol]) : undefined,
      context: contextCol != null ? labelOf(row[contextCol]) : '',
      taphonomy: taphCol != null ? labelOf(row[taphCol]) : '',
      group: groupCol != null ? labelOf(row[groupCol]) : undefined,
      presence: cells.some((c) => c.presence),
      include: !isDerived(label),
      excludeReason: isDerived(label) ? 'looks like a derived value (total, sum, concentration, accumulation rate)' : '',
    });
  }
  samples.forEach((s, j) => { if (s.depth == null && !s.name) s.name = String(j + 1); });
  return { samples, variables, layout: 'variables-as-rows', roles: {} };
}

function chooseLayout(rows, h) {
  const header = rows[h].map(labelOf);
  const body = rows.slice(h + 1);
  if (header.some((l) => RE.depth.test(l) || RE.top.test(l) || (RE.age.test(l) && !RE.varHeader.test(l)))) return 'samples-as-rows';
  const afterFirst = header.slice(1).filter(Boolean);
  const headerNumeric = afterFirst.length ? afterFirst.filter((l) => toNumber(l) != null).length / afterFirst.length : 0;
  const firstColText = 1 - numericShare(body.map((r) => r[0]));
  if (RE.varHeader.test(header[0]) || headerNumeric > 0.6 || (firstColText > 0.8 && body.length > header.length)) return 'variables-as-rows';
  return 'samples-as-rows';
}

// Age-model output (e.g. clam/Bacon): depth + best/median age + min/max bounds
function looksLikeAgeModelSheet(header) {
  const l = header.map(labelOf);
  return l.some((x) => RE.depth.test(x) || /^depth/i.test(x)) && l.some((x) => /^(best|median|mean|wmean|weighted mean|mid)\b/i.test(x)) &&
    l.some((x) => /min|max|95|lower|upper|young|old/i.test(x));
}

function parseAgeModelSheet(rows, h, sheetName) {
  const header = rows[h].map(labelOf);
  const find = (re) => header.findIndex((x) => re.test(x));
  const c = { depth: find(/depth/i), best: find(/^(best|median|mean|wmean|weighted mean|mid)\b/i), min: find(/min|lower|young/i), max: find(/max|upper|old/i) };
  const points = rows.slice(h + 1).map((r) => ({
    depth: toNumber(r[c.depth]), best: toNumber(r[c.best]),
    min: c.min >= 0 ? toNumber(r[c.min]) : null, max: c.max >= 0 ? toNumber(r[c.max]) : null,
  })).filter((p) => p.depth != null && p.best != null);
  const model = /clam/i.test(sheetName) ? 'clam' : /bacon/i.test(sheetName) ? 'Bacon' : /oxcal/i.test(sheetName) ? 'OxCal' : '';
  return { name: sheetName, model, points };
}

// One sheet often holds several tables side by side: blocks separated by empty columns
// (Kimble/Sharkey: "Abs Depth … | LOI Depth … | OM Depth …"), optionally under group labels
// in the row above the header ("Sharkey Lake" … "Kimble Pond"), or sites given as header
// prefixes ("Dewey Depth, Dewey CHAR, Two Mile Depth, Two Mile CHAR"). Returns column groups.
function splitBlocks(rows, h) {
  const header = rows[h].map(labelOf);
  const width = header.length;
  const emptyCol = (c) => !header[c] && rows.slice(h + 1).every((r) => isBlank(r[c]));
  let blocks = [];
  let cur = [];
  for (let c = 0; c < width; c++) {
    if (emptyCol(c)) { if (cur.length) blocks.push(cur); cur = []; } else cur.push(c);
  }
  if (cur.length) blocks.push(cur);
  blocks = blocks.filter((b) => b.length >= 2);
  // labels from the row above the header: a label applies from its column until the next label
  const above = h > 0 ? rows[h - 1].map(labelOf) : [];
  const labelAt = (c) => { for (let k = c; k >= 0; k--) if (above[k]) return above[k]; return ''; };
  // a label inside the block's columns wins; otherwise the nearest one to its left
  // labels name tables only when they sit over separate blocks (Sharkey | Kimble); a label row over
  // one table is sub-headings ("Big 250 … Small 125")
  let out = blocks.map((cols) => ({ cols, label: blocks.length >= 2 && above.some(Boolean) ? (cols.map((c) => above[c]).find(Boolean) || labelAt(cols[0])) : '' }));
  // site prefixes within one block
  out = out.flatMap((b) => {
    const pref = new Map();
    for (const c of b.cols) {
      const m = header[c].match(/^(.+?)\s+(depth|age|core depth)\b/i);
      if (m && /depth/i.test(m[2])) pref.set(m[1], []);
    }
    // a real site prefix labels several columns and isn't a depth word ("Top depth", "Bottom depth")
    for (const p of [...pref.keys()]) {
      const n = b.cols.filter((c) => header[c].startsWith(p + ' ')).length;
      if (n < 2 || /^(top|bottom|base|upper|lower|mid|midpoint|middle|total|composite|sample|drive|core|start|end|abs|absolute|true|corrected|from|to)$/i.test(p)) pref.delete(p);
    }
    if (pref.size < 2) return [b];
    for (const c of b.cols) { const p = [...pref.keys()].find((k) => header[c].startsWith(k + ' ')); if (p) pref.get(p).push(c); }
    return [...pref.entries()].map(([p, cols]) => ({ cols, label: p, stripPrefix: p }));
  });
  return out;
}

const sub = (rows, cols, strip) => rows.map((r, i) => cols.map((c) => (strip && typeof r[c] === 'string' && r[c].startsWith(strip + ' ') ? r[c].slice(strip.length + 1) : r[c])));

// Public entry: sheets = [{name, rows}] → analysis result
export function analyzeWorkbook(sheets, fileName) {
  const result = { datasets: [], metadata: [], geochron: [], ageModels: [], notes: [], sheets: [] };
  for (const sheet of sheets) {
    const rows = trimTable(sheet.rows || []);
    const label = sheets.length > 1 ? `${fileName} › ${sheet.name}` : fileName;
    if (!rows.length) continue;
    if (looksLikeMetadataSheet(rows)) {
      const pairs = metadataPairs(rows);
      pairs.forEach((p) => result.metadata.push({ ...p, source: label }));
      result.sheets.push({ name: sheet.name, kind: 'metadata', detail: `${pairs.length} fields` });
      continue;
    }
    const h = findHeaderRow(rows);
    // key/value lines above the table header (common in lab exports)
    metadataPairs(rows.slice(0, h)).forEach((p) => result.metadata.push({ ...p, source: label }));
    if (looksLikeDateSheet(rows[h])) {
      const dates = parseDateSheet(rows, label);
      result.geochron.push(...dates);
      result.sheets.push({ name: sheet.name, kind: 'dates', detail: `${dates.length} dates` });
      continue;
    }
    if (looksLikeAgeModelSheet(rows[h])) {
      const am = parseAgeModelSheet(rows, h, sheet.name);
      if (am.points.length) {
        result.ageModels.push({ ...am, source: label });
        if (am.model) result.metadata.push({ path: 'dataset.AgeModel', key: sheet.name, value: am.model, source: label });
        result.sheets.push({ name: sheet.name, kind: 'age model', detail: `${am.points.length} depths${am.model ? `, ${am.model}` : ''}` });
        continue;
      }
    }
    const blocks = splitBlocks(rows, h);
    let found = 0;
    for (const b of blocks.length ? blocks : [{ cols: rows[h].map((_, i) => i), label: '' }]) {
      const bRows = sub(rows, b.cols, b.stripPrefix);
      const layout = chooseLayout(bRows, h);
      const parsed = layout === 'samples-as-rows'
        ? parseSamplesAsRows(bRows, h, label, result.notes)
        : parseVariablesAsRows(bRows, h, label, result.notes);
      if (!parsed.variables.length) continue;
      const blockName = [sheet.name, b.label].filter(Boolean).join(' › ');
      // rows from several sites stacked in one table ("Site name" column) → one table per site
      const sites = [...new Set(parsed.samples.map((x) => x.site).filter(Boolean))];
      if (sites.length >= 2) {
        for (const site of sites) {
          const idx = parsed.samples.map((x, i) => (x.site === site ? i : -1)).filter((i) => i >= 0);
          result.datasets.push({
            ...parsed, source: label, sheet: `${blockName} › ${site}`, site,
            samples: idx.map((i) => parsed.samples[i]),
            variables: parsed.variables.map((v) => ({ ...v, values: idx.map((i) => v.values[i]) })),
          });
        }
        found += sites.length;
      } else {
        result.datasets.push({ ...parsed, source: label, sheet: blockName, site: b.label || sites[0] || '' });
        found++;
      }
    }
    if (!found) {
      result.sheets.push({ name: sheet.name, kind: 'skipped', detail: 'no numeric data found' });
      continue;
    }
    result.sheets.push({ name: sheet.name, kind: 'data', detail: found > 1 ? `${found} tables (sites or side-by-side blocks)` : `${result.datasets[result.datasets.length - 1].samples.length} samples × ${result.datasets[result.datasets.length - 1].variables.length} variables` });
  }
  return result;
}
