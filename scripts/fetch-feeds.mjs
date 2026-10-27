// Collects every RSS source plus the CISA KEV catalog and writes feeds.json
// at the repo root. Run by .github/workflows/update-feeds.yml every 30 minutes.
//
// History: each run merges new items into what's already stored and drops
// anything older than 7 days, so the site keeps a rolling week of stories.
// If a source fails, its stored items are kept (marked ok:false) so the site
// never goes blank because one feed hiccuped.

import Parser from 'rss-parser';
import { readFile, writeFile } from 'node:fs/promises';

const SOURCES = [
  { id: 'bleepingcomputer', rss: 'https://www.bleepingcomputer.com/feed/' },
  { id: 'thn',              rss: 'https://feeds.feedburner.com/TheHackersNews' },
  { id: 'darkreading',      rss: 'https://www.darkreading.com/rss.xml' },
  { id: 'krebs',            rss: 'https://krebsonsecurity.com/feed/' },
  { id: 'theregister',      rss: 'https://www.theregister.com/security/headlines.atom' },
  { id: 'riskybiz',         rss: 'https://risky.biz/feeds/risky-business/' },
  { id: 'cyberwire',        rss: 'https://feeds.megaphone.fm/cyberwire-daily-podcast' },
];

// CISA's official file first; the CISA-run GitHub mirror if that's down.
const KEV_URLS = [
  'https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json',
  'https://raw.githubusercontent.com/cisagov/kev-data/main/known_exploited_vulnerabilities.json',
];
const KEV_LATEST = 15;

const OUT_FILE = 'feeds.json';
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_ITEMS = 150;            // per source, safety cap
const UA = 'maxarmstrong.io-feed-collector/1.0 (+https://maxarmstrong.io)';

const parser = new Parser({ timeout: 20000, headers: { 'User-Agent': UA } });
const clean = (s, max) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, max);
const ts = d => { const t = new Date(d).getTime(); return isNaN(t) ? 0 : t; };

let previous = { sources: {}, kev: null };
try {
  previous = JSON.parse(await readFile(OUT_FILE, 'utf8'));
} catch {
  // first run: no previous file
}

// Fresh items win; stored items fill in the rest. Dedupe by link, keep 7 days.
function mergeHistory(fresh, stored) {
  const cutoff = Date.now() - MAX_AGE_MS;
  const seen = new Set();
  const out = [];
  for (const it of [...fresh, ...stored]) {
    const key = it.link || it.title;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    if (ts(it.date) && ts(it.date) < cutoff) continue;
    out.push(it);
  }
  out.sort((a, b) => ts(b.date) - ts(a.date));
  return out.slice(0, MAX_ITEMS);
}

const sources = {};
for (const src of SOURCES) {
  const stored = previous.sources?.[src.id]?.items || [];
  try {
    const feed = await parser.parseURL(src.rss);
    const fresh = feed.items.map(it => ({
      title: clean(it.title, 200),
      // podcast feeds sometimes omit <link>; fall back to a URL guid, then the audio file
      link: it.link || (/^https?:/.test(it.guid || '') ? it.guid : '') || it.enclosure?.url || '',
      desc: clean(it.contentSnippet || it.summary || '', 220),
      date: it.isoDate || it.pubDate || '',
    }));
    sources[src.id] = { ok: true, items: mergeHistory(fresh, stored) };
    console.log(`ok   ${src.id} (${fresh.length} fetched, ${sources[src.id].items.length} kept)`);
  } catch (err) {
    sources[src.id] = { ok: false, items: mergeHistory([], stored) };
    console.log(`FAIL ${src.id}: ${err.message} (kept ${sources[src.id].items.length} stored items)`);
  }
}

async function fetchKev() {
  for (const url of KEV_URLS) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(30000) });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const cat = await res.json();
      const vulns = Array.isArray(cat.vulnerabilities) ? cat.vulnerabilities : [];
      if (!vulns.length) throw new Error('empty catalog');
      const latest = [...vulns]
        .sort((a, b) => ts(b.dateAdded) - ts(a.dateAdded) || String(b.cveID).localeCompare(String(a.cveID)))
        .slice(0, KEV_LATEST)
        .map(v => ({
          cve: clean(v.cveID, 30),
          vendor: clean(v.vendorProject, 60),
          product: clean(v.product, 80),
          name: clean(v.vulnerabilityName, 160),
          added: clean(v.dateAdded, 10),
          due: clean(v.dueDate, 10),
          ransomware: /known/i.test(v.knownRansomwareCampaignUse || ''),
        }));
      // Every CVE ID in the catalog, so the page can flag KEV CVEs inside articles.
      const ids = vulns.map(v => clean(v.cveID, 30)).filter(Boolean).sort();
      console.log(`ok   kev (${vulns.length} in catalog) via ${url}`);
      return { ok: true, version: clean(cat.catalogVersion, 20), count: vulns.length, latest, ids };
    } catch (err) {
      console.log(`FAIL kev via ${url}: ${err.message}`);
    }
  }
  return previous.kev ? { ...previous.kev, ok: false } : { ok: false, latest: [], ids: [] };
}
const kev = await fetchKev();

// Only rewrite the file when something actually changed, so the repo
// doesn't get a commit every 30 minutes for nothing.
const body = { sources, kev };
if (JSON.stringify(body) === JSON.stringify({ sources: previous.sources, kev: previous.kev })) {
  console.log('No changes.');
} else {
  await writeFile(OUT_FILE, JSON.stringify({ updated: new Date().toISOString(), ...body }) + '\n');
  console.log(`Wrote ${OUT_FILE}`);
}
process.exit(0);
