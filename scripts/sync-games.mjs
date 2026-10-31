#!/usr/bin/env node
// Refresh the static catalogue without making visitors depend on cross-origin feed access.
// Run: npm run sync:games [-- path/to/feed.json] [--replace]
import { readFile, writeFile, rename } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { normalizeCatalogue } from '../games-catalogue.mjs';

const DEFAULT_FEED = 'https://rss.gamemonetize.com/rssfeed.php?format=json&category=All&type=html5&popularity=newest&company=All&amount=100';
const OUTPUT = fileURLToPath(new URL('../data/gamemonetize-games.json', import.meta.url));

async function readFeed(file) {
  if (file) return JSON.parse(await readFile(file, 'utf8'));
  const url = process.env.GAMEMONETIZE_FEED_URL || DEFAULT_FEED;
  const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error(`GameMonetize returned HTTP ${response.status}.`);
  return response.json();
}

async function main() {
  const args = process.argv.slice(2);
  const replace = args.includes('--replace');
  const files = args.filter(arg => arg !== '--replace');
  if (files.length > 1 || files.some(arg => arg.startsWith('--'))) {
    throw new Error('Usage: npm run sync:games -- [path/to/feed.json] [--replace]');
  }
  const raw = await readFeed(files[0]);
  const incoming = normalizeCatalogue(raw);
  if (!incoming.length) throw new Error('No valid GameMonetize games found; the existing catalogue was not changed.');
  let previous = [];
  if (!replace) {
    try { previous = normalizeCatalogue(JSON.parse(await readFile(OUTPUT, 'utf8'))); }
    catch (error) {
      if (error.code !== 'ENOENT') throw new Error(`Could not read the existing catalogue: ${error.message}`);
    }
  }
  // Preserve older entries and links by default. The provider may retire games, so
  // publishers should review and remove unavailable or unsuitable titles.
  const games = normalizeCatalogue([...incoming, ...previous]);
  const temp = `${OUTPUT}.tmp`;
  await writeFile(temp, `${JSON.stringify(games, null, 2)}\n`, 'utf8');
  await rename(temp, OUTPUT);
  console.log(`Imported ${incoming.length} valid games; catalogue now contains ${games.length}. Review it before publishing.`);
}

main().catch(error => {
  console.error(`Games sync failed: ${error.message}`);
  process.exitCode = 1;
});
