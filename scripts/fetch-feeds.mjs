// Collects every RSS source and writes feeds.json at the repo root.
// Run by .github/workflows/update-feeds.yml every 30 minutes.
// If a source fails, its items from the previous run are kept (marked ok:false)
// so the site never goes blank because one feed hiccuped.

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

const OUT_FILE = 'feeds.json';
const MAX_ITEMS = 30;

const parser = new Parser({
  timeout: 20000,
  headers: { 'User-Agent': 'maxarmstrong.io-feed-collector/1.0 (+https://maxarmstrong.io)' },
});

const clean = (s, max) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, max);

let previous = { sources: {} };
try {
  previous = JSON.parse(await readFile(OUT_FILE, 'utf8'));
} catch {
  // first run: no previous file
}

const sources = {};
for (const src of SOURCES) {
  try {
    const feed = await parser.parseURL(src.rss);
    sources[src.id] = {
      ok: true,
      items: feed.items.slice(0, MAX_ITEMS).map(it => ({
        title: clean(it.title, 200),
        // podcast feeds sometimes omit <link>; fall back to a URL guid, then the audio file
        link: it.link || (/^https?:/.test(it.guid || '') ? it.guid : '') || it.enclosure?.url || '',
        desc: clean(it.contentSnippet || it.summary || '', 220),
        date: it.isoDate || it.pubDate || '',
      })),
    };
    console.log(`ok   ${src.id} (${sources[src.id].items.length} items)`);
  } catch (err) {
    const prevItems = previous.sources?.[src.id]?.items || [];
    sources[src.id] = { ok: false, items: prevItems };
    console.log(`FAIL ${src.id}: ${err.message} (kept ${prevItems.length} old items)`);
  }
}

// Only rewrite the file when something actually changed, so the repo
// doesn't get a commit every 30 minutes for nothing.
if (JSON.stringify(sources) === JSON.stringify(previous.sources)) {
  console.log('No changes.');
} else {
  await writeFile(OUT_FILE, JSON.stringify({ updated: new Date().toISOString(), sources }, null, 1) + '\n');
  console.log(`Wrote ${OUT_FILE}`);
}
 process.exit(0);
