#!/usr/bin/env node
/**
 * font-embed.mjs — embed real TrueType faces into a .pptx as PowerPoint does.
 *
 * PowerPoint stores embedded fonts as EOT containers in `ppt/fonts/N.fntdata`,
 * referenced from four places:
 *
 *   1. ppt/fonts/N.fntdata                                    the EOT bytes
 *   2. ppt/presentation.xml  <p:embeddedFontLst>              typeface -> r:id
 *   3. ppt/_rels/presentation.xml.rels                       r:id -> fonts/N.fntdata
 *   4. [Content_Types].xml   Default Extension="fntdata"     application/x-fontdata
 *
 * Steps per face: license gate (OS/2 fsType) -> subset to the glyphs the deck
 * actually uses (fontTools pyftsubset) -> EOT header (built here, spec layout)
 * -> inject -> verify (unzip / deflate / python-pptx / LibreOffice render).
 *
 * Usage
 *   node font-embed.mjs <in.pptx> <out.pptx> \
 *     --font "Noto Sans SC=/path/NotoSansSC-Regular.ttf" \
 *     [--font "Noto Sans SC=/path/NotoSansSC-Bold.ttf"] \
 *     [--map "PingFang SC=Noto Sans SC"] \
 *     [--no-subset] [--no-verify] [--json report.json]
 *
 *   node font-embed.mjs --verify <file.pptx>        # audit only, no rewriting
 *   node font-embed.mjs --list <file.pptx>          # which fonts the deck asks for
 *
 * `--font "Family"` (no "=path") resolves the file with
 *   fc-match -f '%{file}' "Family"
 * and a TTC/OTC collection is narrowed to the face whose name matches `Family`.
 *
 * Exit codes: 0 success, 1 hard failure, 2 nothing embeddable (all denied).
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_PYTHON = '/Users/an/Desktop/Atlas/PPT/PPT 复刻/.venv/bin/python';
const FONTCONFIG_FILE = process.env.FONTCONFIG_FILE || '/opt/homebrew/etc/fonts/fonts.conf';
const REL_FONT = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/font';

// ---------------------------------------------------------------------------
// tiny CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = {
    input: null,
    output: null,
    fonts: [], // { family, file|null }
    maps: {}, // old typeface -> new typeface
    subset: true,
    verify: true,
    json: null,
    python: process.env.FONT_EMBED_PYTHON || DEFAULT_PYTHON,
    mode: 'embed',
    keepTemp: false,
  };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--font') {
      const v = argv[++i];
      if (!v) throw new Error('--font needs "Family=/path/to/font"');
      const eq = v.indexOf('=');
      opts.fonts.push(eq === -1 ? { family: v.trim(), file: null } : { family: v.slice(0, eq).trim(), file: v.slice(eq + 1).trim() });
    } else if (a === '--map') {
      const v = argv[++i];
      const eq = (v || '').indexOf('=');
      if (eq === -1) throw new Error('--map needs "OldFamily=NewFamily"');
      opts.maps[v.slice(0, eq).trim()] = v.slice(eq + 1).trim();
    } else if (a === '--no-subset') opts.subset = false;
    else if (a === '--no-verify') opts.verify = false;
    else if (a === '--verify') { opts.mode = 'verify'; opts.verify = true; }
    else if (a === '--list') opts.mode = 'list';
    else if (a === '--json') opts.json = argv[++i];
    else if (a === '--python') opts.python = argv[++i];
    else if (a === '--keep-temp') opts.keepTemp = true;
    else if (a === '-h' || a === '--help') { opts.mode = 'help'; }
    else if (a.startsWith('-')) throw new Error(`unknown flag: ${a}`);
    else rest.push(a);
  }
  if (opts.mode === 'help') return opts;
  opts.input = rest[0] || null;
  opts.output = rest[1] || null;
  if (opts.mode === 'verify' || opts.mode === 'list') opts.output = opts.output || opts.input;
  if (!opts.input) throw new Error('missing <in.pptx>');
  if (opts.mode === 'embed' && !opts.output) throw new Error('missing <out.pptx>');
  return opts;
}

const USAGE = `font-embed.mjs — embed EOT fonts in a .pptx

  node font-embed.mjs <in.pptx> <out.pptx> --font "Family=/path/font.ttf" [--font ...]
                      [--map "OldFamily=NewFamily"] [--no-subset] [--no-verify] [--json r.json]
  node font-embed.mjs --verify <file.pptx>   # re-check an existing deck
  node font-embed.mjs --list <file.pptx>     # audit which fonts the deck asks for

  --font "Family"  (omit =path) resolves via: fc-match -f '%{file}' "Family"
  --map            rewrite every typeface="Old" to "New" before embedding
  --no-subset      embed the whole face (needed for fsType & 0x0100: no-subsetting)
  --no-verify      skip the four post-injection checks
`;

const log = (...a) => console.log(...a);
const warn = (...a) => console.warn('  !', ...a);

// ---------------------------------------------------------------------------
// sfnt (TTF / OTF / TTC) parsing — only the tables we need
// ---------------------------------------------------------------------------

function isCollection(buf) {
  return buf.length > 12 && buf.toString('latin1', 0, 4) === 'ttcf';
}

function ttcFaceCount(buf) {
  return isCollection(buf) ? buf.readUInt32BE(8) : 0;
}

function ttcOffsets(buf) {
  const n = ttcFaceCount(buf);
  const out = [];
  for (let i = 0; i < n; i++) out.push(buf.readUInt32BE(12 + i * 4));
  return out;
}

function tablesAt(buf, sfntOff) {
  const num = buf.readUInt16BE(sfntOff + 4);
  if (num <= 0 || num > 512) throw new Error('not an sfnt font (bad table count)');
  const tables = {};
  for (let i = 0; i < num; i++) {
    const p = sfntOff + 12 + i * 16;
    const tag = buf.toString('latin1', p, p + 4);
    tables[tag] = {
      offset: buf.readUInt32BE(p + 8),
      length: buf.readUInt32BE(p + 12),
    };
  }
  return { sfntOff, tables };
}

function decodeNameBytes(platformID, bytes) {
  if (platformID === 3 || platformID === 0) {
    let s = '';
    for (let i = 0; i + 1 < bytes.length; i += 2) s += String.fromCharCode(bytes.readUInt16BE(i));
    return s.replace(/\u0000+$/, '');
  }
  // Mac Roman: close enough for ASCII family names
  return bytes.toString('latin1').replace(/\u0000+$/, '');
}

function readNames(buf, font) {
  const t = font.tables.name;
  if (!t) return {};
  const base = t.offset;
  const count = buf.readUInt16BE(base + 2);
  const strBase = base + buf.readUInt16BE(base + 4);
  const byId = new Map();
  for (let i = 0; i < count; i++) {
    const p = base + 6 + i * 12;
    if (p + 12 > base + t.length) break;
    const platformID = buf.readUInt16BE(p);
    const languageID = buf.readUInt16BE(p + 4);
    const nameID = buf.readUInt16BE(p + 6);
    const len = buf.readUInt16BE(p + 8);
    const off = buf.readUInt16BE(p + 10);
    if (!len) continue;
    const bytes = buf.subarray(strBase + off, strBase + off + len);
    const text = decodeNameBytes(platformID, bytes);
    const score = (platformID === 3 ? 4 : platformID === 0 ? 3 : 1) + (languageID === 0x409 ? 2 : 0);
    const prev = byId.get(nameID);
    if (!prev || score > prev.score) byId.set(nameID, { text, score });
  }
  const get = (id) => (byId.get(id) || {}).text || '';
  return {
    family: get(1) || get(16),
    familyTypo: get(16),
    subfamily: get(2),
    fullName: get(4),
    version: get(5),
    postscript: get(6),
  };
}

/** Everything we need out of one face. */
function readFontInfo(buf, sfntOff = 0) {
  const font = tablesAt(buf, sfntOff);
  const { tables } = font;
  const os2 = tables['OS/2'];
  const head = tables.head;
  const maxp = tables.maxp;
  if (!os2) throw new Error('font has no OS/2 table');
  if (!head) throw new Error('font has no head table');
  const info = readNames(buf, font);
  info.tables = Object.keys(tables);
  info.weight = buf.readUInt16BE(os2.offset + 4);
  info.widthClass = buf.readUInt16BE(os2.offset + 6);
  info.fsType = buf.readUInt16BE(os2.offset + 8);
  info.panose = Buffer.from(buf.subarray(os2.offset + 32, os2.offset + 42));
  info.unicodeRange = Buffer.from(buf.subarray(os2.offset + 42, os2.offset + 58));
  const os2Version = buf.readUInt16BE(os2.offset);
  info.os2Version = os2Version;
  info.codePageRange = os2Version >= 1 ? Buffer.from(buf.subarray(os2.offset + 78, os2.offset + 86)) : Buffer.alloc(8);
  info.fsSelection = buf.readUInt16BE(os2.offset + 62);
  info.macStyle = buf.readUInt16BE(head.offset + 44);
  info.checkSumAdjustment = buf.readUInt32BE(head.offset + 8);
  info.unitsPerEm = buf.readUInt16BE(head.offset + 18);
  info.numGlyphs = maxp ? buf.readUInt16BE(maxp.offset + 4) : 0;
  info.sfntVersion = buf.readUInt32BE(sfntOff);
  info.isCff = tables['CFF '] !== undefined || info.sfntVersion === 0x4f54544f; // 'OTTO'
  info.glyf = !!tables.glyf;
  return info;
}

/** Fonts whose OS/2 fsType forbids what we want to do. */
function licenseGate(fsType) {
  const bits = {
    restricted: (fsType & 0x0002) !== 0,
    previewPrint: (fsType & 0x0004) !== 0,
    editable: (fsType & 0x0008) !== 0,
    noSubsetting: (fsType & 0x0100) !== 0,
    bitmapOnly: (fsType & 0x0200) !== 0,
  };
  // PowerPoint needs to *edit* text with the embedded face, so only
  // installable (0) / editable (8) embedding is admissible.
  let ok = false;
  let reason = '';
  if (fsType === 0) ok = true;
  else if (bits.restricted) reason = 'fsType bit1 = Restricted License (不可嵌入)';
  else if (bits.previewPrint) reason = 'fsType bit2 = Preview & Print only (只能看/打印, 不能再编辑)';
  else if (bits.editable) ok = true;
  else reason = `fsType 0x${fsType.toString(16)}: 未知/不允许的嵌入级别`;
  if (ok && bits.noSubsetting) reason = 'no-subsetting (fsType & 0x100) — 必须整字重嵌入';
  if (ok && bits.bitmapOnly) {
    ok = false;
    reason = 'bitmap-only (fsType & 0x200) — 无轮廓可嵌入';
  }
  return { ok, reason, bits };
}

// ---------------------------------------------------------------------------
// font resolution (fc-match) + collection face picking
// ---------------------------------------------------------------------------

function fcMatch(family) {
  const r = spawnSync('fc-match', ['-f', '%{file}\n', family], { encoding: 'utf8' });
  if (r.status !== 0 || !r.stdout.trim()) throw new Error(`fc-match failed for "${family}"`);
  const first = r.stdout.split('\n').map((s) => s.trim()).filter(Boolean)[0];
  if (!first) throw new Error(`fc-match returned nothing for "${family}"`);
  return first;
}

/** Pick the TTC face whose name matches `family` (falls back to face 0). */
function pickFace(buf, family) {
  if (!isCollection(buf)) return { index: 0, sfntOff: 0, name: null };
  const want = family.toLowerCase().replace(/\s+/g, '');
  const offsets = ttcOffsets(buf);
  let first = null;
  for (let i = 0; i < offsets.length; i++) {
    try {
      const info = readFontInfo(buf, offsets[i]);
      if (!first) first = { index: i, sfntOff: offsets[i], name: info.family };
      const candidates = [info.family, info.familyTypo].filter(Boolean).map((s) => s.toLowerCase().replace(/\s+/g, ''));
      if (candidates.includes(want)) return { index: i, sfntOff: offsets[i], name: info.family };
    } catch {
      /* unreadable face — skip */
    }
  }
  return first || { index: 0, sfntOff: offsets[0], name: null };
}

// ---------------------------------------------------------------------------
// subsetting via fontTools (external python, already installed in the venv)
// ---------------------------------------------------------------------------

const ALWAYS_INCLUDE = (() => {
  let s = '';
  for (let c = 0x20; c <= 0x7e; c++) s += String.fromCharCode(c);
  s += '\u00a0\u2018\u2019\u201c\u201d\u2013\u2014\u2026\u00b7\u2022\u00d7\u00a9\u00ae';
  for (let c = 0x3000; c <= 0x303f; c++) s += String.fromCharCode(c); // CJK punctuation
  return s;
})();

function pyftsubset({ python, fontFile, faceIndex, chars, outFile }) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'font-subset-'));
  const charsFile = path.join(tmp, 'chars.txt');
  fs.writeFileSync(charsFile, chars, 'utf8');
  const args = [
    '-m',
    'fontTools.subset',
    fontFile,
    `--text-file=${charsFile}`,
    `--output-file=${outFile}`,
    '--layout-features=*',
    '--glyph-names',
    '--symbol-cmap',
    '--legacy-cmap',
    '--notdef-glyph',
    '--notdef-outline',
    '--recommended-glyphs',
    '--name-IDs=*',
    '--name-legacy',
    '--name-languages=*',
  ];
  if (faceIndex > 0) args.push(`--font-number=${faceIndex}`);
  const r = spawnSync(python, args, { encoding: 'utf8' });
  if (r.status !== 0) {
    throw new Error(`pyftsubset failed (${r.status}): ${(r.stderr || r.stdout || '').split('\n').slice(-6).join('\n')}`);
  }
  fs.rmSync(tmp, { recursive: true, force: true });
  return fs.readFileSync(outFile);
}

// ---------------------------------------------------------------------------
// EOT (fntdata) container
// ---------------------------------------------------------------------------
// Layout per the W3C EOT submission / PowerPoint's own files:
//   82 B header, then  FamilyName (u16 size + UTF-16LE + NUL, u16 pad),
//   StyleName, VersionName, FullName — each size-prefixed and padded — then
//   RootString (u16 size = 0), then the raw TrueType bytes, padded to 4.
// fonteditor-core writes the same layout but emits the names as UTF-16**BE**
// and leaves out the NUL terminator, so we build the container here instead
// (and keep fonteditor-core for container decoding — see decodeToTtf).

const EOT_HEADER_SIZE = 82;

const ucs2le = (s) => {
  const clean = (s || '').replace(/\u0000/g, '');
  const out = Buffer.alloc((clean.length + 1) * 2);
  for (let i = 0; i < clean.length; i++) out.writeUInt16LE(clean.charCodeAt(i), i * 2);
  out.writeUInt16LE(0, clean.length * 2); // NUL terminator (part of the size)
  return out;
};

function buildEot(ttfBuf, info) {
  const family = ucs2le(info.family);
  const style = ucs2le(info.subfamily || 'Regular');
  const version = ucs2le(info.version || 'Version 1.00');
  const full = ucs2le(info.fullName || info.family);
  const names = [family, style, version, full];
  const namesSize = names.reduce((n, b) => n + 2 + b.length + 2, 0) + 2; // + RootString size
  const fontPad = (4 - (ttfBuf.length % 4)) % 4;
  const eotSize = EOT_HEADER_SIZE + namesSize + ttfBuf.length + fontPad;

  const head = Buffer.alloc(EOT_HEADER_SIZE);
  head.writeUInt32LE(eotSize, 0);
  head.writeUInt32LE(ttfBuf.length, 4);
  head.writeUInt32LE(0x00020001, 8); // version 2.1
  head.writeUInt32LE(0, 12); // flags: uncompressed
  info.panose.copy(head, 16); // PANOSE (from OS/2)
  head.writeUInt8(0x01, 26); // Charset = DEFAULT_CHARSET
  head.writeUInt8(info.fsSelection & 0x01 ? 1 : 0, 27); // Italic (NOT fsSelection itself)
  head.writeUInt32LE(info.weight, 28);
  head.writeUInt16LE(info.fsType, 32);
  head.writeUInt16LE(0x504c, 34); // 'LP'
  info.unicodeRange.copy(head, 36); // UnicodeRange 1..4
  info.codePageRange.copy(head, 52); // CodePageRange 1..2
  head.writeUInt32LE(info.checkSumAdjustment, 60);
  // Reserved (16 B) + Padding1 (2 B) stay zero.

  const chunks = [head];
  for (const name of names) {
    const size = Buffer.alloc(2);
    size.writeUInt16LE(name.length, 0);
    const pad = Buffer.alloc(2);
    chunks.push(size, name, pad);
  }
  chunks.push(Buffer.alloc(2)); // RootString size = 0
  chunks.push(ttfBuf);
  if (fontPad) chunks.push(Buffer.alloc(fontPad));
  const out = Buffer.concat(chunks);
  if (out.length !== eotSize) throw new Error(`EOT size mismatch: ${out.length} != ${eotSize}`);
  return out;
}

/** Parse an EOT back out — used by the self-check. */
function parseEot(buf) {
  if (buf.length < EOT_HEADER_SIZE) throw new Error('EOT too short');
  const magic = buf.readUInt16LE(34);
  if (magic !== 0x504c) throw new Error(`bad EOT magic 0x${magic.toString(16)}`);
  const eotSize = buf.readUInt32LE(0);
  const fontDataSize = buf.readUInt32LE(4);
  const version = buf.readUInt32LE(8);
  const fsType = buf.readUInt16LE(32);
  let off = EOT_HEADER_SIZE;
  const names = {};
  for (const key of ['family', 'style', 'version', 'full']) {
    const size = buf.readUInt16LE(off);
    off += 2;
    let s = '';
    for (let i = 0; i + 1 < size; i += 2) {
      const code = buf.readUInt16LE(off + i);
      if (code === 0) break;
      s += String.fromCharCode(code);
    }
    names[key] = s;
    off += size + 2;
  }
  const rootSize = buf.readUInt16LE(off);
  off += 2 + rootSize;
  const fontData = buf.subarray(off, off + fontDataSize);
  return { eotSize, fontDataSize, version, fsType, names, fontData, fontOffset: off };
}

// ---------------------------------------------------------------------------
// any font container -> TTF (fonteditor-core)
// ---------------------------------------------------------------------------

function sniff(buf) {
  const sig = buf.toString('latin1', 0, 4);
  if (sig === 'wOF2') return 'woff2';
  if (sig === 'wOFF') return 'woff';
  if (sig === 'OTTO') return 'otf';
  if (sig === 'ttcf') return 'ttc';
  return 'ttf';
}

async function decodeToTtf(buf, type) {
  if (type === 'ttf' || type === 'ttc') return buf;
  const fonteditor = (await import('fonteditor-core')).default;
  if (type === 'woff2') await fonteditor.woff2.init();
  const font = fonteditor.Font.create(buf, { type, hinting: true, inflate: undefined });
  const ttf = font.write({ type: 'ttf', toBuffer: true });
  return Buffer.isBuffer(ttf) ? ttf : Buffer.from(ttf);
}

// ---------------------------------------------------------------------------
// deck inspection: fonts requested, and which characters each one sees
// ---------------------------------------------------------------------------

function decodeXmlEntities(s) {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, '&');
}

const escAttr = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

const TEXT_PARTS = /^ppt\/(slides|slideLayouts|slideMasters|notesSlides|notesMasters|handoutMasters|charts)\/[^/]+\.xml$/;

async function collectTextAsync(zip) {
  const perFont = new Map();
  const all = new Set();
  const add = (tf, text) => {
    if (!text) return;
    if (!perFont.has(tf)) perFont.set(tf, new Set());
    const set = perFont.get(tf);
    for (const ch of text) {
      all.add(ch);
      set.add(ch);
    }
  };
  for (const name of Object.keys(zip.files)) {
    if (!TEXT_PARTS.test(name) || zip.files[name].dir) continue;
    const xml = await zip.file(name).async('string');
    // runs carry their own typeface; fall back to the whole-part union
    for (const m of xml.matchAll(/<(a:(?:r|fld))>([\s\S]*?)<\/\1>/g)) {
      const chunk = m[2];
      const tf = (chunk.match(/<a:latin[^>]*typeface="([^"]+)"/) || chunk.match(/typeface="([^"]+)"/) || [])[1];
      const texts = [...chunk.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map((x) => decodeXmlEntities(x[1]));
      if (!texts.length) continue;
      add(tf || '\u0000unknown', texts.join(''));
    }
  }
  return { perFont, all };
}

/** All typefaces the deck asks for, with usage counts (for --list). */
async function listTypefaces(zip) {
  const counts = new Map();
  for (const name of Object.keys(zip.files)) {
    if (!TEXT_PARTS.test(name) || zip.files[name].dir) continue;
    const xml = await zip.file(name).async('string');
    for (const m of xml.matchAll(/typeface="([^"]+)"/g)) {
      const tf = m[1];
      if (!tf || tf.startsWith('+')) continue;
      counts.set(tf, (counts.get(tf) || 0) + 1);
    }
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}

// ---------------------------------------------------------------------------
// OOXML injection
// ---------------------------------------------------------------------------

function addEmbeddedFontLst(presXml, entries) {
  let xml = presXml;
  const openTag = xml.match(/<p:presentation\b[^>]*>/);
  if (openTag && !/embedTrueTypeFonts=/.test(openTag[0])) {
    xml = xml.replace(openTag[0], openTag[0].replace(/<p:presentation\b/, '<p:presentation embedTrueTypeFonts="1"'));
  }
  const body = entries
    .map((e) => {
      let s = `<p:embeddedFont><p:font typeface="${escAttr(e.typeface)}"/>`;
      for (const slot of ['regular', 'bold', 'italic', 'boldItalic']) {
        if (e.slots[slot]) s += `<p:${slot} r:id="${e.slots[slot]}"/>`;
      }
      return s + '</p:embeddedFont>';
    })
    .join('');
  const existing = xml.match(/<p:embeddedFontLst>[\s\S]*?<\/p:embeddedFontLst>/);
  if (existing) return xml.replace(existing[0], existing[0].replace('</p:embeddedFontLst>', body + '</p:embeddedFontLst>'));
  if (/<p:embeddedFontLst\/>/.test(xml)) return xml.replace('<p:embeddedFontLst/>', `<p:embeddedFontLst>${body}</p:embeddedFontLst>`);
  // schema order: ... sldSz, notesSz, embeddedFontLst, defaultTextStyle ...
  const anchor = xml.match(/<p:notesSz[^>]*\/>/) || xml.match(/<p:sldSz[^>]*\/>/);
  const block = `<p:embeddedFontLst>${body}</p:embeddedFontLst>`;
  if (anchor) return xml.replace(anchor[0], anchor[0] + block);
  if (/<p:defaultTextStyle/.test(xml)) return xml.replace('<p:defaultTextStyle', block + '<p:defaultTextStyle');
  return xml.replace('</p:presentation>', block + '</p:presentation>');
}

function addFontRels(relsXml, rels) {
  const body = rels
    .map((r) => `<Relationship Id="${escAttr(r.id)}" Type="${REL_FONT}" Target="fonts/${escAttr(r.file)}"/>`)
    .join('');
  return relsXml.replace('</Relationships>', body + '</Relationships>');
}

function ensureContentType(ctXml) {
  if (/Extension="fntdata"/i.test(ctXml)) return ctXml;
  return ctXml.replace('</Types>', '<Default Extension="fntdata" ContentType="application/x-fontdata"/></Types>');
}

function nextFontName(partNames) {
  let max = 0;
  for (const n of partNames) {
    const m = n.match(/^ppt\/fonts\/(\d+)\.fntdata$/);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `${max + 1}.fntdata`;
}

function nextRid(relsXml) {
  let max = 0;
  for (const m of relsXml.matchAll(/Id="rId(\d+)"/g)) max = Math.max(max, Number(m[1]));
  return `rId${max + 1}`;
}

async function rewriteTypefacesAsync(zip, maps) {
  const changed = new Map();
  const pairs = Object.entries(maps).filter(([a, b]) => a && b && a !== b);
  if (!pairs.length) return changed;
  for (const name of Object.keys(zip.files)) {
    if (!/^ppt\/(slides|slideLayouts|slideMasters|notesSlides|notesMasters|handoutMasters|theme)\/.*\.xml$/.test(name)) continue;
    if (zip.files[name].dir) continue;
    let xml = await zip.file(name).async('string');
    let touched = false;
    for (const [from, to] of pairs) {
      const needle = `typeface="${from}"`;
      if (xml.includes(needle)) {
        xml = xml.split(needle).join(`typeface="${to}"`);
        touched = true;
        changed.set(from, (changed.get(from) || 0) + 1);
      }
    }
    if (touched) zip.file(name, xml);
  }
  return changed;
}

// ---------------------------------------------------------------------------
// verification
// ---------------------------------------------------------------------------

function zipCentralDirectory(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a zip (no EOCD)');
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const entries = [];
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) throw new Error('bad central directory entry');
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const uncompSize = buf.readUInt32LE(off + 24);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const name = buf.toString('utf8', off + 46, off + 46 + nameLen);
    entries.push({ name, method, compSize, uncompSize });
    off += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', ...opts });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '', error: r.error };
}

async function verifyDeck(file, { python, wantFonts = [] } = {}) {
  const buf = fs.readFileSync(file);
  const zip = await JSZip.loadAsync(buf);
  const parts = Object.keys(zip.files).filter((n) => !zip.files[n].dir);
  const ct = await zip.file('[Content_Types].xml').async('string');
  const pres = await zip.file('ppt/presentation.xml').async('string');
  const rels = await zip.file('ppt/_rels/presentation.xml.rels').async('string');

  // ---- (1) the four injection points ----
  const fntParts = parts.filter((n) => /^ppt\/fonts\/.*\.fntdata$/.test(n));
  const relTargets = new Map();
  for (const m of rels.matchAll(/<Relationship\b[^>]*Type="[^"]*\/font"[^>]*>/g)) {
    const tag = m[0];
    const id = (tag.match(/Id="([^"]+)"/) || [])[1];
    const target = (tag.match(/Target="([^"]+)"/) || [])[1];
    if (id && target) relTargets.set(id, path.posix.join('ppt', target));
  }
  const embedded = [];
  const lst = pres.match(/<p:embeddedFontLst>[\s\S]*?<\/p:embeddedFontLst>/);
  if (lst) {
    for (const m of lst[0].matchAll(/<p:embeddedFont>([\s\S]*?)<\/p:embeddedFont>/g)) {
      const block = m[1];
      const typeface = (block.match(/<p:font[^>]*typeface="([^"]+)"/) || [])[1] || '';
      const slots = {};
      for (const s of ['regular', 'bold', 'italic', 'boldItalic']) {
        const r = block.match(new RegExp(`<p:${s}[^>]*r:id="([^"]+)"`));
        if (r) slots[s] = r[1];
      }
      embedded.push({ typeface, slots });
    }
  }
  const ridsResolve = embedded.every((e) => Object.values(e.slots).every((id) => relTargets.has(id)));
  const targetsExist = [...relTargets.values()].every((t) => parts.includes(t));
  const contentTypeOk = /Extension="fntdata"[^>]*ContentType="application\/x-fontdata"/i.test(ct);
  const eotHeaders = [];
  for (const p of fntParts) {
    const bytes = await zip.file(p).async('nodebuffer');
    let info = null;
    try {
      const parsed = parseEot(bytes);
      info = {
        part: p,
        bytes: bytes.length,
        magic: '0x504c',
        version: `0x${parsed.version.toString(16)}`,
        fontDataSize: parsed.fontDataSize,
        family: parsed.names.family,
        style: parsed.names.style,
        fsType: `0x${parsed.fsType.toString(16).padStart(4, '0')}`,
        embeddedTtfSig: parsed.fontData.toString('latin1', 0, 4).replace(/[^ -~]/g, '.'),
        ok: true,
      };
    } catch (err) {
      const sig = bytes.toString('latin1', 0, 4);
      info = {
        part: p,
        bytes: bytes.length,
        magic: `raw:${JSON.stringify(sig)}`,
        ok: false,
        note: 'not an EOT container (could be raw TTF)',
        embeddedTtfSig: sig.replace(/[^ -~]/g, '.'),
      };
    }
    eotHeaders.push(info);
  }
  const check1 = {
    name: '① 解包结构 (fntdata + embeddedFontLst + rels + Content_Types)',
    ok: fntParts.length > 0 && embedded.length > 0 && ridsResolve && targetsExist && contentTypeOk && eotHeaders.every((e) => e.ok),
    detail: {
      fntdataParts: fntParts.length,
      embeddedFonts: embedded.map((e) => ({ typeface: e.typeface, slots: e.slots })),
      relsFontCount: relTargets.size,
      ridsResolve,
      targetsExist,
      contentTypeOk,
      fntdata: eotHeaders,
    },
  };

  // ---- (2) zip: every entry DEFLATE ----
  const cd = zipCentralDirectory(buf);
  const real = cd.filter((e) => !e.name.endsWith('/'));
  const stored = real.filter((e) => e.method !== 8);
  const check2 = {
    name: '② zip 压缩方式 (全部 DEFLATE)',
    ok: stored.length === 0,
    detail: {
      entries: real.length,
      deflate: real.length - stored.length,
      store: stored.length,
      storedEntries: stored.map((e) => e.name),
    },
  };

  // ---- (3) python-pptx re-open ----
  const py = run(python, [
    '-c',
    'import sys; from pptx import Presentation; p=Presentation(sys.argv[1]); print("slides=%d size=%dx%d" % (len(p.slides), p.slide_width, p.slide_height))',
    file,
  ]);
  const pptxOk = py.status === 0 && /slides=\d+/.test(py.stdout);
  const check3 = {
    name: '③ python-pptx 重开',
    ok: pptxOk,
    detail: { exit: py.status, out: (py.stdout || '').trim(), err: (py.stderr || '').trim().split('\n').slice(-3).join('\n') },
  };

  // ---- (4) LibreOffice re-render ----
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'font-embed-render-'));
  const src = path.join(tmp, 'deck.pptx');
  fs.copyFileSync(file, src);
  const conv = run('soffice', ['--headless', '--convert-to', 'pdf', '--outdir', tmp, src], {
    timeout: 180000,
    env: { ...process.env, FONTCONFIG_FILE },
  });
  const pdf = path.join(tmp, 'deck.pdf');
  const pdfExists = fs.existsSync(pdf) && fs.statSync(pdf).size > 1024;
  let pdfFonts = '';
  if (pdfExists) {
    const r = run('pdffonts', [pdf]);
    pdfFonts = r.status === 0 ? r.stdout : '';
  }
  const check4 = {
    name: '④ LibreOffice 回渲 (soffice --convert-to pdf)',
    ok: pdfExists,
    detail: {
      exit: conv.status,
      pdfBytes: pdfExists ? fs.statSync(pdf).size : 0,
      err: (conv.stderr || '').trim().split('\n').slice(-3).join('\n'),
      fontsInPdf: pdfFonts.split('\n').filter((l) => /yes/.test(l)).map((l) => l.split(/\s+/)[0]).slice(0, 12),
      matchesRequested: wantFonts.filter((f) => pdfFonts.includes(f.replace(/\s+/g, '')) || pdfFonts.includes(f)),
    },
  };
  if (!pdfExists && conv.error) check4.detail.err = String(conv.error.message || conv.error);
  fs.rmSync(tmp, { recursive: true, force: true });

  return { checks: [check1, check2, check3, check4], zipParts: parts.length, embedded };
}

// ---------------------------------------------------------------------------
// main flow
// ---------------------------------------------------------------------------

async function embed(opts) {
  const t0 = Date.now();
  const inBytes = fs.statSync(opts.input).size;
  const zip = await JSZip.loadAsync(fs.readFileSync(opts.input));
  if (!zip.file('ppt/presentation.xml')) throw new Error('not a pptx: ppt/presentation.xml missing');
  const partNames = () => Object.keys(zip.files).filter((n) => !zip.files[n].dir);

  let presXml = await zip.file('ppt/presentation.xml').async('string');
  let relsXml = await zip.file('ppt/_rels/presentation.xml.rels').async('string');
  let ctXml = await zip.file('[Content_Types].xml').async('string');

  // --- typeface remap (opt-in) -------------------------------------------
  const remapped = await rewriteTypefacesAsync(zip, opts.maps);
  if (remapped.size) {
    log(`\n↺ typeface remap: ${[...remapped].map(([k, v]) => `${k} → ${opts.maps[k]} (${v} parts)`).join(', ')}`);
    presXml = await zip.file('ppt/presentation.xml').async('string');
  }

  // --- what the deck uses -------------------------------------------------
  const { perFont, all } = await collectTextAsync(zip);
  const usedTypefaces = await listTypefaces(zip);
  log(`\ndeck: ${path.relative(process.cwd(), opts.input)} (${(inBytes / 1024).toFixed(0)} KiB)`);
  log(`typefaces in use: ${usedTypefaces.map(([f, n]) => `${f}(${n})`).join(', ') || '(none)'}`);
  log(`text characters in deck: ${all.size}`);

  // --- resolve + gate every requested face --------------------------------
  const faces = [];
  for (const spec of opts.fonts) {
    const family = spec.family;
    let file = spec.file;
    let auto = false;
    if (!file) {
      file = fcMatch(family);
      auto = true;
    }
    if (!fs.existsSync(file)) throw new Error(`font file not found: ${file}`);
    const raw = fs.readFileSync(file);
    const container = sniff(raw);
    const face = pickFace(raw, family);
    const info = readFontInfo(raw, face.sfntOff);
    const gate = licenseGate(info.fsType);
    const record = {
      family,
      internalFamily: info.family,
      file,
      auto,
      container,
      faceIndex: face.index,
      weight: info.weight,
      style: info.subfamily,
      fsType: `0x${info.fsType.toString(16).padStart(4, '0')}`,
      glyphs: info.numGlyphs,
      originalBytes: raw.length,
      gate,
      slot: /bold/i.test(info.subfamily || '') || info.weight >= 600 ? 'bold' : 'regular',
    };
    faces.push(record);
  }

  // slot collision: regular/bold for the same family
  const embeddable = [];
  for (const f of faces) {
    if (!f.gate.ok) {
      warn(`skip "${f.family}" (${path.basename(f.file)}): ${f.gate.reason}`);
      continue;
    }
    if (f.internalFamily && f.internalFamily.toLowerCase() !== f.family.toLowerCase()) {
      warn(`"${f.family}" resolves to internal name "${f.internalFamily}" — PowerPoint matches <p:font typeface> to the font's own name, keep them equal`);
    }
    embeddable.push(f);
  }
  if (!embeddable.length) {
    log('\n✗ nothing embeddable (all faces denied by fsType). Deck left untouched.');
    return { status: 'denied', faces };
  }
  // de-dup on (family, slot)
  const seen = new Set();
  const chosen = embeddable.filter((f) => {
    const k = `${f.family}\u0000${f.slot}`;
    if (seen.has(k)) {
      warn(`duplicate ${f.family} ${f.slot} face ignored: ${f.file}`);
      return false;
    }
    seen.add(k);
    return true;
  });

  // skip families already embedded
  const existingLst = presXml.match(/<p:embeddedFontLst>[\s\S]*?<\/p:embeddedFontLst>/);
  const already = new Set(
    existingLst ? [...existingLst[0].matchAll(/<p:font[^>]*typeface="([^"]+)"/g)].map((m) => m[1]) : []
  );
  const toEmbed = chosen.filter((f) => {
    if (already.has(f.family)) {
      warn(`"${f.family}" is already in <p:embeddedFontLst> — skipped (delete that entry first to replace it)`);
      return false;
    }
    return true;
  });
  if (!toEmbed.length) {
    log('\n✗ every requested family is either denied or already embedded.');
    return { status: 'noop', faces };
  }

  // --- subset -> EOT ------------------------------------------------------
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'font-embed-'));
  const reports = [];
  for (const f of toEmbed) {
    const chars = new Set([...ALWAYS_INCLUDE]);
    const own = perFont.get(f.family);
    if (own) for (const c of own) chars.add(c);
    // runs whose typeface we could not attribute still need glyphs
    const unknown = perFont.get('\u0000unknown');
    if (unknown) for (const c of unknown) chars.add(c);
    if (!own && !unknown) for (const c of all) chars.add(c);
    const text = [...chars].join('');

    let ttfBuf = fs.readFileSync(f.file);
    const container = sniff(ttfBuf);
    if (container === 'ttc') {
      // slice the face out of the collection first (fontTools can also do it, but
      // a bare TTF keeps the EOT path simple)
      ttfBuf = await extractFace(ttfBuf, f.faceIndex);
    } else if (container !== 'ttf') {
      ttfBuf = await decodeToTtf(ttfBuf, container);
    }
    // CFF/OTF -> TrueType outlines: EOT carries glyf
    if (sniff(ttfBuf) === 'otf' || !readFontInfo(ttfBuf, 0).glyf) {
      ttfBuf = await decodeToTtf(ttfBuf, 'otf');
      if (!readFontInfo(ttfBuf, 0).glyf) warn(`"${f.family}" has no glyf outlines; EOT may not be editable in PowerPoint`);
    }

    const preSubsetBytes = ttfBuf.length;
    let subsetBuf = ttfBuf;
    const doSubset = opts.subset && !f.gate.bits.noSubsetting;
    if (f.gate.bits.noSubsetting) warn(`"${f.family}": fsType no-subsetting — embedding the full face`);
    if (doSubset) {
      const outFile = path.join(work, `${f.family.replace(/[^\w.-]+/g, '_')}-${f.slot}.ttf`);
      const ttfPath = path.join(work, `${f.family.replace(/[^\w.-]+/g, '_')}-${f.slot}.src.ttf`);
      fs.writeFileSync(ttfPath, ttfBuf);
      subsetBuf = pyftsubset({ python: opts.python, fontFile: ttfPath, faceIndex: 0, chars: text, outFile });
    }

    const subInfo = readFontInfo(subsetBuf, 0);
    const eot = buildEot(subsetBuf, subInfo);
    // self-check: our own container must round-trip exactly
    const parsed = parseEot(eot);
    if (parsed.fontData.length !== subsetBuf.length || !parsed.fontData.equals(subsetBuf)) {
      throw new Error(`EOT self-check failed for ${f.family}`);
    }
    if (parsed.fsType !== subInfo.fsType) {
      throw new Error('EOT fsType mismatch');
    }

    f.eotBytes = eot.length;
    f.subsetBytes = subsetBuf.length;
    f.preSubsetBytes = preSubsetBytes;
    f.subsetGlyphs = subInfo.numGlyphs;
    f.subsetChars = chars.size;
    f.eotFamily = subInfo.family;
    reports.push({
      family: f.family,
      slot: f.slot,
      file: f.file,
      container,
      fsType: f.fsType,
      license: f.gate.bits,
      chars: chars.size,
      glyphsBefore: f.glyphs,
      glyphsAfter: subInfo.numGlyphs,
      originalBytes: f.originalBytes,
      ttfBytes: preSubsetBytes,
      subsetBytes: subsetBuf.length,
      eotBytes: eot.length,
      subsetRatio: doSubset ? Number((subsetBuf.length / preSubsetBytes).toFixed(4)) : 1,
    });
    f.eot = eot;
  }
  fs.rmSync(work, { recursive: true, force: true });

  // --- inject -------------------------------------------------------------
  const entries = [];
  const relAdds = [];
  for (const f of toEmbed) {
    const fileName = nextFontName(partNames());
    const rid = nextRid(relsXml);
    zip.file(`ppt/fonts/${fileName}`, f.eot);
    relsXml = relsXml.replace(
      '</Relationships>',
      `<Relationship Id="${rid}" Type="${REL_FONT}" Target="fonts/${fileName}"/></Relationships>`
    );
    let entry = entries.find((e) => e.typeface === f.family);
    if (!entry) {
      entry = { typeface: f.family, slots: {} };
      entries.push(entry);
    }
    entry.slots[f.slot] = rid;
    relAdds.push({ id: rid, file: fileName, family: f.family, slot: f.slot });
    log(`  + ${f.family} [${f.slot}] ${path.basename(f.file)} → ppt/fonts/${fileName} (${(f.eotBytes / 1024).toFixed(0)} KiB, ${f.subsetChars} chars, ${f.subsetGlyphs}/${f.glyphs} glyphs)`);
  }

  presXml = addEmbeddedFontLst(presXml, entries);
  ctXml = ensureContentType(ctXml);
  // (rels were appended in-loop)
  zip.file('ppt/presentation.xml', presXml);
  zip.file('ppt/_rels/presentation.xml.rels', relsXml);
  zip.file('[Content_Types].xml', ctXml);

  // zip: drop directory entries (they are STOREd and PowerPoint does not need
  // them); delete the entry only — zip.remove() on a folder is recursive.
  for (const name of Object.keys(zip.files)) if (zip.files[name].dir) delete zip.files[name];
  const outBuf = await zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 9 },
    platform: 'UNIX',
  });
  fs.mkdirSync(path.dirname(path.resolve(opts.output)), { recursive: true });
  fs.writeFileSync(opts.output, outBuf);

  const outBytes = outBuf.length;
  const result = {
    input: opts.input,
    output: opts.output,
    bytesBefore: inBytes,
    bytesAfter: outBytes,
    deltaBytes: outBytes - inBytes,
    deltaPct: Number((((outBytes - inBytes) / inBytes) * 100).toFixed(1)),
    fontsRequested: faces.length,
    fontsEmbedded: toEmbed.length,
    skipped: faces.filter((f) => !f.gate.ok).map((f) => ({ family: f.family, file: f.file, reason: f.gate.reason })),
    remapped: Object.fromEntries(remapped),
    fonts: reports,
    rels: relAdds,
    elapsedMs: Date.now() - t0,
  };

  log(`\nwrote ${path.relative(process.cwd(), opts.output)}: ${(inBytes / 1024).toFixed(0)} KiB → ${(outBytes / 1024).toFixed(0)} KiB (${result.deltaBytes >= 0 ? '+' : ''}${(result.deltaBytes / 1024).toFixed(0)} KiB, ${result.deltaPct >= 0 ? '+' : ''}${result.deltaPct}%)`);

  if (opts.verify) {
    const v = await verifyDeck(opts.output, { python: opts.python, wantFonts: toEmbed.map((f) => f.eotFamily || f.family) });
    result.verification = v.checks;
    log('\n验证:');
    for (const c of v.checks) log(`  ${c.ok ? '✓' : '✗'} ${c.name}`);
    result.verificationOk = v.checks.every((c) => c.ok);
  }

  const jsonPath = opts.json || `${opts.output}.font-embed.json`;
  fs.writeFileSync(jsonPath, JSON.stringify(result, null, 2));
  log(`\nreport: ${path.relative(process.cwd(), jsonPath)}`);
  return result;
}

/** Slice face `index` out of a TTC by rebuilding the sfnt with only that face's tables. */
async function extractFace(ttcBuf, index) {
  const offsets = ttcOffsets(ttcBuf);
  if (index < 0 || index >= offsets.length) throw new Error('TTC face index out of range');
  const off = offsets[index];
  const { tables } = tablesAt(ttcBuf, off);
  const ordered = Object.entries(tables);
  const headerSize = 12 + ordered.length * 16;
  const dir = Buffer.alloc(headerSize);
  ttcBuf.copy(dir, 0, off, off + 12); // sfntVersion + search args
  dir.writeUInt16BE(ordered.length, 4);
  const parts = [];
  let cursor = headerSize;
  ordered.forEach(([tag, t], i) => {
    const data = Buffer.from(ttcBuf.subarray(t.offset, t.offset + t.length));
    const pad = (4 - (data.length % 4)) % 4;
    const p = headerSize + i * 16;
    dir.write(tag, p, 4, 'latin1');
    dir.writeUInt32BE(0, p + 4); // checksum: not validated by PowerPoint for fntdata
    dir.writeUInt32BE(cursor, p + 8);
    dir.writeUInt32BE(data.length, p + 12);
    parts.push(data, Buffer.alloc(pad));
    cursor += data.length + pad;
  });
  return Buffer.concat([dir, ...parts]);
}

// ---------------------------------------------------------------------------
// entry point
// ---------------------------------------------------------------------------

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`error: ${err.message}\n\n${USAGE}`);
    process.exit(1);
  }
  if (opts.mode === 'help') {
    console.log(USAGE);
    return;
  }
  try {
    if (opts.mode === 'list') {
      const zip = await JSZip.loadAsync(fs.readFileSync(opts.input));
      const typefaces = await listTypefaces(zip);
      const { all } = await collectTextAsync(zip);
      console.log(`\n${opts.input}\n  typefaces: ${typefaces.map(([f, n]) => `${f} (${n} refs)`).join(', ') || '(none)'}\n  characters: ${all.size}\n`);
      const lst = (await zip.file('ppt/presentation.xml').async('string')).match(/<p:embeddedFontLst>[\s\S]*?<\/p:embeddedFontLst>/);
      if (lst) console.log(`  already embedded: ${[...lst[0].matchAll(/<p:font[^>]*typeface="([^"]+)"/g)].map((m) => m[1]).join(', ')}\n`);
      return;
    }
    if (opts.mode === 'verify') {
      const v = await verifyDeck(opts.input, { python: opts.python });
      console.log('');
      for (const c of v.checks) {
        console.log(`${c.ok ? '✓' : '✗'} ${c.name}`);
        console.log(`   ${JSON.stringify(c.detail).slice(0, 600)}`);
      }
      if (opts.json) fs.writeFileSync(opts.json, JSON.stringify(v, null, 2));
      process.exit(v.checks.every((c) => c.ok) ? 0 : 1);
    }
    if (!opts.fonts.length) {
      console.error('error: at least one --font (or --list / --verify) is required');
      process.exit(1);
    }
    const res = await embed(opts);
    if (res.status === 'denied') process.exit(2);
  } catch (err) {
    console.error(`\nerror: ${err.stack || err.message}`);
    process.exit(1);
  }
}

main();
