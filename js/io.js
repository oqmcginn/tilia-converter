// File readers. Libraries are loaded on first use so the page opens instantly.

const XLSX_URL = 'https://cdn.sheetjs.com/xlsx-0.20.3/package/xlsx.mjs';
const PDFJS_URL = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.min.mjs';
const PDFJS_WORKER = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.worker.min.mjs';

let xlsxMod, pdfMod;
const loadXLSX = async () => (xlsxMod ||= await import(XLSX_URL));
const loadPDF = async () => {
  if (!pdfMod) {
    pdfMod = await import(PDFJS_URL);
    pdfMod.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
  }
  return pdfMod;
};

export function fileKind(name) {
  const ext = name.toLowerCase().split('.').pop();
  if (['xlsx', 'xlsm', 'xls', 'ods', 'csv', 'tsv'].includes(ext)) return 'spreadsheet';
  if (ext === 'pdf') return 'pdf';
  if (ext === 'ris') return 'ris';
  if (ext === 'bib') return 'bibtex';
  if (['txt', 'md', 'html', 'htm', 'xml'].includes(ext)) return 'text';
  return 'unknown';
}

// → [{name, rows: any[][]}]
export async function readSpreadsheet(file) {
  const XLSX = await loadXLSX();
  const buf = await file.arrayBuffer();
  // SheetJS guesses Latin-1 for raw CSV bytes, which garbles "°", "±" and accents. Decode UTF-8 ourselves
  // (falling back to Windows-1252 for legacy Excel CSV exports that aren't valid UTF-8).
  let wb;
  if (/\.(csv|tsv|txt)$/i.test(file.name)) {
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch { text = new TextDecoder('windows-1252').decode(buf); }
    wb = XLSX.read(text.replace(/^﻿/, ''), { type: 'string', cellDates: true, dense: true, FS: /\.tsv$/i.test(file.name) ? '\t' : undefined });
  } else {
    wb = XLSX.read(buf, { cellDates: true, dense: true });
  }
  return wb.SheetNames.map((name) => {
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: true, defval: null, blankrows: true });
    return {
      name,
      rows: rows.map((r) => r.map((c) => (c instanceof Date ? c.toISOString().slice(0, 10) : c))),
    };
  });
}

// → {pages: [{page, text}], title, author, bytes}
export async function readPdf(file) {
  const pdfjs = await loadPDF();
  const bytes = new Uint8Array(await file.arrayBuffer());
  const doc = await pdfjs.getDocument({ data: bytes.slice() }).promise;
  const pages = [];
  let bigText = { size: 0, text: '' };
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const tc = await page.getTextContent();
    let text = '';
    for (const it of tc.items) {
      text += it.str + (it.hasEOL ? '\n' : ' ');
      if (i === 1) {
        const size = Math.abs(it.transform?.[3] || 0);
        if (it.str.trim().length > 1) {
          if (size > bigText.size + 0.5) bigText = { size, text: it.str };
          else if (Math.abs(size - bigText.size) <= 0.5) bigText.text += ' ' + it.str;
        }
      }
    }
    // re-join words hyphenated across line breaks
    pages.push({ page: i, text: text.replace(/(\w)-\n(\w)/g, '$1$2').replace(/[ \t]+/g, ' ') });
  }
  let meta = {};
  try { meta = (await doc.getMetadata()).info || {}; } catch { /* metadata is optional */ }
  const metaTitle = (meta.Title || '').trim();
  // drop running-header page numbers ("60 ANALYSIS OF…") from the largest-type line
  const bigTitle = bigText.text.replace(/\s+/g, ' ').trim().replace(/^\d{1,4}\s+(?=[A-Z])/, '');
  // uniform font sizes make "largest text" the whole page; only trust a title-length run
  const title = metaTitle.length > 15 && !/^(untitled|microsoft word|\S+\.(docx?|pdf))/i.test(metaTitle) ? metaTitle
    : (bigTitle.length <= 250 ? bigTitle : '');
  return { pages, title, author: meta.Author || '', bytes };
}

export async function readText(file) {
  const text = await file.text();
  return text.replace(/<[^>]+>/g, ' ');
}

export function download(name, content, type = 'application/xml') {
  const blob = content instanceof Blob ? content : new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function toBase64(bytes) {
  let s = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) s += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  return btoa(s);
}
