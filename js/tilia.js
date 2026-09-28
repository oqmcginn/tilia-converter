// Builds a Tilia .tlx (XML) document from the reviewed record.
//
// Structure, element names and element order follow files saved by Tilia 3.0.3
// (the lab's hand-converted examples): Version, Contacts, Publications,
// SpreadSheetBook, Site, CollectionUnit, Datasets, GeochronDataset, AgeModels.

const esc = (v) => String(v)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&apos;');

class XW {
  constructor() { this.out = ['<?xml version="1.0" encoding="UTF-8" standalone="yes"?>', `<!--written by Tilia Converter ${new Date().toISOString().slice(0, 10)}-->`]; }
  open(tag, attrs = {}) { this.out.push(`<${tag}${attrStr(attrs)}>`); }
  close(tag) { this.out.push(`</${tag}>`); }
  leaf(tag, value, attrs = {}) {
    if (value == null || value === '') return;
    this.out.push(`<${tag}${attrStr(attrs)}>${esc(value)}</${tag}>`);
  }
  empty(tag, attrs = {}) { this.out.push(`<${tag}${attrStr(attrs)}/>`); }
  toString() { return this.out.join('\n') + '\n'; }
}
const attrStr = (a) => Object.entries(a).filter(([, v]) => v != null).map(([k, v]) => ` ${k}="${esc(v)}"`).join('');

const fmtNum = (n) => (Number.isInteger(n) ? String(n) : String(Math.round(n * 1e6) / 1e6));
const num = (v) => (v === '' || v == null || Number.isNaN(Number(v)) ? null : Number(v));

// Tilia stores dates as day serials counted from 1899-12-30 (the spreadsheet convention).
// Partial dates use the 1st of the month / January, as in hand-entered files.
export function dateToSerial(value) {
  const m = String(value || '').match(/^(\d{4})(?:-(\d{1,2}))?(?:-(\d{1,2}))?/);
  if (!m) return null;
  const t = Date.UTC(Number(m[1]), (Number(m[2]) || 1) - 1, Number(m[3]) || 1);
  return Math.round((t - Date.UTC(1899, 11, 30)) / 864e5);
}

// One code per taxon: rows for the same taxon with different elements share it (as in
// hand-made vertebrate files: every Megalonyx row is "Mgx.je"). Lookup codes are kept;
// others are generated and never reused for a different taxon.
export function makeCodes(variables) {
  const byName = new Map();
  const used = new Set(variables.filter((v) => v.code).map((v) => v.code));
  return variables.map((v) => {
    const name = String(v.name);
    if (v.code) { if (!byName.has(name)) byName.set(name, v.code); return byName.get(name) === v.code ? v.code : byName.get(name); }
    if (byName.has(name)) return byName.get(name);
    const words = name.replace(/[^A-Za-z0-9 ]/g, ' ').trim().split(/\s+/).filter(Boolean);
    let base = words.length ? words[0].slice(0, 3) : 'Var';
    base = base[0].toUpperCase() + base.slice(1).toLowerCase();
    if (words[1]) base += '.' + words[1].slice(0, 2).toLowerCase();
    let code = base, i = 2;
    while (used.has(code)) code = `${base}${i++}`;
    used.add(code);
    byName.set(name, code);
    return code;
  });
}

const PUB_TYPES = { 'journal article': 1, 'book chapter': 1, 'authored book': 1, 'edited book': 1, 'doctoral thesis': 1, "master's thesis": 1, 'authored report': 1, 'edited report': 1, 'legacy': 1, 'other': 1 };
const LEGACY_PUB = { 'Journal Article': 'journal article', 'Book Chapter': 'book chapter', 'Authored Book': 'authored book', 'Edited Book': 'edited book', 'Dissertation or Thesis': 'doctoral thesis', 'Other Authored Report': 'authored report', 'Legacy': 'legacy' };
export const pubType = (t) => (PUB_TYPES[t] ? t : LEGACY_PUB[t] || 'journal article');
const capFirst = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);
const initialsOf = (c) => c.LeadingInitials || '';

export function buildTilia(record, options = {}) {
  const { site = {}, collectionUnit = {}, dataset = {}, contacts = [], publications = [], geochron = [], data } = record;
  const x = new XW();
  x.open('TiliaFile');

  x.open('Version');
  x.leaf('Application', 'Tilia');
  x.leaf('MajorVersion', '3');
  x.leaf('MinorVersion', '0');
  x.leaf('Release', '3');
  x.close('Version');

  // ---- Contacts ----
  const idByKey = new Map();
  const keyOf = (c) => `${(c.FamilyName || '').toLowerCase()}|${(initialsOf(c) || '').toLowerCase().replace(/[^a-z]/g, '').slice(0, 1)}`;
  x.open('Contacts');
  contacts.forEach((c, i) => {
    const id = i + 1;
    idByKey.set(keyOf(c), id);
    idByKey.set((c.FullContactName || '').toLowerCase(), id);
    x.open('Contact', { ID: id });
    for (const k of ['FullContactName', 'ShortContactName', 'FamilyName', 'GivenNames', 'LeadingInitials', 'Status', 'Title', 'Telephone', 'Email']) x.leaf(k, c[k]);
    // Tilia has no ORCID element; the chosen iD goes in the contact URL when that is free
    x.leaf('URL', c.URL || (c.orcid?.selected ? `https://orcid.org/${c.orcid.selected}` : ''));
    if (c.Address) { x.open('Address'); String(c.Address).split(/\n/).forEach((l) => x.leaf('AddressLine', l.trim())); x.close('Address'); }
    x.close('Contact');
  });
  x.close('Contacts');
  const contactId = (c) => idByKey.get(keyOf(c)) || idByKey.get((c.FullContactName || '').toLowerCase());
  const idsWithRole = (role) => contacts.map((c, i) => ((c.roles || []).includes(role) ? i + 1 : null)).filter(Boolean);

  // ---- Publications ----
  x.open('Publications');
  publications.forEach((p, i) => {
    x.open('Publication', { ID: i + 1, Primary: i === 0 ? 'true' : null });
    x.leaf('PublicationType', pubType(p.PubType));
    x.leaf('PublicationYear', p.Year);
    x.leaf('Citation', p.Citation);
    if ((p.authors || []).length) {
      x.open('Authors');
      for (const a of p.authors) {
        x.open('Author');
        const cid = contactId(a);
        if (cid) x.empty('Contact', { ID: cid });
        x.leaf('LastName', a.FamilyName);
        x.leaf('Initials', initialsOf(a));
        x.close('Author');
      }
      x.close('Authors');
    }
    x.leaf('Title', p.ArticleTitle);
    x.leaf('Journal', p.Journal);
    x.leaf('Volume', p.Volume);
    x.leaf('Issue', p.Issue);
    x.leaf('Pages', p.Pages);
    x.leaf('DOI', p.DOI);
    x.leaf('Publisher', p.Publisher);
    x.close('Publication');
  });
  x.close('Publications');
  const pubIds = publications.map((_, i) => i + 1);

  // ---- Spreadsheet ----
  const chronName = dataset.ChronologyName || 'Author generated';
  const S = data?.samples || [];
  const hasAges = options.includeAges !== false && S.some((s) => s.age != null);
  x.open('SpreadSheetBook');
  x.open('SpreadSheetOptions');
  const opts = { HeaderRow: 0, FontName: 'Arial', FontSize: 9, DefaultColWidth: 64, DefaultRowHeight: 18, PercentDecimalPlaces: 2, CheckDupCodes: 'True', CaseSensitiveCodes: 'False', CodesVisible: 'True', ElementsVisible: 'True', UnitsVisible: 'True', ContextsVisible: 'False', TaphonomyVisible: 'False', GroupsVisible: 'True' };
  for (const [k, v] of Object.entries(opts)) x.leaf(k, v);
  if (/pollen|macrofossil|phytolith/i.test(dataset.DatasetType || '')) { x.open('GroupCategories'); x.leaf('GroupCategory', 'vascular plants'); x.close('GroupCategories'); }
  x.close('SpreadSheetOptions');

  if (S.length) {
    const vars = data.variables.filter((v) => v.include);
    const codes = makeCodes(vars);
    // Row 1 = depths, row 2 = analysis-unit names, then "#" sample rows, then one row per variable.
    const metaRows = [];
    if (hasAges) metaRows.push({ code: '#Chron1', name: chronName, vals: S.map((s) => s.age) });
    // modelled age range, as Tilia files from Bacon/clam output carry it
    const modelLabel = dataset.AgeModel || chronName;
    if (hasAges && options.includeAgeRanges && S.some((s) => s.ageYoung != null)) metaRows.push({ code: '#Chron1.Young', name: `${modelLabel} min age`, vals: S.map((s) => s.ageYoung ?? null) });
    if (hasAges && options.includeAgeRanges && S.some((s) => s.ageOld != null)) metaRows.push({ code: '#Chron1.Old', name: `${modelLabel} max age`, vals: S.map((s) => s.ageOld ?? null) });
    if (S.some((s) => s.analyst)) metaRows.push({ code: '#Samp.Analyst', name: 'Sample Analyst', vals: S.map((s) => s.analyst || null), contact: true });
    const firstVarRow = 3 + metaRows.length;
    const descCols = [
      (v, i) => codes[i], (v) => v.name, (v) => v.element, (v) => v.units, (v) => v.context, (v) => v.taphonomy, (v) => v.group,
    ];
    x.open('SpreadSheet', { page: '0', name: 'Data' });
    descCols.forEach((get, c) => {
      x.open('Col', { ID: c + 1, Width: c === 1 ? 180 : 64 });
      metaRows.forEach((m, r) => {
        const val = c === 0 ? m.code : c === 1 ? m.name : null;
        if (val) { x.open('cell', { row: 3 + r }); x.leaf('text', val); x.close('cell'); }
      });
      vars.forEach((v, r) => {
        const val = get(v, r);
        if (val != null && val !== '') { x.open('cell', { row: firstVarRow + r }); x.leaf('text', val); x.close('cell'); }
      });
      x.close('Col');
    });
    S.forEach((s, j) => {
      x.open('Col', { ID: 8 + j, Width: 64 });
      if (s.depth != null) { x.open('cell', { row: 1 }); x.leaf('value', fmtNum(s.depth)); x.close('cell'); }
      if (s.name) { x.open('cell', { row: 2 }); x.leaf('text', s.name); x.close('cell'); }
      metaRows.forEach((m, r) => {
        const v = m.vals[j];
        if (v == null || v === '') return;
        x.open('cell', { row: 3 + r });
        if (typeof v === 'number') x.leaf('value', fmtNum(v));
        else {
          x.leaf('text', v);
          const cid = m.contact && idByKey.get(String(v).toLowerCase());
          if (cid) x.empty('contact', { ID: cid });
        }
        x.close('cell');
      });
      vars.forEach((v, r) => {
        const val = v.values[j];
        if (val == null) return;
        x.open('cell', { row: firstVarRow + r });
        x.leaf('value', fmtNum(val));
        x.close('cell');
      });
      x.close('Col');
    });
    x.close('SpreadSheet');
  }
  x.close('SpreadSheetBook');

  // ---- Site ----
  const lat = site.LatNorth, lon = site.LongEast;
  x.open('Site');
  x.leaf('SiteName', site.SiteName);
  x.leaf('LongEast', lon);
  x.leaf('LongWest', site.LongWest !== '' && site.LongWest != null ? site.LongWest : lon);
  x.leaf('LatNorth', lat);
  x.leaf('LatSouth', site.LatSouth !== '' && site.LatSouth != null ? site.LatSouth : lat);
  x.leaf('Altitude', site.Altitude);
  x.leaf('Country', site.Country);
  x.leaf('State', site.State);
  x.leaf('County', site.County);
  x.leaf('SiteDescription', site.SiteDescription);
  x.leaf('Notes', site.Notes);
  x.close('Site');

  // ---- Collection unit ----
  x.open('CollectionUnit');
  x.leaf('Handle', collectionUnit.Handle);
  x.leaf('CollectionType', collectionUnit.CollectionType);
  x.leaf('CollectionDevice', collectionUnit.CollectionDevice);
  const collectors = idsWithRole('Collector');
  if (collectors.length) { x.open('Collectors'); collectors.forEach((id) => x.empty('Contact', { ID: id })); x.close('Collectors'); }
  x.leaf('CollectionDate', dateToSerial(collectionUnit.CollectionDate));
  x.leaf('Location', collectionUnit.Location);
  x.leaf('DepositionalEnvironment', collectionUnit.DepositionalEnvironment);
  x.leaf('WaterDepth', collectionUnit.WaterDepth);
  x.leaf('CollectionName', collectionUnit.CollectionName);
  x.close('CollectionUnit');

  // ---- Dataset ----
  const inv = idsWithRole('Investigator');
  x.open('Datasets');
  x.open('Dataset');
  x.leaf('DatasetType', capFirst(dataset.DatasetType));
  x.leaf('IsSSamp', dataset.IsSSamp ? 'True' : 'False');
  x.leaf('WhitmoreData', 'False');
  x.leaf('IsAggregate', 'False');
  if (inv.length) { x.open('Investigators'); inv.forEach((id) => x.empty('Contact', { ID: id })); x.close('Investigators'); }
  const proc = idsWithRole('Processor');
  if (proc.length) { x.open('Processors'); proc.forEach((id) => x.empty('Contact', { ID: id })); x.close('Processors'); }
  if (pubIds.length) { x.open('Publications'); pubIds.forEach((id) => x.empty('Publication', { ID: id })); x.close('Publications'); }
  x.leaf('Notes', [dataset.Name ? `Dataset name: ${dataset.Name}` : '', dataset.Notes].filter(Boolean).join('\n'));
  x.close('Dataset');
  x.close('Datasets');

  // ---- Geochronology ----
  const dated = geochron.filter((g) => num(g.age) != null);
  const pubText = publications[0] ? shortRef(publications[0]) : '';
  if (dated.length) {
    x.open('GeochronDataset');
    if (inv.length) { x.open('Investigators'); inv.forEach((id) => x.empty('Contact', { ID: id })); x.close('Investigators'); }
    x.open('Geochronology', { AnalysisUnitID: 'Depth' });
    dated.forEach((g, i) => {
      const method = g.method || 'Carbon-14';
      const err = num(g.error);
      x.open('GeochronSample', { ID: i + 1 });
      x.leaf('Method', method);
      x.leaf('AgeUnits', /lead|210pb|cesium|137cs|plutonium/i.test(method) ? 'Calendar years AD/BC' : /osl|luminescence|u-series|uranium/i.test(method) ? 'Calendar years BP' : 'Radiocarbon years BP');
      x.leaf('Depth', num(g.depth));
      x.leaf('Thickness', num(g.thickness));
      x.leaf('LabNumber', g.labNumber);
      x.leaf('Age', num(g.age));
      x.leaf('ErrorOlder', err);
      x.leaf('ErrorYounger', err);
      if (err != null) { x.leaf('Sigma', 1); x.leaf('StdDev', err); }
      x.leaf('GreaterThan', 'False');
      x.leaf('MaterialDated', g.material);
      x.leaf('Notes', [g.units && !/radiocarbon/i.test(g.units) ? `Reported as ${g.units}` : '', g.notes].filter(Boolean).join('; '));
      x.leaf('PublicationsText', pubText);
      if (pubIds.length) { x.open('Publications'); x.empty('Publication', { ID: 1 }); x.close('Publications'); }
      x.close('GeochronSample');
    });
    x.close('Geochronology');
    x.close('GeochronDataset');
  }

  // ---- Age model (sample ages + the dates that constrain them) ----
  if (hasAges) {
    const ages = S.map((s) => num(s.age)).filter((a) => a != null);
    x.open('AgeModels', { AnalysisUnitID: 'Depth' });
    x.open('AgeModel');
    x.leaf('ChronNumber', 1);
    x.leaf('ChronologyName', chronName);
    x.leaf('AgeUnits', dataset.AgeUnits || 'Calibrated radiocarbon years BP');
    x.leaf('Default', 'True');
    x.leaf('Model', dataset.AgeModel || chronName);
    // bounds rounded outward to the nearest 10 years, as in hand-made files (2312 → 2320, -58 → -60)
    x.leaf('AgeBoundOlder', Math.ceil(Math.max(...ages) / 10) * 10);
    x.leaf('AgeBoundYounger', Math.floor(Math.min(...ages) / 10) * 10);
    const preparers = inv.length ? inv : [];
    if (preparers.length) {
      x.leaf('PreparersText', preparers.map((id) => contacts[id - 1].ShortContactName || contacts[id - 1].FullContactName).join('; '));
      x.open('Preparers'); preparers.forEach((id) => x.empty('Contact', { ID: id })); x.close('Preparers');
    }
    const controls = dated.map((g, i) => ({ g, id: i + 1 })).filter(({ g }) => num(g.depth) != null && /carbon|14c/i.test(g.method || 'Carbon-14'));
    if (controls.length) {
      x.open('ChronControls');
      for (const { g, id } of controls) {
        const age = num(g.age), err = num(g.error) ?? 0;
        x.open('ChronControl');
        x.leaf('ControlType', 'Radiocarbon');
        x.leaf('Depth', num(g.depth));
        x.leaf('Thickness', num(g.thickness));
        x.leaf('AgeUnits', 'Radiocarbon');
        x.leaf('Age', age);
        x.leaf('AgeLimitOlder', age + err);
        x.leaf('AgeLimitYounger', age - err);
        x.open('GeochronLinks'); x.empty('GeochronLink', { ID: id }); x.close('GeochronLinks');
        x.close('ChronControl');
      }
      x.close('ChronControls');
    }
    x.close('AgeModel');
    x.close('AgeModels');
  }

  x.close('TiliaFile');
  return x.toString();
}

// "Anderson et al. 2010" / "Rushton and Walsh 2021"
function shortRef(p) {
  const a = p.authors || [];
  const who = a.length > 2 ? `${a[0].FamilyName} et al.` : a.map((x) => x.FamilyName).join(' and ');
  return [who, p.Year].filter(Boolean).join(' ');
}

// Problems worth fixing before loading into Tilia.
export function validate(record) {
  const issues = [];
  const warn = (level, msg) => issues.push({ level, msg });
  const { site = {}, dataset = {}, data, contacts = [], publications = [] } = record;
  if (!site.SiteName) warn('error', 'Site name is empty.');
  const lat = parseFloat(site.LatNorth), lon = parseFloat(site.LongEast);
  if (Number.isNaN(lat) || Number.isNaN(lon)) warn('error', 'Site coordinates are missing.');
  else if (Math.abs(lat) > 90 || Math.abs(lon) > 180) warn('error', 'Site coordinates are out of range.');
  if (!dataset.DatasetType) warn('error', 'Dataset type is not set.');
  if (!record.collectionUnit?.Handle) warn('warn', 'Collection unit handle is empty.');
  if (!data || !data.samples?.length) warn('warn', 'No spreadsheet data — the file will contain metadata only.');
  else {
    const vars = data.variables.filter((v) => v.include);
    if (!vars.length) warn('error', 'Every variable is excluded.');
    const noGroup = vars.filter((v) => !v.group).length;
    if (noGroup) warn('warn', `${noGroup} variable(s) have no Group — Tilia will ask you to assign them.`);
    const noUnits = vars.filter((v) => !v.units).length;
    if (noUnits) warn('warn', `${noUnits} variable(s) have no Units.`);
    const depths = data.samples.map((s) => s.depth).filter((d) => d != null);
    if (new Set(depths).size !== depths.length) warn('warn', 'Some samples share the same depth.');
    if (!depths.length && data.samples.every((s) => !s.name)) warn('error', 'Samples have neither depths nor names.');
  }
  if (!contacts.length) warn('warn', 'No contacts — add at least the investigator.');
  if (!publications.length) warn('warn', 'No publication — Tilia datasets normally cite one.');
  return issues;
}
