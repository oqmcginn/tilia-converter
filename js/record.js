// The working record: every extracted value is kept as a candidate with its
// source; the highest-confidence candidate is shown unless the user edits it.

import { splitName, formatCitation } from './extract/bib.js';
import { guessPollenGroup, DEFAULTS_BY_TYPE } from './lookups.js';
import { TAXA } from './data/taxa.js';

// name/code → [name, code, element, units, group]
const normTaxon = (s) => String(s || '').toLowerCase().replace(/[‐-–_]+/g, '-').replace(/\s+/g, ' ').trim();
const TAXON_BY_NAME = new Map(TAXA.map((t) => [normTaxon(t[0]), t]));
const TAXON_BY_CODE = new Map(TAXA.map((t) => [t[1].toLowerCase(), t]));
// Spreadsheet labels → Neotoma taxon names, following hand conversions:
// "Cheno.Am" → Amaranthaceae, "Salicaceae populus type" → Populus-type,
// "Fagaceae chrysolepis" → Chrysolepis-type, "Tricolpate unk" → Unknown (tricolpate),
// small misspellings ("Rosaceae cercocarphus" → Cercocarpus-type) tolerated.
const ALIASES = [
  [/^cheno[\s.\-/]*am(aranth\w*)?$|^chenopodiaceae[\s/-]*amaranthaceae$|^chenopodiaceae$/i, 'Amaranthaceae'],
  [/^tricolpate\b.*\b(unk|unknown|indet)/i, 'Unknown (tricolpate)'],
  [/^tricolporate\b.*\b(unk|unknown|indet)/i, 'Unknown (tricolporate)'],
  [/^(unk|unknown)\b.*\btricolpate/i, 'Unknown (tricolpate)'],
  [/^(unk|unknown)\b.*\btricolporate/i, 'Unknown (tricolporate)'],
  [/^cetartiodactyla\b/i, 'Artiodactyla'],
];
const cap = (w) => (w ? w[0].toUpperCase() + w.slice(1).toLowerCase() : w);
function lev(a, b) {
  if (Math.abs(a.length - b.length) > 2) return 9;
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}
function taxonCandidates(label) {
  // "Onograceae-epilobium": a hyphen after a family name separates it from the genus
  // open nomenclature: "Equus sp.", "Testudinidae (indeterminate)", "Hesperotestudo sp. (giant form)", "cf. Bison"
  const bare = String(label || '').replace(/\s*\((?:indeterminate|indet\.?|giant form|large form|small form)\)/gi, '').replace(/\b(?:cf|aff)\.\s*/gi, '').replace(/\s+spp?\.?(?=\s|$)/gi, '');
  const base = bare.replace(/[._]+/g, ' ').replace(/(ceae?)-(?=[a-z])/gi, '$1 ').replace(/\s+/g, ' ').trim();
  const out = [base];
  for (const [re, name] of ALIASES) if (re.test(base)) out.push(name);
  const words = base.split(' ');
  const hasType = /\btype$/i.test(base);
  const core = words.filter((w) => !/^type$/i.test(w));
  out.push(cap(core.join(' ')) + (hasType ? '-type' : ''));
  if (core.length >= 2 && /ce(a|ae)$/i.test(core[0])) {
    // family + genus: the genus names the Neotoma type
    const genus = cap(core[core.length - 1]);
    out.push(`${genus}-type`, genus, `${cap(core[1])}-type`, cap(core[1]));
    if (core.length === 2 || hasType) out.push(cap(core.slice(1).join(' ')));
  }
  if (core.length === 1) out.push(`${cap(core[0])}-type`, cap(core[0]).replace(/acea$/, 'aceae'));
  return [...new Set(out)];
}
export function findTaxon(name, code) {
  for (const cand of taxonCandidates(name)) {
    const n = normTaxon(cand);
    const hit = TAXON_BY_NAME.get(n) || TAXON_BY_NAME.get(n.replace(/[- ]type$/, '')) || TAXON_BY_NAME.get(n.replace(/\s*\(.*\)$/, ''));
    if (hit) return hit;
  }
  if (code && TAXON_BY_CODE.get(String(code).toLowerCase())) return TAXON_BY_CODE.get(String(code).toLowerCase());
  // one- or two-letter misspellings of a single genus ("cercocarphus")
  for (const cand of taxonCandidates(name).slice(-4)) {
    const n = normTaxon(cand);
    if (n.length < 6) continue;
    let best = null;
    for (const [k, t] of TAXON_BY_NAME) if (k[0] === n[0] && lev(k, n) <= (n.length > 9 ? 2 : 1)) { best = t; break; }
    if (best) return best;
  }
  return null;
}

export const FIELD_DEFS = {
  site: [
    ['SiteName', 'Site name'], ['LatNorth', 'Latitude (°N)', 'number'], ['LongEast', 'Longitude (°E)', 'number'],
    ['Altitude', 'Altitude (m)', 'number'], ['Country', 'Country'], ['State', 'State / province'], ['County', 'County'],
    ['SiteDescription', 'Site description', 'textarea'], ['Notes', 'Site notes', 'textarea'],
  ],
  collectionUnit: [
    ['Handle', 'Handle'], ['CollectionName', 'Collection name'], ['CollectionType', 'Collection type', 'collectionType'],
    ['CollectionDevice', 'Collection device'], ['CollectionDate', 'Collection date', 'text', 'YYYY-MM-DD'],
    ['DepositionalEnvironment', 'Depositional environment', 'depenv'], ['WaterDepth', 'Water depth (m)', 'number'],
    ['Location', 'Location in site'],
  ],
  dataset: [
    ['DatasetType', 'Dataset type', 'datasetType'], ['ChronologyName', 'Chronology name', 'text', 'Author generated'],
    ['AgeModel', 'Age model', 'text', 'e.g. Bacon'], ['IsSSamp', 'Surface sample', 'checkbox'],
    ['Notes', 'Dataset notes', 'textarea'],
  ],
};

export const ROLES = ['Investigator', 'Author', 'Collector', 'Processor', 'Analyst'];

export function emptyState() {
  return {
    sources: [],             // {id, name, kind, status, detail, notes:[]}
    candidates: {},          // path → [{value, source, confidence, snippet}]
    values: {},              // path → chosen value
    edited: {},              // path → true when the user typed it
    contacts: [],            // {FullContactName, ..., roles:[], source}
    publications: [],        // {PubType, Year, ArticleTitle, ..., authors:[], Citation, source}
    geochron: [],            // {labNumber, age, error, depth, thickness, material, method, source}
    datasets: [],            // analysed data sheets
    ageModels: [],           // age-model sheets: {name, model, points:[{depth,best,min,max}]}
    activeDataset: 0,
    notes: [],
    options: { includeAges: true },
    orcidSources: { affiliations: [], printed: [] }, // paper-wide evidence for ORCID matching
  };
}

export function addCandidate(state, path, cand) {
  if (cand.value == null || cand.value === '') return;
  const list = (state.candidates[path] ||= []);
  const same = list.find((c) => String(c.value).toLowerCase() === String(cand.value).toLowerCase());
  if (same) {
    same.confidence = Math.min(0.99, Math.max(same.confidence, cand.confidence) + 0.05);
    if (!same.source.includes(cand.source)) same.source += `; ${cand.source}`;
  } else list.push({ ...cand });
  list.sort((a, b) => b.confidence - a.confidence);
  if (!state.edited[path]) state.values[path] = list[0].value;
}

export function setValue(state, path, value) {
  state.values[path] = value;
  state.edited[path] = true;
}

export function addContact(state, c, role, source) {
  if (!c || !c.FamilyName) return null;
  const key = (x) => `${x.FamilyName}|${(x.GivenNames || x.LeadingInitials || '')[0] || ''}`.toLowerCase();
  let hit = state.contacts.find((x) => key(x) === key(c));
  if (!hit) {
    hit = { ...c, roles: [], source };
    state.contacts.push(hit);
  } else {
    for (const k of ['GivenNames', 'Email', 'LeadingInitials', 'crossrefOrcid']) if (!hit[k] && c[k]) hit[k] = c[k];
    if (c.affiliations?.length) hit.affiliations = [...new Set([...(hit.affiliations || []), ...c.affiliations])];
    if ((c.GivenNames || '').length > (hit.GivenNames || '').length) Object.assign(hit, { GivenNames: c.GivenNames, FullContactName: c.FullContactName, LeadingInitials: c.LeadingInitials, ShortContactName: c.ShortContactName });
  }
  if (role && !hit.roles.includes(role)) hit.roles.push(role);
  return hit;
}

export function addPublication(state, pub, source) {
  const doi = (pub.DOI || '').toLowerCase();
  let hit = doi && state.publications.find((p) => (p.DOI || '').toLowerCase() === doi);
  if (!hit && pub.ArticleTitle) hit = state.publications.find((p) => p.ArticleTitle && p.ArticleTitle.toLowerCase() === pub.ArticleTitle.toLowerCase());
  if (hit) {
    for (const [k, v] of Object.entries(pub)) if (v && (!hit[k] || (Array.isArray(hit[k]) && !hit[k].length))) hit[k] = v;
    hit.source += hit.source.includes(source) ? '' : `; ${source}`;
  } else {
    hit = { PubType: 'journal article', authors: [], ...pub, source };
    state.publications.push(hit);
  }
  hit.Citation = formatCitation(hit);
  hit.authors.forEach((a, i) => {
    addContact(state, a, 'Author', source);
    if (i === 0) addContact(state, a, 'Investigator', source);
  });
  return hit;
}

export function addDates(state, dates) {
  for (const d of dates) {
    const hit = d.labNumber && state.geochron.find((g) => g.labNumber === d.labNumber);
    if (hit) { for (const [k, v] of Object.entries(d)) if (hit[k] == null || hit[k] === '') hit[k] = v; }
    else state.geochron.push({ ...d });
  }
}

// Fill code/element/units/group for variables the user hasn't touched: first from the
// lab's taxon lookup (real Neotoma codes), then from dataset-type defaults.
export function applyTypeDefaults(state) {
  const type = state.values['dataset.DatasetType'];
  const def = DEFAULTS_BY_TYPE[String(type || '').toLowerCase()] || {};
  for (const ds of state.datasets) {
    for (const v of ds.variables) {
      const hit = findTaxon(v.name, v.code);
      v.lookup = !!hit;
      const auto = (k, flag, val) => { if (!v._edited?.[k] && (v[k] == null || v[k] === '' || v[flag])) { v[k] = val; v[flag] = true; } };
      if (hit) {
        if (!v._edited?.name && v.name !== hit[0]) { v.rawLabel ||= v.name; v.name = hit[0]; }
        auto('code', '_autoCode', hit[1]);
        auto('element', '_autoElement', hit[2]);
        auto('units', '_autoUnits', v.presence ? 'present/absent' : (v.unitHint ? v._unitGuess || hit[3] : hit[3]));
        auto('group', '_autoGroup', hit[4]);
      } else {
        auto('element', '_autoElement', def.element ?? '');
        auto('units', '_autoUnits', v.presence ? 'present/absent' : (v._unitGuess || def.units || ''));
        auto('group', '_autoGroup', /pollen/i.test(type || '') ? guessPollenGroup(v.name) : '');
      }
    }
  }
}

// Multi-proxy workbooks have one sheet per proxy; a Tilia file holds one dataset.
// Choose the sheet named for the dataset type (e.g. "Pollen"), else the largest one,
// unless the user picked a sheet themselves.
export function pickDataset(state) {
  if (state.datasetChosen || state.datasets.length < 2) return;
  const type = String(state.values['dataset.DatasetType'] || '').toLowerCase();
  const words = { 'loss-on-ignition': /loss|\bloi\b/, 'plant macrofossil': /macro/, 'charcoal': /char/, 'pollen': /pollen|palyn/ }[type] || (type ? new RegExp(type.split(' ')[0]) : null);
  const byName = words ? state.datasets.findIndex((d) => words.test(String(d.sheet || d.source).toLowerCase())) : -1;
  state.activeDataset = byName >= 0 ? byName
    : state.datasets.reduce((best, d, i, all) => (d.variables.length * d.samples.length > all[best].variables.length * all[best].samples.length ? i : best), 0);
}

// Sample ages (and min/max range) from an age-model sheet, matched by depth with
// linear interpolation between modelled depths. Ages already in the data sheet win.
export function applyAgeModel(state) {
  const am = state.ageModels?.[0];
  const ds = state.datasets[state.activeDataset];
  if (!am || !ds) return;
  const pts = [...am.points].sort((a, b) => a.depth - b.depth);
  const at = (d, k) => {
    if (d == null || !pts.length || d < pts[0].depth || d > pts[pts.length - 1].depth) return null;
    let i = pts.findIndex((p) => p.depth >= d);
    if (pts[i].depth === d || i === 0) return pts[i][k];
    const a = pts[i - 1], b = pts[i];
    if (a[k] == null || b[k] == null) return null;
    return Math.round(a[k] + ((d - a.depth) / (b.depth - a.depth)) * (b[k] - a[k]));
  };
  for (const s of ds.samples) {
    if (s.age == null || s._ageFromModel) { const v = at(s.depth, 'best'); if (v != null) { s.age = v; s._ageFromModel = true; } }
    s.ageYoung = at(s.depth, 'min');
    s.ageOld = at(s.depth, 'max');
  }
}

export function contactFromString(s) { return splitName(s); }

// Plain object for the Tilia writer
export function toRecord(state) {
  const pick = (section) => Object.fromEntries(FIELD_DEFS[section].map(([k]) => [k, state.values[`${section}.${k}`] ?? '']));
  const ds = state.datasets[state.activeDataset];
  return {
    site: pick('site'),
    collectionUnit: pick('collectionUnit'),
    dataset: pick('dataset'),
    contacts: state.contacts,
    publications: state.publications,
    geochron: state.geochron,
    data: ds ? { samples: ds.samples, variables: ds.variables } : null,
  };
}
