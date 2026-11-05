#!/usr/bin/env node
/*
 * validate.js - minimum-viable validator for the singulari-tree documentation corpus.
 *
 * Adapted from "documentation-onrails" validate.js (MIT). Plain, zero-dependency
 * Node.js (CommonJS). No package.json, no npm install.
 *
 *   node tools/docs/validate.js          -> check mode: STRICTLY read-only, never writes.
 *   node tools/docs/validate.js --write  -> regenerate the two generated regions IN
 *                                           EXISTING FILES ONLY (never creates index.md /
 *                                           tag-index.md), write-if-diff, then run the
 *                                           full check.
 *
 * The corpus lives under <repo>/docs; REPO is its parent. Every reported path is
 * POSIX-relative to REPO (so it carries the `docs/` prefix).
 *
 * Output: one finding per line `path:line -- check-name: message`, then
 * `N error(s), M warning(s) -- files scanned: K`. Exit 1 iff N > 0.
 * --write's `wrote: <path>` notices go to STDERR so STDOUT keeps exactly the
 * documented findings + summary shape.
 *
 * Link-scan exemptions: ``` fenced blocks are exempt from wikilink scanning,
 * and wikilinks inside inline code spans (`[[stem]]`) are skipped too. The
 * inline-code exemption applies to WIKILINKS ONLY: markdown links stay live
 * even when backticked, and secret scanning keeps the fenced-blocks-only
 * exemption (inline code can still hide a secret).
 *
 * Legacy debt: the whole `docs/context/git-client` tree (LEGACY_UNSCANNED) is
 * never scanned and never counted.
 */
'use strict';

const fs = require('fs');
const path = require('path');

// ----------------------------- Configuration ------------------------------

// CWD-independent: CORPUS is the docs root, REPO its parent.
const CORPUS = path.resolve(__dirname, '..', '..', 'docs');
const REPO = path.resolve(CORPUS, '..');
const WRITE_MODE = process.argv.slice(2).includes('--write');
const DASH = '\u2014';  // U+2014 in output; written as an escape so the source is pure ASCII
const ELL = '\u2026';   // U+2026 in secret redaction sketches

// Accepted debt: never scanned, never counted.
const LEGACY_UNSCANNED = 'context/git-client';

// Lifecycle enum for `status` (both contracts).
const STATUS_ENUM = new Set(['draft', 'active', 'superseded', 'expired']);

// Note-family contract: 7 required + 3 optional.
const NOTE_REQUIRED = ['id', 'category', 'tags', 'aliases', 'related', 'version', 'status'];
const NOTE_OPTIONAL = ['supersedes', 'expires_at', 'moved_from'];
// Context-doc contract: 5 required + 2 optional.
const CTX_REQUIRED = ['last_updated', 'status', 'description', 'tags', 'version'];
const CTX_OPTIONAL = ['related', 'moved_from'];
// project.md = context-doc entry point + one extra required key.
const ENTRY_EXTRA = 'doc_language';

// Which keys must be scalars per contract (everything else present is a list).
const NOTE_SCALARS = new Set(['id', 'category', 'version', 'status', 'supersedes', 'expires_at']);
const CTX_SCALARS = new Set(['last_updated', 'status', 'description', 'version', ENTRY_EXTRA]);

// Corpus-relative paths of the generated artifacts: rel -> region marker name.
const GENERATED_ARTIFACTS = [
  { corsRel: 'index.md', marker: 'index' },
  { corsRel: 'tag-index.md', marker: 'tags' },
];

// The entry point of the corpus (used by missing-from-hub).
const ENTRY_POINT = 'project.md';

const NOTE_CLASSES = new Set(['note', 'hub', 'adr', 'protocol']);

// The lowercase kebab-case naming rule shares the `id` slug shape. README.md is
// the single documented conventional exemption.
const NAME_EXEMPT = new Set(['README.md']);

// ----------------------------- File collection & classification ------------------------------

/** Recursively collect all .md files under dir as REPO-relative POSIX paths.
 *  `.git` and any folder named `diagrams` are skipped entirely; the
 *  LEGACY_UNSCANNED subtree is pruned; non-.md files are never collected. */
function collectMarkdown(dir, out) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.name === '.git' || ent.name === 'diagrams') continue;
    const abs = path.join(dir, ent.name);
    const corsRel = path.relative(CORPUS, abs).split(path.sep).join('/');
    if (corsRel === LEGACY_UNSCANNED || corsRel.startsWith(LEGACY_UNSCANNED + '/')) continue;
    if (ent.isDirectory()) collectMarkdown(abs, out);
    else if (ent.isFile() && ent.name.toLowerCase().endsWith('.md')) {
      out.push(path.relative(REPO, abs).split(path.sep).join('/'));
    }
  }
  out.sort();
}

/** File classification, path-based, on the path relative to CORPUS. Order
 *  matters: project.md -> context-entry; root index.md/tag-index.md ->
 *  generated artifact (BEFORE the hub rule, else tag-index.md looks like a hub
 *  by name); schema folders win over the generic `*-index.md` hub rule so an
 *  ADR whose filename merely ends in `-index.md` is NOT mistaken for a folder
 *  hub (adrs/adr-index.md is the one real hub there); then any `*-index.md` ->
 *  hub; context/ -> context-doc; protocols/ -> protocol; rest -> note. */
function classify(corsRel) {
  if (corsRel === ENTRY_POINT) return 'context-entry';
  if (corsRel === 'index.md' || corsRel === 'tag-index.md') return 'generated';
  const dir = corsRel.includes('/') ? corsRel.slice(0, corsRel.lastIndexOf('/')) : '';
  const base = corsRel.slice(corsRel.lastIndexOf('/') + 1);
  if (dir === 'adrs') return base === 'adr-index.md' ? 'hub' : 'adr';
  if (dir === 'protocols') return 'protocol';
  if (base.endsWith('-index.md')) return 'hub';
  if (dir === 'context') return 'context-doc';
  return 'note';
}

// ----------------------------- Minimal YAML-subset frontmatter parser ------------------------------

function unquote(s) {
  if (s.length >= 2 && ((s[0] === '"' && s.endsWith('"')) || (s[0] === "'" && s.endsWith("'")))) {
    return s.slice(1, -1);
  }
  return s;
}

/** Parse frontmatter between the FIRST pair of `---` lines. Returns
 *  { entries: Map<key, entry>, end } or null. entry.kind: 'scalar' (.value) |
 *  'list' (.items) | 'blank'; each entry carries its key line (1-based).
 *  Rules: split at the FIRST colon (values may contain colons); `key: [a, b]`
 *  inline list; `key:` + following `- item` lines block list (column 0 allowed);
 *  lines whose first non-space char is `#` are COMMENTS and skipped -- a commented
 *  optional example must NOT parse as a blank; quoted scalars unquoted. */
function parseFrontmatter(lines) {
  if (lines.length === 0 || lines[0].trim() !== '---') return null;
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') { end = i; break; }
  }
  if (end < 0) return null;

  const entries = new Map();
  let i = 1;
  while (i < end) {
    const raw = lines[i];
    const t = raw.trim();
    if (t === '' || t.startsWith('#')) { i++; continue; }
    const m = /^([^:\s][^:]*):\s*(.*)$/.exec(raw);
    if (!m) { i++; continue; } // outside the subset -- ignore silently
    const key = m[1];
    const rest = m[2].trim();
    if (rest === '') {
      const items = [];
      let j = i + 1;
      while (j < end) {
        const s = lines[j].trim();
        if (!s.startsWith('-') || s.startsWith('#')) break;
        items.push(unquote(s.replace(/^-\s*/, '').trim()));
        j++;
      }
      entries.set(key, items.length ? { kind: 'list', items, line: i + 1 } : { kind: 'blank', line: i + 1 });
      i = j;
    } else if (rest.startsWith('[') && rest.endsWith(']')) {
      const inner = rest.slice(1, -1).trim();
      entries.set(key, { kind: 'list', items: inner === '' ? [] : inner.split(',').map((x) => unquote(x.trim())), line: i + 1 });
      i++;
    } else {
      entries.set(key, { kind: 'scalar', value: unquote(rest), line: i + 1 });
      i++;
    }
  }
  return { entries, end };
}

// ----------------------------- Small helpers ------------------------------

function isValidDate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s));
  if (!m) return false;
  return m[2] >= 1 && m[2] <= 12 && m[3] >= 1 && m[3] <= 31;
}
function isValidVersion(s) { return /^\d+(\.\d+){0,2}$/.test(String(s).trim()); } // MAJOR[.MINOR[.PATCH]]
const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
function todayISO() {
  const d = new Date(), p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function ciCompare(a, b) { // case-insensitive alphabetical, code-point tie-break
  const la = a.toLowerCase(), lb = b.toLowerCase();
  return la < lb ? -1 : la > lb ? 1 : a < b ? -1 : a > b ? 1 : 0;
}

/** Boolean mask, true = line is inside a ```/~~~ fenced block. The fence-toggle
 *  line itself counts as inside. */
function fenceMask(lines) {
  const mask = new Array(lines.length).fill(false);
  let open = false;
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (t.startsWith('```') || t.startsWith('~~~')) { open = !open; mask[i] = true; continue; }
    mask[i] = open;
  }
  return mask;
}

/** [start, end) spans of inline code (backtick spans) on a SINGLE line. A
 *  wikilink inside such a span is a CITATION of the syntax, not a live link. */
function inlineCodeSpans(line) {
  const spans = [];
  for (const m of line.matchAll(/`([^`]*)`/g)) spans.push([m.index, m.index + m[0].length]);
  return spans;
}

// ----------------------------- Loading & the ONE resolver ------------------------------

/** One resolver, case-insensitive: a target string resolves to a file if it
 *  matches its rel path (REPO- or corpus-relative), filename stem, id, or any
 *  alias. First-wins over rel-sorted files keeps it deterministic. */
function buildResolver(docs) {
  const byToken = new Map(); // lowercase normalized token -> rel
  const norm = (x) => String(x).trim().toLowerCase().replace(/\.md$/, '').replace(/\/$/, '');
  for (const d of docs) {
    const add = (tok) => { const k = norm(tok); if (k && !byToken.has(k)) byToken.set(k, d.rel); };
    add(d.rel); add(d.corsRel); add(d.stem);
    if (d.id) add(d.id);
    for (const a of d.aliases) add(a);
  }
  return {
    resolve(token) {
      const rel = byToken.get(norm(token));
      return rel === undefined ? null : rel;
    },
  };
}

function loadDocs() {
  const rels = [];
  collectMarkdown(CORPUS, rels);
  return rels.map((rel) => {
    const content = fs.readFileSync(path.join(REPO, rel), 'utf8');
    const lines = content.split(/\r?\n/);
    const corsRel = path.relative(CORPUS, path.join(REPO, rel)).split(path.sep).join('/');
    const doc = {
      rel,
      corsRel,
      name: rel.slice(rel.lastIndexOf('/') + 1),
      corsDir: corsRel.includes('/') ? corsRel.slice(0, corsRel.lastIndexOf('/')) : '',
      stem: rel.slice(rel.lastIndexOf('/') + 1).replace(/\.md$/i, ''),
      content, lines, mask: fenceMask(lines), cls: classify(corsRel),
    };
    const fm = parseFrontmatter(doc.lines);
    doc.fm = fm;
    doc.entries = fm ? fm.entries : new Map();
    const idE = doc.entries.get('id');
    doc.id = idE && idE.kind === 'scalar' && idE.value ? idE.value.trim() : null;
    const alE = doc.entries.get('aliases');
    doc.aliases = alE && alE.kind === 'list' ? alE.items.filter((x) => x !== '') : [];
    return doc;
  });
}

// ----------------------------- Findings machinery ------------------------------

const findings = []; // {severity, path, line, name, msg}
function err(p, l, name, msg) { findings.push({ severity: 'error', path: p, line: l, name, msg }); }
function warn(p, l, name, msg) { findings.push({ severity: 'warning', path: p, line: l, name, msg }); }

// ----------------------------- ERROR: metadata-outside-contract ------------------------------

/** Per file class: required keys present + well-typed, status in enum, dates
 *  YYYY-MM-DD, optional keys valid-or-absent, NEVER blank. Present-but-blank
 *  optional key = error. Unknown keys are flagged too. */
function checkMetadata(d) {
  if (d.cls === 'generated') return; // artifacts carry no frontmatter contract
  const isNote = NOTE_CLASSES.has(d.cls);
  const required = isNote ? NOTE_REQUIRED
    : d.cls === 'context-entry' ? [...CTX_REQUIRED, ENTRY_EXTRA] : CTX_REQUIRED;
  const optional = isNote ? NOTE_OPTIONAL : CTX_OPTIONAL;
  const scalars = isNote ? NOTE_SCALARS : CTX_SCALARS;
  const e = d.entries;

  const typeError = (k, ent, msg) => err(d.rel, ent.line, 'metadata-outside-contract', msg);
  const checkOne = (k, ent, label) => {
    if (ent.kind === 'blank') return typeError(k, ent, `${label} key '${k}' is present but blank${label === 'optional' ? ' \u2014 omit it entirely' : ''}`);
    const mustBeScalar = scalars.has(k);
    if (mustBeScalar && ent.kind !== 'scalar') return typeError(k, ent, `key '${k}' must be a scalar`);
    if (!mustBeScalar && ent.kind !== 'list') return typeError(k, ent, `key '${k}' must be a list`);
    if (ent.kind !== 'scalar') return;
    const v = ent.value;
    if (k === 'version' && !isValidVersion(v)) typeError(k, ent, `version '${v}' is not a number`);
    if (k === 'id' && isNote && !SLUG_RE.test(String(v).trim())) typeError(k, ent, `id '${v}' is not a slug (expected lowercase alphanumerics joined by single hyphens)`);
    if ((k === 'last_updated' || k === 'expires_at') && !isValidDate(v)) typeError(k, ent, `${k} '${v}' is not YYYY-MM-DD`);
    if (k === 'status' && !STATUS_ENUM.has(String(v).trim())) typeError(k, ent, `status '${v}' not in {draft, active, superseded, expired}`);
  };

  for (const k of required) {
    const ent = e.get(k);
    if (!ent) err(d.rel, 1, 'metadata-outside-contract', `required key '${k}' is missing for ${d.cls}`);
    else checkOne(k, ent, 'required');
  }
  for (const k of optional) {
    const ent = e.get(k);
    if (ent) checkOne(k, ent, 'optional');
  }
  for (const [k, ent] of e) {
    if (!required.includes(k) && !optional.includes(k)) {
      err(d.rel, ent.line, 'metadata-outside-contract', `key '${k}' is not part of the ${d.cls} contract`);
    }
  }
}

// ----------------------------- ERROR: duplicate-ids ------------------------------

function checkDuplicateIds(docs) {
  const seen = new Map(); // id -> first doc claiming it
  for (const d of docs) {
    if (!NOTE_CLASSES.has(d.cls) || !d.id) continue;
    const ent = d.entries.get('id');
    if (seen.has(d.id)) {
      err(d.rel, ent.line, 'duplicate-ids', `id '${d.id}' already claimed by ${seen.get(d.id)}`);
    } else {
      seen.set(d.id, d.rel);
    }
  }
}

// ----------------------------- Graph edges + dangling-related-target + dangling-link ------------------------------

/** Builds out/inn edge sets (related + wikilinks + resolvable markdown links,
 *  self-edges dropped) and mdOut (markdown-link-only, for the hub check), while
 *  reporting dangling-related-target and dangling-link errors. Ignored:
 *  http(s)/mailto/data/ftp, pure #fragments; #fragment stripped before the
 *  existence check; directory targets OK. */
function collectEdges(docs, resolver) {
  const out = new Map(), inn = new Map(), mdOut = new Map();
  for (const d of docs) { out.set(d.rel, new Set()); inn.set(d.rel, new Set()); mdOut.set(d.rel, new Set()); }
  const link = (from, to) => { if (to && to !== from) { out.get(from).add(to); inn.get(to).add(from); } };
  const relSet = new Set(docs.map((d) => d.rel));

  for (const d of docs) {
    // related: semantic vocabulary, resolved through the ONE resolver.
    const rel = d.entries.get('related');
    if (rel && rel.kind === 'list') {
      for (const item of rel.items) {
        if (!item) continue;
        const hit = resolver.resolve(item);
        if (!hit) err(d.rel, rel.line, 'dangling-related-target', `related entry '${item}' resolves to no document (ids, stems and aliases all missed)`);
        else link(d.rel, hit);
      }
    }
    if (d.cls === 'generated') continue; // artifact preambles are not link sources

    const start = d.fm ? d.fm.end + 1 : 0;
    for (let i = start; i < d.lines.length; i++) {
      if (d.mask[i]) continue; // EXEMPT inside fences
      const line = d.lines[i];

      // (a) wikilinks [[stem]] or [[stem|display]] -- additionally skipped when
      // fully inside an inline code span: `[[stem]]` cites the syntax.
      const spans = inlineCodeSpans(line);
      for (const m of line.matchAll(/\[\[([^\[\]|\n]+)(?:\|[^\[\]\n]*)?\]\]/g)) {
        if (spans.some(([s, e]) => s <= m.index && m.index + m[0].length <= e)) continue;
        const token = m[1].trim();
        const hit = resolver.resolve(token);
        if (!hit) err(d.rel, i + 1, 'dangling-link', `wikilink [[${token}]] resolves to no document`);
        else link(d.rel, hit);
      }

      // (b) relative markdown links [t](path) -- resolved against CORPUS.
      for (const m of line.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)) {
        let target = m[1].trim();
        if (!target || target.startsWith('#')) continue;
        if (/^(?:https?:|mailto:|data:|ftp:)/i.test(target)) continue;
        target = target.split('#')[0];
        if (!target) continue;
        const abs = path.resolve(CORPUS, d.corsDir, target);
        if (!fs.existsSync(abs)) {
          err(d.rel, i + 1, 'dangling-link', `markdown link target '${m[1].trim()}' does not exist`);
          continue;
        }
        const relT = path.relative(REPO, abs).split(path.sep).join('/');
        const hit = relSet.has(relT) ? relT : resolver.resolve(target);
        if (hit) { link(d.rel, hit); mdOut.get(d.rel).add(hit); }
      }
    }
  }
  return { out, inn, mdOut };
}

// ----------------------------- ERROR: orphan-note ------------------------------

/** A note-class file (note/hub/adr/protocol) with ZERO non-self edges in both
 *  directions. context-docs/entry/generated are exempt. */
function checkOrphans(docs, out, inn) {
  for (const d of docs) {
    if (!NOTE_CLASSES.has(d.cls)) continue;
    if (out.get(d.rel).size === 0 && inn.get(d.rel).size === 0) {
      err(d.rel, 1, 'orphan-note', 'note has zero resolved non-self edges in both directions');
    }
  }
}

// ----------------------------- ERROR: missing-from-hub ------------------------------

/** - note in a folder containing a hub -> must be referenced BY THE HUB
 *    (any resolvable edge).
 *  - note in a hub-less folder (root-level notes, adrs/, protocols/) -> must be
 *    referenced by a resolvable MARKDOWN link in the ENTRY POINT (project.md).
 *  - hubs themselves must also be referenced by a resolvable markdown link in
 *    the entry point. */
function checkHubMembership(docs, out, mdOut) {
  const entry = docs.find((d) => d.corsRel === ENTRY_POINT);
  const entryLinks = entry ? (mdOut.get(entry.rel) || new Set()) : new Set();
  const hubByDir = new Map();
  for (const d of docs) if (d.cls === 'hub') hubByDir.set(d.corsDir, d);
  for (const d of docs) {
    if (!NOTE_CLASSES.has(d.cls)) continue;
    if (d.cls === 'hub') {
      if (!entryLinks.has(d.rel)) {
        err(d.rel, 1, 'missing-from-hub', 'hub is not referenced by a resolvable markdown link in project.md');
      }
      continue;
    }
    const hub = hubByDir.get(d.corsDir);
    if (hub) {
      if (!out.get(hub.rel).has(d.rel)) {
        err(d.rel, 1, 'missing-from-hub', `note is not referenced by hub ${hub.rel} (wikilink or markdown link)`);
      }
    } else if (!entryLinks.has(d.rel)) {
      err(d.rel, 1, 'missing-from-hub',
        'note sits in a hub-less folder and is not referenced by a resolvable markdown link in project.md');
    }
  }
}

// ----------------------------- ERROR: non-kebab-case-name ------------------------------

/** Every scanned file and every folder that holds one must be lowercase
 *  kebab-case. README.md is the single documented conventional exemption.
 *  Folders are reported once, on the folder path. */
function checkNames(docs) {
  const dirs = new Set();
  for (const d of docs) {
    if (d.corsDir) dirs.add(d.corsDir);
    if (!NAME_EXEMPT.has(d.name) && !SLUG_RE.test(d.stem)) {
      err(d.rel, 1, 'non-kebab-case-name', `filename '${d.name}' is not lowercase kebab-case`);
    }
  }
  for (const dir of [...dirs].sort()) {
    const bad = dir.split('/').find((seg) => !SLUG_RE.test(seg));
    if (bad) err(`docs/${dir}`, 1, 'non-kebab-case-name', `folder '${bad}/' is not lowercase kebab-case`);
  }
}

// ----------------------------- Generated region rendering ------------------------------

function classCounts(docs) {
  const c = { ctx: 0, note: 0, hub: 0, adr: 0, tmpl: 0, proto: 0 };
  for (const d of docs) {
    if (d.cls === 'context-entry' || d.cls === 'context-doc') c.ctx++;
    else if (d.cls === 'hub') c.hub++;
    else if (d.cls === 'adr') c.adr++;
    else if (d.cls === 'protocol') c.proto++;
    else if (d.cls === 'note') c.note++;
  }
  return c;
}
function treeLabel(d) {
  return { 'context-entry': 'context-doc (entry)', 'context-doc': 'context-doc', generated: 'generated',
    hub: 'hub', adr: 'adr', protocol: 'protocol' }[d.cls] || 'note';
}
function idSuffix(d) { return NOTE_CLASSES.has(d.cls) && d.id ? `, id: \`${d.id}\`` : ''; }

/** Body of the index.md "index" region (snapshot line added at write time).
 *  Root files first: project.md, then tag-index.md, then the rest of the root
 *  sorted (index.md never lists itself); then folders sorted alphabetically,
 *  files sorted inside. Folders without any scanned .md are not listed. */
function renderIndexRegion(docs) {
  const L = [];
  const c = classCounts(docs);
  L.push('## Generated index', '', '### Overview', '');
  L.push(`- Markdown files: ${docs.length}`);
  L.push(`- Context docs: ${c.ctx} | Notes: ${c.note} | Hubs: ${c.hub} | adrs: ${c.adr} | templates: ${c.tmpl} | protocols: ${c.proto}`);
  L.push('', '### Tree', '');
  const fmt = (d, indent) => `${indent}- ${d.name} ${DASH} ${treeLabel(d)}${idSuffix(d)}`;
  const rootFiles = docs.filter((d) => d.corsDir === '');
  for (const corsRel of [ENTRY_POINT, 'tag-index.md']) {
    const d = rootFiles.find((x) => x.corsRel === corsRel);
    if (d) L.push(fmt(d, ''));
  }
  const rootRest = rootFiles
    .filter((d) => d.corsRel !== ENTRY_POINT && d.corsRel !== 'tag-index.md' && d.corsRel !== 'index.md')
    .sort((a, b) => ciCompare(a.name, b.name));
  for (const d of rootRest) L.push(fmt(d, ''));
  const dirs = [...new Set(docs.filter((d) => d.corsDir !== '').map((d) => d.corsDir))].sort(ciCompare);
  for (const dir of dirs) {
    L.push(`- ${dir}/`);
    for (const d of docs.filter((x) => x.corsDir === dir).sort((a, b) => ciCompare(a.name, b.name))) {
      L.push(fmt(d, '  '));
    }
  }
  return L;
}

/** Body of the tag-index.md "tags" region: one line per distinct tag, tags
 *  sorted; refs sorted; ref = id for note-class files with an id, else the
 *  filename stem. */
function renderTagsRegion(docs) {
  const tagMap = new Map();
  for (const d of docs) {
    const ent = d.entries.get('tags');
    if (!ent || ent.kind !== 'list') continue;
    const ref = NOTE_CLASSES.has(d.cls) && d.id ? d.id : d.stem;
    for (const t of ent.items) {
      const k = String(t).trim().toLowerCase();
      if (!k) continue;
      if (!tagMap.has(k)) tagMap.set(k, new Set());
      tagMap.get(k).add(ref);
    }
  }
  const L = ['## Generated tag index', ''];
  for (const tag of [...tagMap.keys()].sort()) {
    L.push(`- **${tag}** ${DASH} ${[...tagMap.get(tag)].sort().join(', ')}`);
  }
  return L;
}

const SNAPSHOT_RE = /^<!-- snapshot: \d{4}-\d{2}-\d{2} -->$/;
function extractRegion(lines, marker) {
  const b = lines.findIndex((l) => l.trim() === `<!-- BEGIN GENERATED: ${marker} -->`);
  const e = lines.findIndex((l) => l.trim() === `<!-- END GENERATED: ${marker} -->`);
  if (b < 0 || e <= b) return null;
  return { beginLine: b, endLine: e, body: lines.slice(b + 1, e) };
}
const stripSnapshots = (body) => body.filter((l) => !SNAPSHOT_RE.test(l.trim()));

// ----------------------------- ERROR: stale-generated-index (+ the --write half) ------------------------------

/** Check: artifact missing -> error at file line 1; markers missing -> error;
 *  body mismatch -> error at the BEGIN-marker line. Comparison strips the
 *  snapshot line from BOTH stored and recomputed bodies: identical-except-date
 *  = FRESH. */
function checkGeneratedRegions(docs, bodies) {
  for (const art of GENERATED_ARTIFACTS) {
    const d = docs.find((x) => x.corsRel === art.corsRel);
    const body = bodies.get(art.corsRel);
    if (!d) {
      err(`docs/${art.corsRel}`, 1, 'stale-generated-index',
        `generated artifact docs/${art.corsRel} is missing (create file + marker pair, then run: node tools/docs/validate.js --write)`);
      continue;
    }
    const region = extractRegion(d.lines, art.marker);
    if (!region) {
      err(d.rel, 1, 'stale-generated-index', `${d.rel} is missing its BEGIN/END GENERATED: ${art.marker} marker pair`);
      continue;
    }
    if (stripSnapshots(region.body).join('\n') !== body.join('\n')) {
      err(d.rel, region.beginLine + 1, 'stale-generated-index',
        `${d.rel} "${art.marker}" region body is out of sync with the corpus (run: node tools/docs/validate.js --write)`);
    }
  }
}

/** --write: regenerate regions IN EXISTING FILES ONLY (a missing artifact is
 *  never created -- it stays an error). Write-if-diff on the FULL new bytes.
 *  First line inside the regenerated region: `<!-- snapshot: YYYY-MM-DD -->`;
 *  body-minus-date unchanged -> PRESERVE the existing date, else today. */
function regenerateRegions(docs, bodies) {
  for (const art of GENERATED_ARTIFACTS) {
    const d = docs.find((x) => x.corsRel === art.corsRel);
    if (!d) continue;
    const region = extractRegion(d.lines, art.marker);
    if (!region) continue; // no markers: cannot write safely -- the check reports it
    const body = bodies.get(art.corsRel);
    let snapshot;
    if (stripSnapshots(region.body).join('\n') === body.join('\n')) {
      const old = region.body.find((l) => SNAPSHOT_RE.test(l.trim()));
      snapshot = old ? old.trim() : `<!-- snapshot: ${todayISO()} -->`;
    } else {
      snapshot = `<!-- snapshot: ${todayISO()} -->`;
    }
    const newLines = [
      ...d.lines.slice(0, region.beginLine + 1),
      snapshot,
      ...body,
      ...d.lines.slice(region.endLine),
    ];
    const eol = d.content.includes('\r\n') ? '\r\n' : '\n';
    const next = newLines.join(eol);
    if (next !== d.content) {
      fs.writeFileSync(path.join(REPO, d.rel), next, 'utf8');
      process.stderr.write(`wrote: ${d.rel}\n`);
    }
  }
}

// ----------------------------- ERROR: secret-in-prose  (FINDINGS NEVER ECHO THE VALUE) ------------------------------

// Conservative patterns; prose AND frontmatter (frontmatter is NOT exempt);
// fenced blocks are exempt. Assignment key part is case-insensitive.
const SECRET_PATTERNS = [
  { kind: 'aws-access-key-id', re: /AKIA[0-9A-Z]{16}/g, val: (m) => m[0] },
  { kind: 'private-key-block', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g, val: (m) => m[0] },
  { kind: 'secret-assignment', re: /(api[_-]?key|token|secret|password|passwd)\s*[:=]\s*["']?([A-Za-z0-9+/=_\-.]{16,})["']?/gi, val: (m) => m[2] },
  { kind: 'hex-token', re: /(?<![0-9a-fA-F])[a-f0-9]{32,}(?![0-9a-fA-F])/g, val: (m) => m[0] },
];

function checkSecrets(docs) {
  for (const d of docs) {
    for (let i = 0; i < d.lines.length; i++) {
      if (d.mask[i]) continue;
      const line = d.lines[i];
      const reported = []; // spans already reported on this line (pattern precedence)
      for (const p of SECRET_PATTERNS) {
        p.re.lastIndex = 0;
        let m;
        while ((m = p.re.exec(line))) {
          const s = m.index, e = m.index + m[0].length;
          if (reported.some((t) => s < t[1] && e > t[0])) continue;
          reported.push([s, e]);
          // Redacted sketch ONLY: first 4 chars + ellipsis. The value itself
          // must never travel in a finding.
          err(d.rel, i + 1, 'secret-in-prose', `${p.kind} detected (redacted: ${String(p.val(m)).slice(0, 4)}${ELL})`);
        }
      }
    }
  }
}

// ----------------------------- WARNINGS (non-blocking) ------------------------------

function checkNoH1(docs) {
  for (const d of docs) {
    if (d.cls === 'generated') continue;
    const start = d.fm ? d.fm.end + 1 : 0;
    let has = false;
    for (let i = start; i < d.lines.length; i++) {
      if (!d.mask[i] && /^#\s+\S/.test(d.lines[i])) { has = true; break; }
    }
    if (!has) warn(d.rel, 1, 'no-h1', 'document has no H1 heading outside fenced blocks');
  }
}

function checkCategory(docs) {
  for (const d of docs) {
    if (!NOTE_CLASSES.has(d.cls) || d.corsDir === '') continue; // root-level notes: no folder to compare
    const ent = d.entries.get('category');
    if (!ent || ent.kind !== 'scalar' || !ent.value) continue; // absence/blank owned by metadata check
    if (ent.value.trim().toLowerCase() !== d.corsDir.toLowerCase()) {
      warn(d.rel, ent.line, 'category-mismatch-folder', `category '${ent.value.trim()}' does not match folder '${d.corsDir}/'`);
    }
  }
}

function checkNearDuplicates(docs) {
  // Word tokens lowercased (\w+), Jaccard >= 0.85, skip docs < 25 tokens, one
  // finding per pair (reported on the later path). Generated artifacts are
  // excluded: their bodies are deterministic boilerplate.
  const pool = docs.filter((d) => d.cls !== 'generated').map((d) => {
    const toks = [];
    const start = d.fm ? d.fm.end + 1 : 0;
    for (let i = start; i < d.lines.length; i++) {
      if (!d.mask[i]) for (const m of d.lines[i].matchAll(/\w+/g)) toks.push(m[0].toLowerCase());
    }
    return { d, toks };
  }).filter((x) => x.toks.length >= 25)
    .map((x) => ({ d: x.d, set: new Set(x.toks) }));
  for (let i = 0; i < pool.length; i++) {
    for (let j = i + 1; j < pool.length; j++) {
      const A = pool[i].set, B = pool[j].set;
      let inter = 0;
      for (const t of A) if (B.has(t)) inter++;
      const union = A.size + B.size - inter;
      const jac = union === 0 ? 0 : inter / union;
      if (jac >= 0.85) {
        warn(pool[j].d.rel, 1, 'near-duplicate-body',
          `body is a near-duplicate of ${pool[i].d.rel} (jaccard=${jac.toFixed(2)})`);
      }
    }
  }
}

// ----------------------------- Main ------------------------------

function main() {
  let docs = loadDocs();
  let resolver = buildResolver(docs);

  // Region bodies are derived from the file set + frontmatter, which --write
  // never changes -- compute once, write, then reload for checking.
  const bodies = new Map(GENERATED_ARTIFACTS.map((a) =>
    [a.corsRel, a.marker === 'index' ? renderIndexRegion(docs) : renderTagsRegion(docs)]));
  if (WRITE_MODE) {
    regenerateRegions(docs, bodies); // strictly read-only below this line
    docs = loadDocs();
    resolver = buildResolver(docs);
  }

  const { out, inn, mdOut } = collectEdges(docs, resolver);

  for (const d of docs) checkMetadata(d);
  checkDuplicateIds(docs);
  checkNames(docs);
  checkSecrets(docs);
  checkOrphans(docs, out, inn);
  checkHubMembership(docs, out, mdOut);
  checkGeneratedRegions(docs, bodies);

  checkNoH1(docs);
  checkCategory(docs);
  checkNearDuplicates(docs);

  findings.sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1
      : a.line !== b.line ? a.line - b.line
        : a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  const lines = findings.map((f) => `${f.path}:${f.line} ${DASH} ${f.name}: ${f.msg}`);
  const nErr = findings.filter((f) => f.severity === 'error').length;
  const nWarn = findings.length - nErr;
  lines.push(`${nErr} error(s), ${nWarn} warning(s) ${DASH} files scanned: ${docs.length}`);
  process.stdout.write(lines.join('\n') + '\n');
  process.exitCode = nErr > 0 ? 1 : 0;
}

main();
