#!/usr/bin/env node
/* Usage: node tools/convert-book.js <book.pdf | folder> [--title "My title"] [--force]
   - A folder converts every .pdf inside it (books already converted are skipped; --force redoes them).
   - --title only applies to a single PDF; folder books get titles from their file names.
   Needs: npm i pdfjs-dist@3.11.174   (run once, in the project folder)
   Writes books/<slug>.json next to the tools/ folder (works from any directory) and updates books/index.json */
const fs = require("fs"), path = require("path");
/* pdf.js prints harmless "Cannot polyfill DOMMatrix/Path2D" warnings in Node; hide them */
const _log = console.log; console.log = (...a) => { if (!/^Warning: Cannot polyfill/.test(String(a[0]))) _log(...a); };
const pdfjs = require("pdfjs-dist/legacy/build/pdf.js");
console.log = _log;
function bkGroupLines(items) {
  items.sort((a, b) => b.transform[5] - a.transform[5] || a.transform[4] - b.transform[4]);
  const rows = [];
  for (const it of items) {
    const y = it.transform[5], last = rows[rows.length - 1];
    if (last && Math.abs(last.y - y) < Math.max(2.5, (it.height || 10) * 0.35)) last.items.push(it);
    else rows.push({ y, items: [it] });
  }
  return rows.map(r => {
    r.items.sort((a, b) => a.transform[4] - b.transform[4]);
    let s = "", prevEnd = null;
    for (const it of r.items) {
      const x = it.transform[4];
      if (prevEnd !== null && x - prevEnd > (it.height || 10) * 0.12 && !s.endsWith(" ") && !it.str.startsWith(" ")) s += " ";
      s += it.str; prevEnd = x + it.width;
    }
    return { y: r.y, x: r.items[0].transform[4], text: s.replace(/\s+/g, " ").trim() };
  }).filter(l => l.text);
}
/* pages: [{ width, height, items }] -> sections [{ title, list, paras }] */
function bkBuildSections(pages) {
  const sections = [];
  let cur = null, para = "", colKey = "";
  const flush = () => { if (cur && para.trim()) cur.paras.push(para.trim()); para = ""; };
  const open = (title, kind) => { flush(); cur = { title, kind, list: kind === "glossary" || kind === "notes", paras: [], collect: false }; sections.push(cur); return cur; };
  pages.forEach((pg, pi) => {
    const spread = pg.width > pg.height * 1.15, mid = pg.width / 2;
    const cols = spread ? [pg.items.filter(i => i.transform[4] < mid), pg.items.filter(i => i.transform[4] >= mid)] : [pg.items];
    cols.forEach((items, ci) => {
      let lines = bkGroupLines(items.filter(i => i.str && i.str.trim()));
      lines = lines.filter(l => !(/^\d{1,3}$/.test(l.text) && (l.y < pg.height * 0.12 || l.y > pg.height * 0.9)));
      if (!lines.length) return;
      const body = lines.filter(l => l.text.length > 25);
      const margin = Math.min(...(body.length ? body : lines).map(l => l.x));
      colKey = pi + "-" + ci;
      if (cur) cur.collect = false;
      for (const l of lines) {
        const t = l.text;
        if (/^Chapter\s+([IVXLC]+|\d+)$/i.test(t)) { open(t, "chapter").collect = true; continue; }
        if (/^(Glossary|Notes|Contents|Index)$/i.test(t)) { open(t, t.toLowerCase()); continue; }
        if (!cur) open("Front matter", "front");
        if (cur.collect) { cur.title += (cur.title.includes("—") ? " " : " — ") + t.replace(/^[‘'“"]+|[’'”"]+$/g, ""); continue; }
        if (cur.list || l.x - margin > 6) { flush(); para = t; }
        else if (!para) para = t;
        else para += para.endsWith("-") ? t : " " + t;
      }
      if (cur.list) flush();
    });
  });
  flush();
  let out = sections.filter(s => s.paras.length && !["front", "contents", "index"].includes(s.kind));
  if (!out.some(s => s.kind === "chapter")) {
    const all = out.flatMap(s => s.paras); out = [];
    for (let i = 0; i < all.length; i += 40) out.push({ title: "Part " + (out.length + 1), kind: "part", list: false, paras: all.slice(i, i + 40) });
  }
  return out.map(s => ({ title: s.kind === "notes" ? "Notes" : s.title, list: s.list, paras: s.paras }));
}

const cleanTitle = base => base.replace(/^\d+[_\s-]*/, "").replace(/_+/g, " ").replace(/\s*-\s*Unknown$/i, "").replace(/(\S) s\b/g, "$1\u2019s").replace(/\s+/g, " ").trim() || "Untitled";
const slugOf = t => t.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "book";

async function convert(file, title, force) {
  const slug = slugOf(title), id = "s_" + slug;
  const dir = path.join(__dirname, "..", "books"); fs.mkdirSync(dir, { recursive: true });
  const out = path.join(dir, slug + ".json");
  if (!force && fs.existsSync(out)) { console.log(`SKIP (already converted): ${title}`); return true; }
  const pdf = await pdfjs.getDocument({ data: new Uint8Array(fs.readFileSync(file)), useSystemFonts: true }).promise;
  const pages = [];
  for (let p = 1; p <= pdf.numPages; p++) {
    const pg = await pdf.getPage(p), vp = pg.getViewport({ scale: 1 }), c = await pg.getTextContent();
    pages.push({ width: vp.width, height: vp.height, items: c.items });
  }
  const sections = bkBuildSections(pages);
  if (!sections.length) { console.error(`FAIL (no selectable text, scanned?): ${path.basename(file)}`); return false; }
  fs.writeFileSync(out, JSON.stringify({ id, title, pages: pdf.numPages, sections }));
  const idxPath = path.join(dir, "index.json");
  let idx = []; try { idx = JSON.parse(fs.readFileSync(idxPath, "utf8")); } catch {}
  idx = idx.filter(b => b.id !== id); idx.push({ id, title, file: slug + ".json", count: sections.length });
  fs.writeFileSync(idxPath, JSON.stringify(idx, null, 1));
  const chapters = sections.filter(x => /^Chapter/i.test(x.title)).length;
  console.log(`OK: ${title} -> books/${slug}.json (${sections.length} sections${chapters ? "" : ", no chapters detected"})`);
  return true;
}

(async () => {
  const args = process.argv.slice(2), ti = args.indexOf("--title"), force = args.includes("--force");
  const target = args.find((a, i) => !a.startsWith("--") && !(ti > -1 && i === ti + 1));
  const usage = 'Usage: node tools/convert-book.js <book.pdf | folder> [--title "Title"] [--force]';
  if (!target) { console.error("No PDF or folder given.\n" + usage); process.exit(1); }
  const resolved = target.replace(/^~(?=$|[\\/])/, require("os").homedir());
  if (!fs.existsSync(resolved)) { console.error(`Not found: ${path.resolve(resolved)}\nCheck the path (use quotes if it has spaces).\n` + usage); process.exit(1); }
  let files = [resolved];
  if (fs.statSync(resolved).isDirectory()) files = fs.readdirSync(resolved).filter(f => /\.pdf$/i.test(f)).sort().map(f => path.join(resolved, f));
  if (!files.length) { console.error("No PDF files found."); process.exit(1); }
  let ok = 0, bad = 0;
  for (const f of files) {
    const title = (files.length === 1 && ti > -1 && args[ti + 1]) || cleanTitle(path.basename(f).replace(/\.pdf$/i, ""));
    try { (await convert(f, title, force)) ? ok++ : bad++; } catch (e) { console.error(`FAIL: ${path.basename(f)} (${e.message})`); bad++; }
  }
  console.log(`\nDone: ${ok} ok, ${bad} failed.`);
})();
