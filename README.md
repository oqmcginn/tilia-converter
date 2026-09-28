# Tilia Converter

A static website that turns **spreadsheets** and **publications** into a **Tilia (`.tlx`) file** for the [Neotoma Paleoecology Database](https://www.neotomadb.org/).

Drop in your count/measurement spreadsheet, the paper that describes the site, and optionally a metadata sheet, RIS/BibTeX file, or DOI. The converter pulls out everything it can find, shows you where each value came from, lets you correct it, and writes a Tilia file you can open in [Tilia](https://www.neotomadb.org/apps/tilia).

Everything runs in the browser. Files are not uploaded anywhere. The exceptions are all opt-in: CrossRef (sends the DOI or title), ORCID (sends author names and DOIs), OpenStreetMap reverse geocoding (sends the site coordinates), and Claude extraction (sends the paper to the Anthropic API with your own key).

## What it extracts

| From | What |
|---|---|
| **Data spreadsheets** (xlsx, xls, ods, csv, tsv) | Samples (depth, top/bottom → midpoint + thickness, age, sample/analysis-unit name, analyst) and variables (taxa or measurements, with units parsed from headers like `Pinus (%)`). Both layouts are detected: samples as rows (typical Excel) or samples as columns (Tilia layout, including `Code/Name/Element/Units/Group` columns and `#` rows). Unit conversions: depth m/mm → cm, age ka → yr. Totals/sums/concentrations are excluded by default. |
| **Metadata sheets** (key/value rows) | Site name, coordinates (decimal or DMS), elevation, country/state/county, core name, device, collection date, water depth, dataset type, investigators, analysts, collectors, DOI. |
| **Date sheets** | Lab number, depth (incl. ranges like `100-102`), ¹⁴C age, error, material, method. |
| **Publications** (PDF, txt) | DOI, coordinates (DMS, decimal-minutes, decimal with hemispheres, labelled), altitude, water depth, site name, country/state/county, dataset type, coring device, depositional environment, collection date, radiocarbon dates (lab number + age ± error + depth + material), author emails. Each value records its page. |
| **CrossRef / RIS / BibTeX** | Title, authors, journal, year, volume, issue, pages, DOI → publication + contacts. |
| **Claude** (optional) | Reads the full paper including tables and returns every Tilia field it can support, each with a page number and a supporting quote. |

## ORCID iDs for contacts

Every contact (authors from publications plus people named in metadata sheets) is matched to ORCID using the public ORCID API. Each match gets a confidence score and a list of the evidence behind it:

| Evidence | Score |
|---|---|
| ORCID supplied by the publisher in CrossRef (authenticated by the author) | 99% |
| ORCID supplied by the publisher in CrossRef | 92% |
| The person's ORCID record lists this paper's DOI, and the name matches | 93–97% |
| iD printed in the paper (checksum-valid), and the record's name matches | 93% |
| Name search only: given-name agreement, affiliation overlap, same journal, share of works on related topics | up to 85% |

Scores are labelled **Confirmed** (≥90%), **Likely** (≥70%), **Possible** (≥40%) or **Weak**. The best match is selected automatically only when it is at least Likely and clearly ahead of the next candidate. Otherwise up to six candidates are listed with their affiliations and evidence, and you choose one, choose none, or type an iD.

For common names, add an affiliation hint and search again; this runs an affiliation-restricted search. The chosen iD is written to the contact's `URL` field, since Tilia 3 has no dedicated ORCID element. **Contacts CSV** exports each contact's iD, confidence, evidence and runner-up candidates.

Pollen taxa get a provisional Neotoma ecological group (TRSH, UPHE, VACR, AQVP, LABO, UNID) and default element/units for the dataset type. Everything stays editable.

## Output format

The `.tlx` matches files saved by **Tilia 3.0.3**. The element names, order and attributes were taken from 20 hand-converted lab examples, and a check confirms that every element path the converter writes also appears in those files.

```
TiliaFile
├─ Version            Tilia 3.0.3
├─ Contacts           Contact ID=n (name fields, email, URL ← chosen ORCID iD)
├─ Publications       Publication ID Primary: PublicationType, PublicationYear, Citation,
│                     Authors/Author (Contact, LastName, Initials), Title, Journal, Volume, Issue, Pages, DOI
├─ SpreadSheetBook    SpreadSheetOptions (+ GroupCategories)
│  └─ SpreadSheet     Col 1–7: Code, Name, Element, Units, Context, Taphonomy, Group
│                     Col 8…: one per sample. Row 1 depth, row 2 analysis unit,
│                     #Chron1 (sample ages), #Samp.Analyst, then one row per taxon
├─ Site               SiteName, Long/Lat, Altitude, Country, State, County, SiteDescription
├─ CollectionUnit     Handle, CollectionType, CollectionDevice, Collectors, CollectionDate (day serial), …
├─ Datasets/Dataset   DatasetType, IsSSamp, Investigators, Processors, Publications
├─ GeochronDataset    Geochronology/GeochronSample: Method, AgeUnits, Depth, Thickness, LabNumber,
│                     Age, ErrorOlder/Younger, Sigma, StdDev, MaterialDated, Publications
└─ AgeModels          AgeModel: ChronologyName, Model (e.g. Bacon), bounds, Preparers,
                      ChronControls linked to the geochronology samples
```

Citations use Neotoma's style ("Galka, M., K.-H. Knorr, and A. Feurdean. 2025. Title. Journal 0(0):1-22. [DOI: …]").

**Taxon lookup.** `js/data/taxa.js` holds 740 taxa (name → Neotoma code, element, units, ecological group) collected from the example files. Spreadsheet columns that match a name get the real code; the rest get a provisional code and a best-guess group.

**Multi-site papers.** When you pick or type the site you're converting, coordinates, altitude, water depth and depositional environment are re-read from the text around that site's name. That includes site tables like `Frog Lake 48.48, 123.59 …`.

Always review the file in Tilia (lookups, taxon names, chronology) before you submit to Neotoma.

## Accuracy on real papers

`tests/eval.html` runs the publication pipeline on example PDFs and scores each field against hand-made Tilia files. Put study folders (a PDF plus a `.tlx`) next to the app and generate `tests/_eval/manifest.json`, which is git-ignored and stays on your machine. Results on 20 lab examples, three of which are scanned PDFs with no text layer:

| Field | Automatic | Site chosen by user |
|---|---|---|
| Radiocarbon dates found (by lab number) | 134 / 149 | same |
| …with exactly the right age and error | 119 / 134 | same |
| Latitude / longitude | 9 / 20, 7 / 20 | 12 / 20, 11 / 20 |
| Country / state / county | 16 / 20, 14 / 19, 6 / 9 | 16, 14, 7 / 9 |
| Dataset type | 18 / 20 | same |
| Title / year | 15 / 20, 12 / 16 | same |
| Collection device / depositional environment | 11 / 19, 9 / 20 | 11, 11 / 20 |
| Collection date (year) | 8 / 18 | same |
| Altitude / water depth | 9 / 20, 2 / 9 | 10 / 20, 2 / 9 |

Scanned PDFs, per-site values in complex tables, and anything not stated in the paper need Claude extraction or manual entry.

## Run locally

It's plain HTML and ES modules with no build step:

```bash
python3 -m http.server 8000
```

Then open http://localhost:8000. Unit tests are at http://localhost:8000/tests/.

## Deploy to GitHub Pages

1. Push this folder to a GitHub repository (branch `main`).
2. In **Settings → Pages**, set **Source** to **GitHub Actions**.
3. The included workflow (`.github/workflows/pages.yml`) publishes the site on every push.

## Project layout

```
index.html              page shell
css/style.css           styles (light + dark)
js/app.js               UI, ingestion, review, export
js/record.js            candidate/merge model (provenance + confidence)
js/tilia.js             .tlx writer + validation
js/io.js                file readers (SheetJS, pdf.js, loaded on demand)
js/ai.js                optional Claude extraction (structured JSON output)
js/orcid.js             ORCID matching, scoring and evidence
js/pipeline.js          publication ingestion, site re-anchoring, reverse geocoding
js/data/taxa.js         Neotoma taxon lookup built from hand-converted files
js/extract/spreadsheet.js  sheet classification, layout detection, sample/variable parsing
js/extract/text.js      publication text heuristics
js/extract/bib.js       CrossRef, RIS, BibTeX, names, citations
js/lookups.js           vocabularies, pollen groups, device/environment patterns
samples/                fictional example inputs
tests/index.html        browser unit tests
tests/eval.html         field-by-field accuracy against hand-made Tilia files
```

## Libraries

Loaded from CDNs at runtime: [SheetJS](https://sheetjs.com/) 0.20.3, [pdf.js](https://mozilla.github.io/pdf.js/) 4.10.38, [Leaflet](https://leafletjs.com/) 1.9.4 (map), [@anthropic-ai/sdk](https://www.npmjs.com/package/@anthropic-ai/sdk) 0.128.0 (only when Claude extraction is used).

## License

MIT
