import { analyzeWorkbook, normalizeUnit, parseCoordValue } from './extract/spreadsheet.js';
import { ingestPublication, geocodeSite, reanchorSite } from './pipeline.js';
import { crossrefLookup, parseRIS, parseBibTeX, splitName, formatCitation } from './extract/bib.js';
import { readSpreadsheet, readPdf, readText, fileKind, download } from './io.js';
import { buildTilia, validate, pubType } from './tilia.js';
import {
  emptyState, addCandidate, setValue, addContact, addPublication, addDates, applyTypeDefaults,
  toRecord, FIELD_DEFS, ROLES, pickDataset, applyAgeModel,
} from './record.js';
import { DATASET_TYPES, COLLECTION_TYPES, DEPOSITIONAL_ENVIRONMENTS } from './lookups.js';
import { MODELS, extractWithClaude } from './ai.js';
import { resolveOrcids, normalizeOrcid, orcidChecksumOK, confidenceLabel } from './orcid.js';

const $ = (sel) => document.querySelector(sel);
const STORE_KEY = 'tilia-converter:v1';
const KEY_KEY = 'tilia-converter:apikey';
const GROUPS = ['TRSH', 'UPHE', 'VACR', 'AQVP', 'SUCC', 'PALM', 'MANG', 'UNID', 'LABO', 'BRYO', 'ALGA', 'FUNG', 'AQBR', 'CHRY', 'DIAT', 'OSTR', 'MAMM', 'AVES', 'HERP', 'FISH', 'MOLL', 'INSE', 'CHAR', 'LOI', 'WCHM', 'SED', 'CLIM'];

let state = emptyState();
const rawInputs = new Map(); // source id → {bytes} | {text}; kept in memory only
const pubTexts = new Map(); // source id → {pages, fileName, title}; for re-reading around a chosen site
let activeTab = 'site';
let map, marker;

// ---------- tiny DOM helper ----------
function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k in el && k !== 'list' && typeof v !== 'string') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : String(kid));
  return el;
}

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => t.classList.remove('show'), 2600);
}

// ---------- persistence ----------
let saveTimer;
function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch { /* storage full or blocked: fine */ }
  }, 400);
}
function restore() {
  try {
    const s = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
    if (s && s.values) state = { ...emptyState(), ...s };
  } catch { /* ignore */ }
}

// ---------- ingestion ----------
let idSeq = 0;
function addSource(name, kind) {
  const src = { id: `s${Date.now()}_${idSeq++}`, name, kind, status: 'reading', detail: 'Reading…' };
  state.sources.push(src);
  renderSources();
  return src;
}

async function handleFiles(files) {
  for (const file of files) {
    const kind = fileKind(file.name);
    const src = addSource(file.name, kind);
    try {
      if (kind === 'spreadsheet') await ingestSpreadsheet(file, src);
      else if (kind === 'pdf') await ingestPdf(file, src);
      else if (kind === 'text') await ingestText(file, src);
      else if (kind === 'ris' || kind === 'bibtex') await ingestCitations(file, src, kind);
      else throw new Error('Unsupported file type');
      src.status = 'done';
    } catch (err) {
      console.error(err);
      src.status = 'error';
      src.detail = err.message || String(err);
    }
    finishIngest();
  }
}

async function ingestSpreadsheet(file, src) {
  const sheets = await readSpreadsheet(file);
  const res = analyzeWorkbook(sheets, file.name);
  for (const ds of res.datasets) {
    ds.variables.forEach((v) => { v._unitGuess = normalizeUnit(v.unitHint, v.values); });
    state.datasets.push(ds);
  }
  state.ageModels = [...(state.ageModels || []), ...res.ageModels];
  if (res.datasets.length > 1) {
    state.notes.push(`${file.name} has ${res.datasets.length} data sheets (${res.datasets.map((d) => d.sheet).join(', ')}). A Tilia file holds one dataset, so choose the sheet on the Data tab and convert each proxy separately.`);
  }
  for (const m of res.metadata) applySheetMeta(m);
  addDates(state, res.geochron);
  state.notes.push(...res.notes);
  src.detail = res.sheets.map((s) => `${s.name}: ${s.kind === 'data' ? s.detail : s.kind + (s.detail ? ` (${s.detail})` : '')}`).join(' · ') || 'No usable sheets';
}

function applySheetMeta(m) {
  // a sheet *named* "Clam Age Model" is weaker evidence than the paper's own methods text
  const cand = { value: m.value, source: `${m.source} · “${m.key}”`, confidence: m.path === 'dataset.AgeModel' && m.key !== 'Age model' ? 0.55 : 0.9 };
  if (m.path === 'site.LatNorth' || m.path === 'site.LongEast') {
    const v = parseCoordValue(m.value, m.path === 'site.LongEast');
    // keep text we couldn't parse visible (low confidence) rather than dropping it
    if (v == null) Object.assign(cand, { confidence: 0.3, snippet: 'could not convert to decimal degrees' });
    else cand.value = v;
  }
  if (m.path.startsWith('contacts.')) {
    const role = m.path.split('.')[1];
    if (role === 'Email') { if (state.contacts[0] && !state.contacts[0].Email) state.contacts[0].Email = m.value; return; }
    String(m.value).split(/;|\band\b|&/).map((s) => s.trim()).filter(Boolean)
      .forEach((n) => addContact(state, splitName(n), role, m.source));
    return;
  }
  if (m.path.startsWith('publication.')) {
    const k = m.path.split('.')[1];
    addPublication(state, k === 'Citation' ? { Citation: m.value, ArticleTitle: '' } : { [k]: m.value }, m.source);
    return;
  }
  addCandidate(state, m.path, cand);
}

async function ingestPdf(file, src) {
  const pdf = await readPdf(file);
  rawInputs.set(src.id, { bytes: pdf.bytes, name: file.name });
  src.detail = `${pdf.pages.length} pages`;
  await processPublicationText(pdf.pages, file.name, src, { title: pdf.title });
}

async function ingestText(file, src) {
  const text = await readText(file);
  rawInputs.set(src.id, { text, name: file.name });
  src.detail = `${text.length.toLocaleString()} characters`;
  await processPublicationText([{ page: null, text }], file.name, src, {});
}

async function processPublicationText(pages, fileName, src, { title }) {
  pubTexts.set(src.id, { pages, fileName, title });
  const r = await ingestPublication(state, pages, fileName, { title, crossref: $('#opt-crossref').checked, site: state.edited['site.SiteName'] ? state.values['site.SiteName'] : '' });
  r.notes.forEach((n) => { src.detail += ` · ${n}`; });
  matchEmails();
  src.detail += ` · ${r.valuesFound} values found`;
}

async function ingestCitations(file, src, kind) {
  const text = await file.text();
  const recs = kind === 'ris' ? parseRIS(text) : parseBibTeX(text);
  recs.forEach((r) => addPublication(state, r, file.name));
  src.detail = `${recs.length} citation${recs.length === 1 ? '' : 's'}`;
}

async function addDOI(doi) {
  const clean = doi.trim().replace(/^https?:\/\/(dx\.)?doi\.org\//i, '').replace(/^doi:\s*/i, '');
  if (!/^10\.\d{4,9}\//.test(clean)) { toast('That does not look like a DOI'); return; }
  const src = addSource(clean, 'doi');
  try {
    const meta = await crossrefLookup(clean);
    addPublication(state, meta, `CrossRef (${clean})`);
    src.status = 'done';
    src.detail = meta.ArticleTitle ? meta.ArticleTitle.slice(0, 90) : 'Found';
  } catch (e) {
    addPublication(state, { DOI: clean }, 'DOI');
    src.status = 'error';
    src.detail = `CrossRef lookup failed (${e.message}); DOI kept`;
  }
  finishIngest();
}

function matchEmails() {
  for (const e of state.emails || []) {
    const local = e.split('@')[0].toLowerCase();
    const c = state.contacts.find((x) => !x.Email && x.FamilyName && local.includes(x.FamilyName.toLowerCase().replace(/[^a-z]/g, '')));
    if (c) c.Email = e;
  }
}

function suggestDerived() {
  const name = state.values['site.SiteName'];
  if (name && !state.candidates['collectionUnit.Handle']) {
    const handle = name.replace(/\b(Lake|Pond|Bog|Fen|Lac|Lago|Cave)\b/gi, '').replace(/[^A-Za-z0-9]/g, '').toUpperCase().slice(0, 8) || name.slice(0, 8).toUpperCase();
    addCandidate(state, 'collectionUnit.Handle', { value: handle, source: 'generated from site name', confidence: 0.2 });
  }
  if (name && !state.candidates['collectionUnit.CollectionName']) {
    addCandidate(state, 'collectionUnit.CollectionName', { value: name, source: 'generated from site name', confidence: 0.15 });
  }
}

function finishIngest() {
  suggestDerived();
  pickDataset(state);
  applyAgeModel(state);
  applyTypeDefaults(state);
  renderAll();
  persist();
  if ($('#opt-orcid').checked && state.contacts.some((c) => c.FamilyName && !c.orcid?.checked)) scheduleOrcid();
  scheduleGeocode();
}

// Papers often describe several sites: when the user picks one, re-read that site's
// coordinates, altitude, water depth and environment from the text around its name.
function siteChosen(name) {
  if (!name || !pubTexts.size) return;
  reanchorSite(state, name, [...pubTexts.values()]);
  renderAll();
  persist();
  scheduleGeocode();
  toast(`Re-read site details near “${name}”`);
}

// ---------- country / state / county from coordinates ----------
let geoTimer;
function scheduleGeocode() {
  if (!$('#opt-geocode').checked) return;
  clearTimeout(geoTimer);
  geoTimer = setTimeout(async () => {
    try {
      if (await geocodeSite(state)) { renderAll(); persist(); }
    } catch (e) { console.warn('Geocoding failed', e); }
  }, 800);
}

// ---------- ORCID ----------
let orcidTimer, orcidRunning = false, orcidAgain = false, orcidStatus = '';
const openOrcid = new Set(); // contacts whose candidate list is expanded

function scheduleOrcid() {
  clearTimeout(orcidTimer);
  orcidTimer = setTimeout(() => runOrcid(false), 600);
}

function setOrcidStatus(msg) {
  orcidStatus = msg;
  const el = document.getElementById('orcid-status');
  if (el) el.textContent = msg;
}

async function runOrcid(force) {
  if (orcidRunning) { orcidAgain = true; return; }
  orcidRunning = true;
  setOrcidStatus('Looking up ORCID iDs…');
  try {
    const sources = {
      dois: [...new Set(state.publications.map((p) => (p.DOI || '').trim()).filter(Boolean))],
      journals: [...new Set(state.publications.map((p) => p.Journal).filter(Boolean))],
      affiliations: state.orcidSources?.affiliations || [],
      printed: state.orcidSources?.printed || [],
    };
    await resolveOrcids(state.contacts, sources, { force, onProgress: setOrcidStatus });
    const count = (st) => state.contacts.filter((c) => c.orcid?.status === st).length;
    const parts = [[count('confirmed'), 'confirmed'], [count('likely'), 'likely'], [count('ambiguous'), 'need you to choose'], [count('none'), 'not found'], [count('error'), 'failed']]
      .filter(([n]) => n).map(([n, l]) => `${n} ${l}`);
    setOrcidStatus(parts.length ? `ORCID: ${parts.join(', ')}.` : '');
    state.contacts.filter((c) => c.orcid?.status === 'ambiguous').forEach((c) => openOrcid.add(c));
  } catch (err) {
    console.error(err);
    setOrcidStatus(`ORCID lookup failed: ${err.message}`);
  } finally {
    orcidRunning = false;
    renderAll();
    persist();
    if (orcidAgain) { orcidAgain = false; runOrcid(false); }
  }
}

// ---------- Claude ----------
async function runClaude() {
  const key = $('#ai-key').value.trim();
  const status = $('#ai-status');
  status.classList.remove('err');
  if (!key) { status.textContent = 'Enter an API key first.'; status.classList.add('err'); return; }
  const targets = state.sources.filter((s) => rawInputs.has(s.id));
  if (!targets.length) {
    status.textContent = state.sources.some((s) => s.kind === 'pdf' || s.kind === 'text')
      ? 'Re-add the publication files (they are not kept after a page reload).'
      : 'Add a PDF or text publication first.';
    status.classList.add('err');
    return;
  }
  try { if ($('#ai-remember').checked) localStorage.setItem(KEY_KEY, key); else localStorage.removeItem(KEY_KEY); } catch { /* ignore */ }
  const btn = $('#ai-run');
  btn.disabled = true;
  try {
    for (const src of targets) {
      const input = rawInputs.get(src.id);
      if (input.bytes && input.bytes.length > 30 * 1024 * 1024) { status.textContent = `${src.name} is over 30 MB — skipped.`; continue; }
      status.textContent = `Reading ${src.name}…`;
      const out = await extractWithClaude({
        apiKey: key, model: $('#ai-model').value, input, fileName: src.name,
        site: state.edited['site.SiteName'] ? state.values['site.SiteName'] : '',
        onProgress: (m) => { status.textContent = `${src.name}: ${m}`; },
      });
      applyClaude(out, src.name);
      src.detail += ` · ✦ Claude: ${out.fields.length} fields, ${out.dates.length} dates`;
      finishIngest();
    }
    status.textContent = 'Done. Claude’s suggestions are marked ✦ in the review.';
  } catch (err) {
    console.error(err);
    status.textContent = friendlyError(err);
    status.classList.add('err');
  } finally {
    btn.disabled = false;
  }
}

function friendlyError(err) {
  const s = err?.status;
  if (s === 401) return 'The API key was rejected (401). Check it and try again.';
  if (s === 429) return 'Rate limited (429). Wait a minute and retry.';
  if (s === 413) return 'The document is too large for one request.';
  if (s >= 500) return `Anthropic API error (${s}). Try again shortly.`;
  return err?.message || String(err);
}

function applyClaude(out, fileName) {
  const pub = {};
  for (const f of out.fields) {
    const src = `✦ Claude · ${fileName}${f.page ? `, p.${f.page}` : ''}`;
    if (f.path.startsWith('publication.')) { pub[f.path.split('.')[1]] = f.value; continue; }
    let value = f.value;
    if (/LatNorth|LongEast|Altitude|WaterDepth/.test(f.path)) {
      const n = parseFloat(value);
      if (Number.isNaN(n)) continue;
      value = n;
    }
    addCandidate(state, f.path, { value, source: src, confidence: 0.85, snippet: f.quote, ai: true });
  }
  const authors = out.authors.map((a) => {
    const c = splitName(`${a.family}, ${a.given}`);
    if (c && a.email) c.Email = a.email;
    if (c && a.affiliation) c.affiliations = [a.affiliation];
    // an iD Claude read off the page is treated like any printed iD: checksum, then verified against the record
    const id = normalizeOrcid(a.orcid);
    if (id && orcidChecksumOK(id)) {
      const os = (state.orcidSources ||= { affiliations: [], printed: [] });
      if (!os.printed.some((x) => x.id === id)) os.printed.push({ id, source: `Claude · ${fileName}` });
    }
    return c;
  }).filter(Boolean);
  if (authors.length) pub.authors = authors;
  if (Object.keys(pub).length) addPublication(state, pub, `✦ Claude · ${fileName}`);
  authors.forEach((a) => { const c = addContact(state, a, 'Author', fileName); if (a.Email && !c.Email) c.Email = a.Email; });
  // new evidence: re-check anyone not settled by strong evidence or by the user
  state.contacts.forEach((c) => { if (c.orcid && !c.orcid.userPicked && c.orcid.status !== 'confirmed') c.orcid.checked = 0; });
  addDates(state, out.dates.map((d) => ({ ...d, source: `✦ Claude · ${fileName}${d.page ? `, p.${d.page}` : ''}` })));
  if (out.notes) state.notes.push(`Claude (${fileName}): ${out.notes}`);
}

// ---------- rendering ----------
function renderAll() {
  renderSources();
  renderTabs();
  renderReview();
  refreshExport();
}

function renderSources() {
  const ul = $('#sources');
  ul.replaceChildren(...state.sources.map((s) => h('li', {},
    h('span', { class: `kind ${s.kind}` }, s.kind === 'spreadsheet' ? 'data' : s.kind),
    h('div', {},
      h('div', { class: 'name' }, s.name),
      h('div', { class: `detail ${s.status === 'error' ? 'err' : ''}` }, s.status === 'reading' ? h('span', { class: 'spin' }) : null, s.detail || '')),
    h('button', {
      class: 'icon ghost', title: 'Remove from list', 'aria-label': `Remove ${s.name}`,
      onclick: () => { state.sources = state.sources.filter((x) => x !== s); rawInputs.delete(s.id); renderSources(); persist(); },
    }, '×'),
  )));
}

const TABS = [
  ['site', 'Site'], ['collectionUnit', 'Collection unit'], ['dataset', 'Dataset'], ['data', 'Data'],
  ['publications', 'Publications'], ['contacts', 'Contacts'], ['geochron', 'Dates'],
];

function renderTabs() {
  const issues = validate(toRecord(state));
  const bad = {
    site: issues.some((i) => i.level === 'error' && /Site/.test(i.msg)),
    dataset: issues.some((i) => i.level === 'error' && /Dataset type/.test(i.msg)),
    data: issues.some((i) => i.level === 'error' && /variable|Samples/.test(i.msg)),
  };
  const counts = {
    data: state.datasets[state.activeDataset]?.variables.filter((v) => v.include).length,
    publications: state.publications.length, contacts: state.contacts.length, geochron: state.geochron.length,
  };
  $('#tabs').replaceChildren(...TABS.map(([id, label]) => h('button', {
    role: 'tab', 'aria-selected': String(activeTab === id), onclick: () => { activeTab = id; renderTabs(); renderReview(); },
  }, label, counts[id] ? h('span', { class: 'count' }, counts[id]) : null, bad[id] ? h('span', { class: 'dot', title: 'Needs attention' }) : null)));
}

function renderReview() {
  const root = $('#review');
  const panel = h('div', { class: 'panel' });
  if (activeTab === 'site') renderSite(panel);
  else if (activeTab === 'collectionUnit' || activeTab === 'dataset') panel.append(fieldGrid(activeTab));
  else if (activeTab === 'data') renderData(panel);
  else if (activeTab === 'publications') renderPubs(panel);
  else if (activeTab === 'contacts') renderContacts(panel);
  else if (activeTab === 'geochron') renderDates(panel);
  if (activeTab === 'dataset' && state.notes.length) {
    panel.append(h('h3', {}, 'Conversion notes'), h('ul', { class: 'notes' }, state.notes.map((n) => h('li', {}, n))));
  }
  root.replaceChildren(panel);
  if (activeTab === 'site') initMap();
}

function fieldGrid(section, only) {
  const grid = h('div', { class: 'grid' });
  for (const [key, label, type = 'text', placeholder] of FIELD_DEFS[section]) {
    if (only && !only.includes(key)) continue;
    grid.append(fieldEl(`${section}.${key}`, label, type, placeholder));
  }
  return grid;
}

function fieldEl(path, label, type, placeholder) {
  const value = state.values[path] ?? '';
  const cands = state.candidates[path] || [];
  const onInput = (v) => { setValue(state, path, v); if (path === 'dataset.DatasetType') { pickDataset(state); applyAgeModel(state); applyTypeDefaults(state); } refreshExport(); persist(); updateProv(); };
  const onCommit = () => {
    if (path === 'site.SiteName') siteChosen(state.values[path]);
    if (path === 'site.LatNorth' || path === 'site.LongEast') scheduleGeocode();
  };
  let input;
  const listId = `dl-${path.replace('.', '-')}`;
  const options = { datasetType: DATASET_TYPES, collectionType: COLLECTION_TYPES, depenv: DEPOSITIONAL_ENVIRONMENTS }[type];
  if (type === 'textarea') input = h('textarea', { rows: 3, oninput: (e) => onInput(e.target.value) }, String(value));
  else if (type === 'checkbox') input = h('input', { type: 'checkbox', checked: !!value, onchange: (e) => onInput(e.target.checked) });
  else {
    input = h('input', {
      type: type === 'number' ? 'text' : 'text', inputmode: type === 'number' ? 'decimal' : null,
      value: String(value), placeholder: placeholder || (options ? 'Choose or type…' : ''), list: options ? listId : null,
      oninput: (e) => onInput(type === 'number' && e.target.value !== '' && !Number.isNaN(Number(e.target.value)) ? Number(e.target.value) : e.target.value),
      onchange: onCommit,
    });
  }
  input.id = `f-${path}`;
  const prov = h('div', { class: 'prov' });
  const snip = h('div', { class: 'snip' });
  function updateProv() {
    const cur = state.values[path];
    const c = cands.find((x) => String(x.value) === String(cur));
    prov.replaceChildren();
    if (state.edited[path] && !c) prov.append(h('span', { class: 'src edited' }, 'Edited by you'));
    else if (c) prov.append(h('span', { class: 'conf', title: `confidence ${Math.round(c.confidence * 100)}%` }, h('i', { style: `width:${Math.round(c.confidence * 100)}%` })), h('span', { class: `src ${c.ai ? 'ai' : ''}`, title: c.source }, c.source.replace(/^✦ /, '')));
    for (const alt of cands.filter((x) => String(x.value) !== String(cur)).slice(0, 3)) {
      prov.append(h('button', {
        type: 'button', class: `chip ${alt.ai ? 'ai' : ''}`, title: `${alt.source}${alt.snippet ? '\n“' + alt.snippet + '”' : ''}`,
        onclick: () => {
          setValue(state, path, alt.value); state.edited[path] = path === 'site.SiteName';
          renderReview(); refreshExport(); persist(); onCommit();
        },
      }, String(alt.value)));
    }
    snip.textContent = c?.snippet ? `“${c.snippet}”` : '';
  }
  updateProv();
  const wide = type === 'textarea';
  return h('div', { class: `fld ${wide ? 'wide' : ''} ${value === '' ? 'empty' : ''}` },
    h('label', { for: input.id }, h('span', {}, label)),
    input,
    options ? h('datalist', { id: listId }, options.map((o) => h('option', { value: o }))) : null,
    prov, snip,
  );
}

// ----- Site tab with map -----
function renderSite(panel) {
  panel.append(fieldGrid('site', ['SiteName', 'LatNorth', 'LongEast', 'Altitude', 'Country', 'State', 'County']));
  const alt = h('div', { class: 'alt-coords' });
  if (state.altCoords?.length > 1) {
    alt.append(h('span', { class: 'map-note' }, 'Other coordinates in the text: '));
    state.altCoords.slice(0, 6).forEach((c) => alt.append(h('button', {
      class: 'chip', type: 'button', title: `${c.raw}${c.page ? ` (p.${c.page})` : ''}`,
      onclick: () => { setCoords(c.lat, c.lon); renderReview(); },
    }, `${c.lat}, ${c.lon}`)));
  }
  panel.append(h('div', { id: 'map' }), h('p', { class: 'map-note' }, 'Drag the marker or click the map to adjust the coordinates.'), alt);
  panel.append(fieldGrid('site', ['SiteDescription', 'Notes']));
}

function setCoords(lat, lon) {
  setValue(state, 'site.LatNorth', Math.round(lat * 1e5) / 1e5);
  setValue(state, 'site.LongEast', Math.round(lon * 1e5) / 1e5);
  const a = document.getElementById('f-site.LatNorth'), b = document.getElementById('f-site.LongEast');
  if (a) a.value = state.values['site.LatNorth'];
  if (b) b.value = state.values['site.LongEast'];
  refreshExport();
  persist();
  scheduleGeocode();
}

function loadLeaflet() {
  if (window.L) return Promise.resolve(window.L);
  return (loadLeaflet.p ||= new Promise((resolve, reject) => {
    document.head.append(h('link', { rel: 'stylesheet', href: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css' }));
    const s = h('script', { src: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js' });
    s.onload = () => resolve(window.L);
    s.onerror = reject;
    document.head.append(s);
  }));
}

async function initMap() {
  const el = document.getElementById('map');
  if (!el) return;
  let L;
  try { L = await loadLeaflet(); } catch { el.textContent = 'Map could not load (offline?).'; return; }
  if (!document.body.contains(el)) return;
  const lat = parseFloat(state.values['site.LatNorth']), lon = parseFloat(state.values['site.LongEast']);
  const has = !Number.isNaN(lat) && !Number.isNaN(lon);
  map = L.map(el, { scrollWheelZoom: false }).setView(has ? [lat, lon] : [30, 0], has ? 9 : 2);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 18, attribution: '© OpenStreetMap contributors' }).addTo(map);
  const place = (ll) => {
    if (!marker) {
      marker = L.marker(ll, { draggable: true }).addTo(map);
      marker.on('dragend', () => { const p = marker.getLatLng(); setCoords(p.lat, p.lng); });
    } else marker.setLatLng(ll);
  };
  marker = null;
  if (has) place([lat, lon]);
  map.on('click', (e) => { place(e.latlng); setCoords(e.latlng.lat, e.latlng.lng); });
  for (const id of ['f-site.LatNorth', 'f-site.LongEast']) {
    document.getElementById(id)?.addEventListener('change', () => {
      const a = parseFloat(state.values['site.LatNorth']), b = parseFloat(state.values['site.LongEast']);
      if (!Number.isNaN(a) && !Number.isNaN(b)) { place([a, b]); map.setView([a, b], Math.max(map.getZoom(), 8)); }
    });
  }
}

// ----- Data tab -----
function renderData(panel) {
  if (!state.datasets.length) {
    panel.append(h('div', { class: 'empty-state' }, h('strong', {}, 'No data yet'), 'Add a spreadsheet with your counts or measurements (samples as rows or columns), or a vertebrate paper with “Material and provenience” sections — specimens are tallied by zone automatically.'));
    return;
  }
  const ds = state.datasets[state.activeDataset];
  const tools = h('div', { class: 'tbl-tools' });
  if (state.datasets.length > 1) {
    tools.append(h('label', { class: 'field', style: 'margin:0;min-width:260px' }, h('span', {}, 'Sheet to use'),
      h('select', { onchange: (e) => { state.activeDataset = Number(e.target.value); state.datasetChosen = true; applyAgeModel(state); applyTypeDefaults(state); renderAll(); persist(); } },
        state.datasets.map((d, i) => h('option', { value: i, selected: i === state.activeDataset }, `${d.source} — ${d.samples.length}×${d.variables.length}`)))));
  }
  panel.append(tools);

  const depths = ds.samples.map((s) => s.depth).filter((d) => d != null);
  const ages = ds.samples.map((s) => s.age).filter((d) => d != null);
  const fmt = (n) => (Math.round(n * 10) / 10).toLocaleString();
  panel.append(h('div', { class: 'stats' },
    h('div', { class: 'stat' }, h('b', {}, ds.samples.length), h('span', {}, 'samples')),
    h('div', { class: 'stat' }, h('b', {}, ds.variables.filter((v) => v.include).length, h('small', { style: 'font-size:12px;color:var(--faint)' }, ` / ${ds.variables.length}`)), h('span', {}, 'variables included')),
    depths.length ? h('div', { class: 'stat' }, h('b', {}, `${fmt(Math.min(...depths))}–${fmt(Math.max(...depths))}`), h('span', {}, 'depth (cm)')) : null,
    ages.length ? h('div', { class: 'stat' }, h('b', {}, `${fmt(Math.min(...ages))}–${fmt(Math.max(...ages))}`), h('span', {}, 'age')) : null,
    h('div', { class: 'stat' }, h('b', {}, ds.variables.filter((v) => v.lookup).length), h('span', {}, 'matched to Neotoma taxa')),
    h('div', { class: 'stat' }, h('b', { style: 'font-size:13px;padding:3px 0' }, ds.layout === 'specimens-from-text' ? 'specimens in paper' : ds.layout === 'samples-as-rows' ? 'samples = rows' : 'samples = columns'), h('span', {}, 'layout detected')),
  ));
  if (ds.roles && Object.keys(ds.roles).length) {
    panel.append(h('p', { class: 'muted' }, 'Sample columns recognised: ', Object.entries(ds.roles).map(([k, v]) => `${k} ← “${v}”`).join(', ')));
  }

  // variables table
  const setAll = (on) => { ds.variables.forEach((v) => { v.include = on; }); renderAll(); persist(); };
  panel.append(h('div', { class: 'tbl-tools' }, h('h3', { style: 'margin:0' }, 'Variables'), h('span', { class: 'spacer' }),
    h('button', { class: 'small', onclick: () => setAll(true) }, 'Include all'), h('button', { class: 'small', onclick: () => setAll(false) }, 'Exclude all')));
  const groupList = h('datalist', { id: 'dl-groups' }, GROUPS.map((g) => h('option', { value: g })));
  const edit = (v, k) => (e) => { v[k] = e.target.value; (v._edited ||= {})[k] = true; refreshExport(); persist(); };
  const rows = ds.variables.map((v) => {
    const vals = v.values.filter((x) => x != null);
    const tr = h('tr', { class: v.include ? '' : 'off', title: v.excludeReason || '' },
      h('td', {}, h('input', { type: 'checkbox', checked: v.include, 'aria-label': `Include ${v.name}`, onchange: (e) => { v.include = e.target.checked; tr.className = v.include ? '' : 'off'; renderTabs(); refreshExport(); persist(); } })),
      h('td', {}, h('input', { value: v.code || '', oninput: edit(v, 'code'), style: 'width:80px', placeholder: 'auto', title: v.lookup ? 'Code from the Neotoma taxon lookup' : 'No lookup match — a provisional code is generated' })),
      h('td', {}, h('div', { class: 'name-cell' }, h('input', { value: v.name, oninput: edit(v, 'name'), onchange: () => { if (!v._edited?.code) v._autoCode = true; applyTypeDefaults(state); renderReview(); refreshExport(); }, style: 'min-width:170px' }),
        v.lookup ? h('span', { class: 'lk', title: 'Matched in the lab’s Neotoma taxon lookup' }, '✓') : null)),
      h('td', {}, h('input', { value: v.element || '', oninput: edit(v, 'element'), style: 'width:110px' })),
      h('td', {}, h('input', { value: v.units || '', oninput: edit(v, 'units'), style: 'width:110px' })),
      h('td', {}, h('input', { value: v.group || '', list: 'dl-groups', oninput: edit(v, 'group'), style: 'width:80px', placeholder: '—' })),
      h('td', { class: 'num' }, vals.length),
      h('td', { class: 'num' }, vals.length ? fmt(Math.max(...vals)) : ''),
      h('td', { style: 'color:var(--faint);font-size:12px' }, v.rawLabel !== v.name ? v.rawLabel : ''),
    );
    return tr;
  });
  panel.append(groupList, h('div', { class: 'tbl-wrap' }, h('table', {},
    h('thead', {}, h('tr', {}, ['', 'Code', 'Name', 'Element', 'Units', 'Group', 'n', 'max', 'original label'].map((t) => h('th', {}, t)))),
    h('tbody', {}, rows))));

  // samples preview
  panel.append(h('h3', {}, 'Samples'));
  const sEdit = (s, k, num) => (e) => { const v = e.target.value; s[k] = num ? (v === '' ? null : Number(v)) : v; refreshExport(); persist(); };
  panel.append(h('div', { class: 'tbl-wrap', style: 'max-height:320px' }, h('table', {},
    h('thead', {}, h('tr', {}, ['#', 'Depth (cm)', 'Thickness', 'Analysis unit / name', 'Age', 'Analyst'].map((t) => h('th', {}, t)))),
    h('tbody', {}, ds.samples.map((s, i) => h('tr', {},
      h('td', { class: 'num' }, i + 1),
      h('td', {}, h('input', { value: s.depth ?? '', inputmode: 'decimal', oninput: sEdit(s, 'depth', true), style: 'width:90px' })),
      h('td', {}, h('input', { value: s.thickness ?? '', inputmode: 'decimal', oninput: sEdit(s, 'thickness', true), style: 'width:80px' })),
      h('td', {}, h('input', { value: s.name || '', oninput: sEdit(s, 'name'), style: 'min-width:140px' })),
      h('td', {}, h('input', { value: s.age ?? '', inputmode: 'decimal', oninput: sEdit(s, 'age', true), style: 'width:90px' })),
      h('td', {}, h('input', { value: s.analyst || '', oninput: sEdit(s, 'analyst'), style: 'min-width:120px' })),
    ))))));
}

// ----- Publications -----
function renderPubs(panel) {
  if (!state.publications.length) panel.append(h('div', { class: 'empty-state' }, h('strong', {}, 'No publications yet'), 'Add a PDF, a RIS/BibTeX file, or paste a DOI on the left.'));
  state.publications.forEach((p, i) => {
    const cite = h('div', { class: 'cite' }, p.Citation || '');
    const upd = (k) => (e) => { p[k] = e.target.value; if (k !== 'Citation') { p.Citation = formatCitation(p); cite.textContent = p.Citation; } refreshExport(); persist(); };
    const inp = (k, label, wide) => h('div', { class: `fld ${wide ? 'wide' : ''}` }, h('label', {}, label), h('input', { value: p[k] ?? '', oninput: upd(k) }));
    panel.append(h('div', { class: 'pub' },
      h('div', { class: 'pub-head' }, h('span', { class: 'muted', style: 'margin:0;font-size:12px' }, `From ${p.source}`),
        h('button', { class: 'small ghost danger', onclick: () => { state.publications.splice(i, 1); renderAll(); persist(); } }, 'Remove')),
      h('div', { class: 'grid' },
        inp('ArticleTitle', 'Title', true), inp('Journal', 'Journal'), inp('Year', 'Year'), inp('Volume', 'Volume'), inp('Issue', 'Issue'),
        inp('Pages', 'Pages'), inp('DOI', 'DOI'),
        h('div', { class: 'fld' }, h('label', {}, 'Type'), h('select', { onchange: upd('PubType') },
          ['journal article', 'book chapter', 'authored book', 'edited book', 'doctoral thesis', "master's thesis", 'authored report', 'edited report', 'legacy'].map((t) => h('option', { selected: pubType(p.PubType) === t }, t)))),
        h('div', { class: 'fld wide' }, h('label', {}, 'Authors (one per line: Family, Given)'),
          h('textarea', { rows: 2, onchange: (e) => {
            p.authors = e.target.value.split('\n').map((s) => splitName(s)).filter(Boolean);
            p.authors.forEach((a) => addContact(state, a, 'Author', 'publication'));
            p.Citation = formatCitation(p); renderAll(); persist();
          } }, (p.authors || []).map((a) => a.FullContactName).join('\n'))),
      ),
      cite));
  });
}

// ----- Contacts -----
function renderContacts(panel) {
  const tools = h('div', { class: 'tbl-tools' }, h('span', { class: 'muted', style: 'margin:0' }, 'Roles decide where each person appears in the file (Investigator & Processor → Dataset, Collector → Collection unit). The chosen ORCID iD is written to the contact’s URL.'),
    h('span', { class: 'spacer' }),
    h('button', { class: 'small', disabled: orcidRunning || !state.contacts.length, onclick: () => runOrcid(true) }, orcidRunning ? 'Searching…' : 'Find ORCID iDs'),
    h('button', { class: 'small', onclick: () => { state.contacts.push({ FullContactName: '', FamilyName: '', GivenNames: '', roles: ['Investigator'], source: 'added by you' }); renderAll(); persist(); } }, '+ Add contact'));
  panel.append(tools, h('p', { class: 'status', id: 'orcid-status', style: 'margin:-4px 0 10px' }, orcidStatus));
  if (!state.contacts.length) { panel.append(h('div', { class: 'empty-state' }, h('strong', {}, 'No contacts yet'), 'Authors are added automatically from publications.')); return; }
  const upd = (c, k) => (e) => {
    c[k] = e.target.value;
    if (k === 'FamilyName' || k === 'GivenNames') {
      const n = splitName(c.GivenNames ? `${c.FamilyName}, ${c.GivenNames}` : c.FamilyName);
      if (n) Object.assign(c, { FullContactName: n.FullContactName, ShortContactName: n.ShortContactName, LeadingInitials: n.LeadingInitials });
      if (c.orcid && !c.orcid.userPicked) c.orcid = null; // name changed: look it up again
    }
    refreshExport(); persist();
  };
  const rows = [];
  state.contacts.forEach((c, i) => {
    rows.push(h('tr', {},
      h('td', {}, h('input', { value: c.FamilyName || '', oninput: upd(c, 'FamilyName'), onchange: () => { if ($('#opt-orcid').checked) scheduleOrcid(); }, style: 'min-width:120px' })),
      h('td', {}, h('input', { value: c.GivenNames || '', oninput: upd(c, 'GivenNames'), onchange: () => { if ($('#opt-orcid').checked) scheduleOrcid(); }, style: 'min-width:120px' })),
      h('td', {}, h('input', { value: c.Email || '', oninput: upd(c, 'Email'), style: 'min-width:170px' })),
      h('td', {}, orcidCell(c)),
      h('td', {}, h('div', { class: 'roles' }, ROLES.map((r) => h('label', {}, h('input', {
        type: 'checkbox', checked: (c.roles || []).includes(r),
        onchange: (e) => { c.roles = e.target.checked ? [...(c.roles || []), r] : c.roles.filter((x) => x !== r); refreshExport(); persist(); },
      }), r)))),
      h('td', {}, h('button', { class: 'icon ghost danger', 'aria-label': 'Remove contact', onclick: () => { state.contacts.splice(i, 1); openOrcid.delete(c); renderAll(); persist(); } }, '×')),
    ));
    if (openOrcid.has(c)) rows.push(h('tr', { class: 'orcid-row' }, h('td', { colspan: 6 }, orcidOptions(c))));
  });
  panel.append(h('div', { class: 'tbl-wrap' }, h('table', {},
    h('thead', {}, h('tr', {}, ['Family name', 'Given names', 'Email', 'ORCID iD', 'Roles', ''].map((t) => h('th', {}, t)))),
    h('tbody', {}, rows))));
}

const confClass = (score) => (score >= 0.9 ? 'hi' : score >= 0.7 ? 'mid' : 'lo');
const toggleOrcid = (c) => { if (openOrcid.has(c)) openOrcid.delete(c); else openOrcid.add(c); renderReview(); };

function orcidCell(c) {
  const o = c.orcid;
  if (!o) return h('span', { class: 'faint' }, orcidRunning ? 'checking…' : '—');
  if (o.status === 'error') return h('span', { class: 'faint', title: o.error }, 'lookup failed');
  const sel = o.selected && o.candidates.find((x) => x.id === o.selected);
  if (o.selected) {
    const score = o.userPicked ? null : sel?.score;
    return h('div', { class: 'orcid-cell' },
      h('a', { href: `https://orcid.org/${o.selected}`, target: '_blank', rel: 'noopener', class: 'mono' }, o.selected),
      h('button', { class: `badge ${score == null ? 'user' : confClass(score)}`, title: 'Show evidence and alternatives', onclick: () => toggleOrcid(c) },
        score == null ? 'chosen by you' : `${confidenceLabel(score)} · ${Math.round(score * 100)}%`));
  }
  if (o.status === 'ambiguous') {
    return h('button', { class: 'badge lo', onclick: () => toggleOrcid(c) }, `${o.candidates.length} possible — choose`);
  }
  return h('button', { class: 'badge none', onclick: () => toggleOrcid(c) }, o.status === 'rejected' ? 'none chosen' : 'not found');
}

function orcidOptions(c) {
  const o = c.orcid || { candidates: [] };
  const choose = (id) => { c.orcid = { ...o, selected: id, userPicked: true, status: id ? 'chosen' : 'rejected', checked: o.checked || Date.now() }; openOrcid.delete(c); renderAll(); persist(); };
  const manual = h('input', { placeholder: '0000-0000-0000-0000', style: 'width:190px', 'aria-label': `Enter ORCID iD for ${c.FullContactName}` });
  const box = h('div', { class: 'orcid-options' });
  if (o.candidates.length) {
    box.append(h('p', { class: 'muted', style: 'margin:0 0 8px' },
      o.status === 'ambiguous' ? `No single clear match for ${c.FullContactName || c.FamilyName}. Pick the right person, or none:` : `Evidence for ${c.FullContactName || c.FamilyName}:`));
    for (const cand of o.candidates) {
      const isSel = cand.id === o.selected;
      box.append(h('div', { class: `cand ${isSel ? 'sel' : ''}` },
        h('div', { class: 'cand-head' },
          h('span', { class: `badge ${confClass(cand.score)}` }, `${confidenceLabel(cand.score)} · ${Math.round(cand.score * 100)}%`),
          h('strong', {}, `${cand.given} ${cand.family}`.trim()),
          h('a', { href: `https://orcid.org/${cand.id}`, target: '_blank', rel: 'noopener', class: 'mono' }, cand.id),
          h('span', { class: 'spacer' }),
          isSel ? h('span', { class: 'faint' }, '✓ selected') : h('button', { class: 'small', onclick: () => choose(cand.id) }, 'Use this')),
        cand.institutions?.length ? h('div', { class: 'faint' }, cand.institutions.slice(0, 3).join(' · ') + (cand.institutions.length > 3 ? ` · +${cand.institutions.length - 3} more` : '')) : null,
        h('ul', { class: 'evidence' }, cand.evidence.map((e) => h('li', {}, e)))));
    }
  } else {
    box.append(h('p', { class: 'muted', style: 'margin:0 0 8px' }, `No ORCID record found for ${c.FullContactName || c.FamilyName}.`));
  }
  const hint = h('input', { value: (c.affiliations || []).join('; '), placeholder: 'e.g. University of Wisconsin-Madison', style: 'width:260px', 'aria-label': 'Affiliation hint' });
  box.append(h('div', { class: 'cand-foot' },
    h('span', { class: 'faint' }, 'Affiliation hint:'), hint,
    h('button', { class: 'small', onclick: () => {
      c.affiliations = hint.value.split(';').map((x) => x.trim()).filter(Boolean);
      c.orcid = null;
      openOrcid.add(c);
      runOrcid(false);
      renderReview();
    } }, 'Search again')));
  box.append(h('div', { class: 'cand-foot' },
    o.selected || o.status === 'ambiguous' ? h('button', { class: 'small', onclick: () => choose(null) }, 'None of these') : null,
    h('span', { class: 'faint' }, 'or enter one:'), manual,
    h('button', { class: 'small', onclick: () => {
      const id = normalizeOrcid(manual.value);
      if (!id || !orcidChecksumOK(id)) { toast('That is not a valid ORCID iD (checksum failed)'); return; }
      if (!o.candidates.some((x) => x.id === id)) o.candidates = [{ id, given: c.GivenNames, family: c.FamilyName, institutions: [], score: 1, evidence: ['Entered by you'] }, ...o.candidates];
      choose(id);
    } }, 'Set'),
    h('span', { class: 'spacer' }),
    h('button', { class: 'small ghost', onclick: () => toggleOrcid(c) }, 'Close')));
  return box;
}

// ----- Dates -----
function renderDates(panel) {
  panel.append(h('div', { class: 'tbl-tools' },
    h('span', { class: 'muted', style: 'margin:0' }, 'Radiometric dates found in publications or date sheets. Ages are as reported (usually uncalibrated ¹⁴C yr BP).'),
    h('span', { class: 'spacer' }),
    h('button', { class: 'small', onclick: () => { state.geochron.push({ labNumber: '', age: null, error: null, depth: null, thickness: null, material: '', method: 'Carbon-14', source: 'added by you' }); renderAll(); persist(); } }, '+ Add date')));
  if (!state.geochron.length) { panel.append(h('div', { class: 'empty-state' }, h('strong', {}, 'No dates found'), 'Lab numbers such as Beta-123456 followed by an age ± error are picked up automatically.')); return; }
  const upd = (g, k, num) => (e) => { const v = e.target.value; g[k] = num ? (v === '' ? null : Number(v)) : v; refreshExport(); persist(); };
  const cols = [['labNumber', 'Lab number', 0, 120], ['depth', 'Depth (cm)', 1, 80], ['thickness', 'Thick.', 1, 60], ['age', 'Age', 1, 80], ['error', '±', 1, 60], ['material', 'Material', 0, 130], ['method', 'Method', 0, 100]];
  panel.append(h('div', { class: 'tbl-wrap' }, h('table', {},
    h('thead', {}, h('tr', {}, [...cols.map((c) => c[1]), 'Source', ''].map((t) => h('th', {}, t)))),
    h('tbody', {}, state.geochron.map((g, i) => h('tr', { title: g.raw || '' },
      cols.map(([k, , num, w]) => h('td', {}, h('input', { value: g[k] ?? '', inputmode: num ? 'decimal' : null, oninput: upd(g, k, num), style: `width:${w}px` }))),
      h('td', { style: 'font-size:12px;color:var(--faint)' }, (g.source || '').replace(/^✦ /, '✦ ')),
      h('td', {}, h('button', { class: 'icon ghost danger', 'aria-label': 'Remove date', onclick: () => { state.geochron.splice(i, 1); renderAll(); persist(); } }, '×')),
    ))))));
}

// ---------- export ----------
let exportTimer;
function refreshExport() {
  clearTimeout(exportTimer);
  exportTimer = setTimeout(() => {
    const rec = toRecord(state);
    const issues = validate(rec);
    $('#issues').replaceChildren(...(issues.length ? issues : [{ level: 'ok', msg: 'Ready to export.' }])
      .map((i) => h('li', { class: i.level }, h('span', {}, i.level === 'error' ? '●' : i.level === 'warn' ? '▲' : '✓'), i.msg)));
    const xml = currentXML();
    const pre = $('#xml');
    pre.textContent = xml.length > 200000 ? xml.slice(0, 200000) + '\n… (truncated in preview; the download is complete)' : xml;
    renderTabs();
  }, 120);
}

function currentXML() {
  return buildTilia(toRecord(state), {
    includeAges: $('#opt-ages').checked,
    includeAgeRanges: $('#opt-agerange').checked,
  });
}

const safeName = () => (state.values['collectionUnit.Handle'] || state.values['site.SiteName'] || 'tilia').toString().replace(/[^\w.-]+/g, '_');

function csvEscape(v) { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; }

// ---------- sample data ----------
async function loadSample() {
  const files = [];
  for (const name of ['example-pollen-counts.csv', 'example-site-metadata.csv', 'example-publication.txt']) {
    const res = await fetch(`samples/${name}`);
    if (!res.ok) { toast('Could not load sample files'); return; }
    files.push(new File([await res.blob()], name));
  }
  await handleFiles(files);
  toast('Sample data loaded — have a look through the tabs');
}

// ---------- wire up ----------
function init() {
  restore();
  $('#ai-model').replaceChildren(...MODELS.map(([id, label]) => h('option', { value: id }, label)));
  try {
    const k = localStorage.getItem(KEY_KEY);
    if (k) { $('#ai-key').value = k; $('#ai-remember').checked = true; }
  } catch { /* ignore */ }
  $('#opt-ages').checked = state.options.includeAges !== false;
  $('#opt-agerange').checked = !!state.options.includeAgeRanges;

  const fileInput = $('#file-input');
  fileInput.addEventListener('change', () => { handleFiles([...fileInput.files]); fileInput.value = ''; });
  const drop = $('#drop');
  ['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
  drop.addEventListener('drop', (e) => handleFiles([...e.dataTransfer.files]));
  document.addEventListener('dragover', (e) => e.preventDefault());
  document.addEventListener('drop', (e) => { if (!drop.contains(e.target)) { e.preventDefault(); handleFiles([...e.dataTransfer.files]); } });

  $('#opt-orcid').addEventListener('change', (e) => { if (e.target.checked) scheduleOrcid(); });
  $('#opt-geocode').addEventListener('change', (e) => { if (e.target.checked) scheduleGeocode(); });
  $('#doi-form').addEventListener('submit', (e) => { e.preventDefault(); const v = $('#doi-input').value; if (v.trim()) { addDOI(v); $('#doi-input').value = ''; } });
  $('#ai-run').addEventListener('click', runClaude);

  for (const [id, key] of [['#opt-ages', 'includeAges'], ['#opt-agerange', 'includeAgeRanges']]) {
    $(id).addEventListener('change', (e) => { state.options[key] = e.target.checked; refreshExport(); persist(); });
  }

  $('#btn-tlx').addEventListener('click', () => {
    const errors = validate(toRecord(state)).filter((i) => i.level === 'error');
    if (errors.length && !confirm(`There ${errors.length === 1 ? 'is 1 problem' : `are ${errors.length} problems`} Tilia may complain about:\n\n• ${errors.map((e) => e.msg).join('\n• ')}\n\nDownload anyway?`)) return;
    download(`${safeName()}.tlx`, currentXML());
  });
  $('#btn-copy').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(currentXML()); toast('XML copied'); } catch { toast('Copy failed — use the preview below'); }
  });
  $('#btn-contacts').addEventListener('click', () => {
    if (!state.contacts.length) { toast('No contacts to export'); return; }
    const head = ['FullContactName', 'FamilyName', 'GivenNames', 'Email', 'Roles', 'ORCID', 'ORCID confidence', 'ORCID status', 'ORCID evidence', 'Other candidates'];
    const lines = state.contacts.map((c) => {
      const o = c.orcid || {};
      const sel = o.candidates?.find((x) => x.id === o.selected);
      const others = (o.candidates || []).filter((x) => x.id !== o.selected).map((x) => `${x.id} (${Math.round(x.score * 100)}%)`).join('; ');
      return [c.FullContactName, c.FamilyName, c.GivenNames, c.Email, (c.roles || []).join('; '), o.selected || '',
        sel && !o.userPicked ? Math.round(sel.score * 100) + '%' : (o.userPicked && o.selected ? 'chosen by user' : ''),
        o.status || 'not checked', sel ? sel.evidence.join('; ') : '', others].map(csvEscape).join(',');
    });
    download(`${safeName()}_contacts.csv`, [head.join(','), ...lines].join('\n'), 'text/csv');
  });
  $('#btn-dates').addEventListener('click', () => {
    if (!state.geochron.length) { toast('No dates to export'); return; }
    const cols = ['labNumber', 'depth', 'thickness', 'age', 'error', 'material', 'method', 'source'];
    download(`${safeName()}_dates.csv`, [cols.join(','), ...state.geochron.map((g) => cols.map((c) => csvEscape(g[c])).join(','))].join('\n'), 'text/csv');
  });
  $('#btn-report').addEventListener('click', () => {
    const rep = { generated: new Date().toISOString(), sources: state.sources, chosen: state.values, editedByUser: Object.keys(state.edited).filter((k) => state.edited[k]), candidates: state.candidates, contacts: state.contacts, notes: state.notes, issues: validate(toRecord(state)) };
    download(`${safeName()}_extraction-report.json`, JSON.stringify(rep, null, 2), 'application/json');
  });
  $('#btn-save').addEventListener('click', () => download(`${safeName()}_project.json`, JSON.stringify(state), 'application/json'));
  $('#btn-load').addEventListener('click', () => $('#project-input').click());
  $('#project-input').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    try { state = { ...emptyState(), ...JSON.parse(await f.text()) }; renderAll(); persist(); toast('Project opened'); } catch { toast('That file is not a Tilia Converter project'); }
    e.target.value = '';
  });
  $('#btn-reset').addEventListener('click', () => {
    if (!confirm('Clear all sources and extracted values?')) return;
    state = emptyState(); rawInputs.clear(); pubTexts.clear(); activeTab = 'site';
    try { localStorage.removeItem(STORE_KEY); } catch { /* ignore */ }
    renderAll();
  });
  $('#btn-sample').addEventListener('click', loadSample);

  renderAll();
}

init();
