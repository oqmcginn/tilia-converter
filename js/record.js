// The working record: every extracted value is kept as a candidate with its
// source; the highest-confidence candidate is shown unless the user edits it.

import { splitName, formatCitation } from './extract/bib.js';
import { guessPollenGroup, DEFAULTS_BY_TYPE } from './lookups.js';
import { TAXA } from './data/taxa.js';

// name/code → [name, code, element, units, group]
const normTaxon = (s) => String(s || '').toLowerCase().replace(/[‐-–_]+/g, '-').replace(/\s+/g, ' ').trim();
const TAXON_BY_NAME = new Map(TAXA.map((t) => [normTaxon(t[0]), t]));
const TAXON_BY_CODE = new Map(TAXA.map((t) => [t[1].toLowerCase(), t]));
export function findTaxon(name, code) {
  const n = normTaxon(name);
  return TAXON_BY_NAME.get(n) || TAXON_BY_NAME.get(n.replace(/[- ]type$/, '')) || TAXON_BY_NAME.get(n.replace(/\s*\(.*\)$/, ''))
    || (code ? TAXON_BY_CODE.get(String(code).toLowerCase()) : null) || null;
}

export const FIELD_DEFS = {
  site: [
    ['SiteName', 'Site name'], ['LatNorth', 'Latitude (°N)', 'number'], ['LongEast', 'Longitude (°E)', 'number'],
    ['Altitude', 'Altitude (m)', 'number'], ['Country', 'Country'], ['State', 'State / province'], ['County', 'County'],
    ['SiteDescription', 'Site description', 'textarea'],
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
        auto('code', '_autoCode', hit[1]);
        auto('element', '_autoElement', hit[2]);
        auto('units', '_autoUnits', v.presence ? 'present/absent' : (v._unitGuess && v._unitGuess !== 'NISP' ? v._unitGuess : hit[3]));
        auto('group', '_autoGroup', hit[4]);
      } else {
        auto('element', '_autoElement', def.element ?? '');
        auto('units', '_autoUnits', v.presence ? 'present/absent' : (v._unitGuess || def.units || ''));
        auto('group', '_autoGroup', /pollen/i.test(type || '') ? guessPollenGroup(v.name) : '');
      }
    }
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
