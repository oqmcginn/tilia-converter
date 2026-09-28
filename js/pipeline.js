// Publication ingestion shared by the app and the evaluation page:
// text heuristics → candidates, CrossRef enrichment, publication + contacts,
// and paper-wide ORCID evidence.

import { extractFromPublication } from './extract/text.js';
import { crossrefLookup, crossrefSearchTitle } from './extract/bib.js';
import { addCandidate, addPublication, addDates } from './record.js';
import { findOrcidsInText, findAffiliations } from './orcid.js';
import { parseMaterialSections, occurrencesToDataset } from './extract/fauna.js';

export async function ingestPublication(state, pages, fileName, { title = '', crossref = true, site = '' } = {}) {
  const found = extractFromPublication(pages, fileName, { title, site });
  const pub = {};
  const notes = [];
  let n = 0;
  for (const f of found) {
    if (f.path === 'geochron') { addDates(state, f.value); n += f.value.length; continue; }
    if (f.path === 'contacts._emails') { state.emails = [...new Set([...(state.emails || []), ...f.value])]; continue; }
    if (f.path === 'site._altCoords') { state.altCoords = f.value; continue; }
    if (f.path.startsWith('publication.')) { pub[f.path.split('.')[1]] ||= f.value; continue; }
    addCandidate(state, f.path, { ...f, fromText: true });
    n++;
  }
  if (title && !pub.ArticleTitle) pub.ArticleTitle = title;
  if (!pub.ArticleTitle && !title) {
    // plain text: first title-like line near the top
    const line = pages[0].text.split('\n').slice(0, 15).map((l) => l.trim())
      .find((l) => l.length >= 20 && l.length <= 250 && !/[.:]$/.test(l) && /[a-z]/.test(l) && !/^(abstract|keywords|doi|http)/i.test(l));
    if (line) pub.ArticleTitle = line;
  }
  if (pub.DOI && crossref) {
    try {
      Object.assign(pub, await crossrefLookup(pub.DOI));
      notes.push('CrossRef ✓');
    } catch {
      notes.push('CrossRef lookup failed');
    }
  }
  if (!pub.DOI && pub.ArticleTitle && crossref) {
    try {
      const hit = await crossrefSearchTitle(pub.ArticleTitle);
      if (hit) { Object.assign(pub, hit); notes.push('CrossRef title match ✓'); }
    } catch {
      notes.push('CrossRef title search failed');
    }
  }
  if (pub.DOI || pub.ArticleTitle) addPublication(state, pub, fileName);

  const text = pages.map((p) => p.text).join('\n');

  // vertebrate papers: specimen lists in "Material and provenience" sections become the data table
  const occ = parseMaterialSections(text);
  if (occ.length) {
    const ds = occurrencesToDataset(occ, fileName);
    state.datasets.push(ds);
    notes.push(`${occ.length} specimens → ${ds.variables.length} taxon × element rows`);
    const flagged = occ.filter((o) => o.note);
    if (flagged.length) (state.notes ||= []).push(`${fileName}: ${flagged.map((o) => o.catalog).join(', ')} — ${flagged[0].note}; the last zone given was used.`);
    const noProv = occ.filter((o) => o.unit === 'Assemblage').length;
    if (noProv) (state.notes ||= []).push(`${fileName}: ${noProv} specimen(s) without a zone were put in an "Assemblage" column.`);
  }

  const os = (state.orcidSources ||= { affiliations: [], printed: [] });
  os.affiliations = [...new Set([...os.affiliations, ...findAffiliations(text)])];
  for (const p of findOrcidsInText(text)) {
    if (!os.printed.some((x) => x.id === p.id)) os.printed.push({ id: p.id, source: fileName });
  }
  return { valuesFound: n, notes };
}

// Country / state / county from the chosen coordinates (OpenStreetMap Nominatim).
// Sends only the coordinates. Nominatim asks for at most one request per second.
let lastGeocode = 0;
export async function geocodeSite(state, { fetchImpl = fetch.bind(globalThis) } = {}) {
  const lat = parseFloat(state.values['site.LatNorth']), lon = parseFloat(state.values['site.LongEast']);
  if (Number.isNaN(lat) || Number.isNaN(lon)) return null;
  const key = `${lat.toFixed(4)},${lon.toFixed(4)}`;
  if (state.geocodedFor === key) return null;
  const wait = 1100 - (Date.now() - lastGeocode);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastGeocode = Date.now();
  const res = await fetchImpl(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=10&accept-language=en&lat=${lat}&lon=${lon}`);
  if (!res.ok) throw new Error(`OpenStreetMap returned ${res.status}`);
  const a = (await res.json()).address || {};
  state.geocodedFor = key;
  const src = `OpenStreetMap, from ${lat.toFixed(4)}, ${lon.toFixed(4)}`;
  const put = (path, value) => value && addCandidate(state, path, { value, source: src, confidence: 0.8 });
  put('site.Country', a.country);
  put('site.State', a.state || a.province || a.region);
  put('site.County', (a.county || a.state_district || '').replace(/\s+(County|Borough|Parish|Census Area|Municipality|Regional District|District)$/i, ''));
  return a;
}

// Re-read site-specific fields (coordinates, altitude, water depth, environment) around
// one named site, for papers covering several sites. Called when the user picks a site.
const SITE_PATHS = ['site.LatNorth', 'site.LongEast', 'site.Altitude', 'collectionUnit.WaterDepth', 'collectionUnit.DepositionalEnvironment'];
export function reanchorSite(state, site, publications) {
  for (const path of SITE_PATHS) {
    if (state.edited[path]) continue;
    state.candidates[path] = (state.candidates[path] || []).filter((c) => !c.fromText);
    delete state.values[path];
  }
  for (const { pages, fileName, title } of publications) {
    for (const f of extractFromPublication(pages, fileName, { title, site })) {
      if (SITE_PATHS.includes(f.path)) addCandidate(state, f.path, { ...f, fromText: true, source: `${f.source} · near “${site}”` });
      if (f.path === 'site._altCoords') state.altCoords = f.value;
    }
  }
  for (const path of SITE_PATHS) {
    const list = state.candidates[path] || [];
    if (!state.edited[path] && list.length) state.values[path] = list[0].value;
  }
}
