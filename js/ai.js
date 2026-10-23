// Optional: ask Claude to read a publication and return Tilia metadata as JSON.
// Runs from the browser with the user's own API key; the PDF is sent to the
// Anthropic API only when the user clicks the button.

import { toBase64 } from './io.js';

const SDK_URL = 'https://cdn.jsdelivr.net/npm/@anthropic-ai/sdk@0.128.0/+esm';

export const MODELS = [
  ['claude-opus-5', 'Claude Opus 5 (most accurate)'],
  ['claude-sonnet-5', 'Claude Sonnet 5 (faster, lower cost)'],
];

const PATHS = [
  'site.SiteName', 'site.LatNorth', 'site.LongEast', 'site.Altitude', 'site.Country', 'site.State', 'site.County', 'site.SiteDescription',
  'collectionUnit.CollectionName', 'collectionUnit.CollectionType', 'collectionUnit.CollectionDevice', 'collectionUnit.CollectionDate',
  'collectionUnit.DepositionalEnvironment', 'collectionUnit.WaterDepth',
  'dataset.DatasetType', 'dataset.AgeModel',
  'publication.ArticleTitle', 'publication.Journal', 'publication.Year', 'publication.Volume', 'publication.Issue', 'publication.Pages', 'publication.DOI',
];

const nullable = (t) => ({ anyOf: [{ type: t }, { type: 'null' }] });

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['fields', 'authors', 'dates', 'fauna', 'notes'],
  properties: {
    fields: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['path', 'value', 'page', 'quote'],
        properties: {
          path: { type: 'string', enum: PATHS },
          value: { type: 'string' },
          page: nullable('integer'),
          quote: { type: 'string' },
        },
      },
    },
    authors: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['family', 'given', 'email', 'orcid', 'affiliation'],
        properties: {
          family: { type: 'string' }, given: { type: 'string' }, email: nullable('string'),
          orcid: nullable('string'), affiliation: nullable('string'),
        },
      },
    },
    dates: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['labNumber', 'age', 'error', 'depth', 'thickness', 'unit', 'material', 'method', 'page'],
        properties: {
          labNumber: { type: 'string' }, age: { type: 'number' }, error: nullable('number'),
          depth: nullable('number'), thickness: nullable('number'), unit: nullable('string'), material: { type: 'string' },
          method: { type: 'string' }, page: nullable('integer'),
        },
      },
    },
    // vertebrate faunal data for the site, one record per taxon × element × analysis unit
    fauna: {
      type: 'object', additionalProperties: false,
      required: ['present', 'countType', 'units', 'records'],
      properties: {
        present: { type: 'boolean' },
        countType: { type: 'string', enum: ['NISP', 'MNI', 'presence/absence'] },
        units: { type: 'array', items: { type: 'string' } },
        records: {
          type: 'array',
          items: {
            type: 'object', additionalProperties: false,
            required: ['taxon', 'element', 'unit', 'value', 'page'],
            properties: {
              taxon: { type: 'string' }, element: { type: 'string' }, unit: { type: 'string' },
              value: { type: 'number' }, page: nullable('integer'),
            },
          },
        },
      },
    },
    notes: { type: 'string' },
  },
};

const PROMPT = `You are helping a data steward enter a published paleoecological study into Tilia, the data-entry program for the Neotoma Paleoecology Database.

Read the attached publication and report every Tilia metadata field it states, using these rules:
- Record only what the paper actually says. If a field is not stated, omit it. Do not infer coordinates from place names.
- Give coordinates as signed decimal degrees (south and west are negative). Convert degrees/minutes/seconds.
- Altitude and water depth are in metres; depths of dated samples are in centimetres (use the midpoint and put the interval width in thickness).
- dataset.DatasetType must be a lowercase Neotoma type such as pollen, plant macrofossil, diatom, ostracode, chironomid, charcoal, testate amoebae, vertebrate fauna, loss-on-ignition, geochemistry.
- collectionUnit.DepositionalEnvironment should use Neotoma terms: Natural Lake (most lakes and ponds), Glacial Origin Lake, Cirque Lake, Landslide Origin Lake, Palustrine (peatlands, bogs, fens), Marsh, Floodplain, Terrestrial, Marine.
- collectionUnit.CollectionDevice: the coring device in the paper's own words (e.g. "Modified Livingstone piston corer").
- dataset.AgeModel: the age-depth modelling method or software (e.g. Bacon, OxCal, linear interpolation).
- CollectionDate as YYYY, YYYY-MM or YYYY-MM-DD.
- For each field give the page number and a short verbatim quote (under 25 words) that supports it.
- dates: every radiometric date in the paper (usually a table). age is the uncalibrated measured age (e.g. 14C yr BP) and error its 1-sigma uncertainty; method is e.g. "Carbon-14", "Lead-210", "OSL".
- authors: all authors in order, with emails, ORCID iDs (format 0000-0000-0000-0000) and affiliations only if printed in the paper. Never guess an ORCID.
- If the paper describes several sites, report the primary one the dataset belongs to and list the others in notes. If the user named a site below, report that site.
- dates.unit: the analysis unit (stratum, level, zone, area…) the dated sample came from, named exactly as in fauna.units, or null when dates are tied to depths.

fauna: the vertebrate fauna recorded at the site, if the paper reports any (otherwise present=false and empty lists). Follow the conventions of Neotoma data stewards:
- One record per taxon × skeletal element × analysis unit. value is the count (NISP unless the paper only gives MNI) or 1 for presence; set countType accordingly ("presence/absence" when the paper only lists or ticks taxa).
- taxon: the identification as printed, without "sp.", "spp." or notes like "(2 taxa)"; keep "cf." qualifiers. Use the Latin name when a table gives common names with Latin in parentheses. Skip totals rows and non-taxon rows.
- element: "bone" unless the paper lists skeletal elements for individual specimens; then use Neotoma element terms, e.g. "tooth, third molar", "tooth, premolar" (position uncertain), "metatarsal, third", "vertebra, atlas", "phalanx", "mandible", "maxilla".
- units: the analysis units (strata, levels, zones, excavation areas, loci) named as in the paper, in the paper's order. Use a single unit "Assemblage" when the fauna is reported for the site as a whole. If the columns are time bins (e.g. MIS stages) and a total column exists, report the totals under "Assemblage". If a table compares several sites, report only the site being converted, as "Assemblage". Specimens without provenience go in "Assemblage".
- Read faunal tables, appendices and specimen lists ("Material", "Referred material") — including tables that are images.`

let clientCache;
async function getClient(apiKey) {
  if (clientCache?.key !== apiKey) {
    const { default: Anthropic } = await import(SDK_URL);
    clientCache = { key: apiKey, client: new Anthropic({ apiKey, dangerouslyAllowBrowser: true }) };
  }
  return clientCache.client;
}

// The Messages API request (exported so tests can check the schema without calling the API).
export function buildClaudeRequest({ model, input, fileName, site = '' }) {
  const doc = input.bytes
    ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: toBase64(input.bytes) }, title: fileName }
    : { type: 'document', source: { type: 'text', media_type: 'text/plain', data: input.text }, title: fileName };
  const params = {
    model,
    // faunal tables can run to hundreds of records; streaming keeps a large budget safe from timeouts
    max_tokens: 64000,
    thinking: { type: 'adaptive' },
    output_config: { effort: 'high', format: { type: 'json_schema', schema: SCHEMA } },
    messages: [{ role: 'user', content: [doc, { type: 'text', text: site ? `${PROMPT}\n\nThe user is converting the site “${site}”.` : PROMPT }] }],
  };
  return params;
}

// input: {bytes} for a PDF, or {text} for plain text.
export async function extractWithClaude({ apiKey, model, input, fileName, site = '', onProgress }) {
  const client = await getClient(apiKey);
  const params = buildClaudeRequest({ model, input, fileName, site });
  onProgress?.('Claude is reading the paper…');
  let stream;
  if (model === 'claude-opus-5') {
    // Server-side fallback re-runs the request on another model if it is declined.
    stream = client.beta.messages.stream({ ...params, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' });
  } else {
    stream = client.messages.stream(params);
  }
  const msg = await stream.finalMessage();
  if (msg.stop_reason === 'refusal') throw new Error('Claude declined to process this document.');
  if (msg.stop_reason === 'max_tokens') throw new Error('The response was cut off (document too long). Try a shorter excerpt.');
  const text = msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  let out;
  try { out = JSON.parse(text); } catch { throw new Error('Claude returned output that was not valid JSON.'); }
  return { ...out, usage: msg.usage };
}
