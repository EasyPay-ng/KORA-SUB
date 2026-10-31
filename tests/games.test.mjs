import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, mkdir, copyFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { cleanGameText, trustedEmbed, normalizeGame, normalizeCatalogue, filterGames } from '../games-catalogue.mjs';

const HASH = 'au6crdudkwzdpwt0w1jbis0po9k6v9b8';
const OTHER = '89cwmdcu0v18okqbmvj4wj2veldfldbr';
const sample = (id = HASH) => ({
  title: 'Fruit Box Sort', category: 'Puzzles', description: 'A colorful sorting game',
  instructions: 'Tap to play', tags: 'Fruit, Logic, Mobile',
  url: `https://html5.gamemonetize.co/${id}/`,
  thumb: `https://img.gamemonetize.com/${id}/512x384.jpg`, width: '750', height: '1334'
});

test('the bundled starter catalogue is valid, unique and uses provider embeds', async () => {
  const raw = JSON.parse(await readFile(new URL('../data/gamemonetize-games.json', import.meta.url), 'utf8'));
  const games = normalizeCatalogue(raw);
  assert.ok(games.length > 0);
  assert.deepEqual(games, raw, 'the committed snapshot is already in normalized form');
  assert.equal(new Set(games.map(game => game.id)).size, games.length);
  assert.ok(games.every(game => trustedEmbed(game.url)?.id === game.id));
});

test('only exact HTTPS GameMonetize game URLs are accepted', () => {
  assert.equal(trustedEmbed(`https://html5.gamemonetize.co/${HASH}/`)?.id, HASH);
  assert.equal(trustedEmbed(`https://html5.gamemonetize.com/${HASH}/?ref=feed`)?.id, HASH);
  for (const bad of [
    `http://html5.gamemonetize.co/${HASH}/`,
    `https://html5.gamemonetize.co.evil.example/${HASH}/`,
    `https://html5.gamemonetize.co@evil.example/${HASH}/`,
    `https://user@html5.gamemonetize.co/${HASH}/`,
    `https://html5.gamemonetize.co:8443/${HASH}/`,
    `https://html5.gamemonetize.co/${HASH}/other`,
    'javascript:alert(1)', 'https://html5.gamemonetize.co/short/'
  ]) assert.equal(trustedEmbed(bad), null, bad);
  assert.equal(normalizeGame({ ...sample(), url: `https://evil.example/${HASH}/` }), null);
});

test('normalization cleans text, rejects unrelated artwork and removes duplicates', () => {
  const dirty = {
    ...sample(), title: '  Fruit &amp; Box <img src=x onerror=alert(1)>  ',
    description: 'Play <script>alert(1)</script><b>now</b> &mdash; enjoy',
    thumb: `https://img.gamemonetize.com/${OTHER}/512x384.jpg`, width: '-1', height: 'not-a-number'
  };
  const game = normalizeGame(dirty);
  assert.equal(game.title, 'Fruit & Box');
  assert.equal(game.description, 'Play now — enjoy');
  assert.equal(game.thumb, '', 'artwork must match the game id');
  assert.equal(game.width, 800);
  assert.equal(game.height, 600);
  assert.equal(cleanGameText('text &lt;script&gt;bad()&lt;/script&gt; &amp; good'), 'text & good');
  assert.equal(normalizeCatalogue([dirty, { ...sample(), id: 'a-different-feed-id' }]).length, 1);
  assert.throws(() => normalizeCatalogue({ games: [] }), /JSON array/);
});

test('search combines category with title, tags and description', () => {
  const games = normalizeCatalogue([sample(), { ...sample(OTHER), title: 'Formula Apex Rush', category: 'Racing', tags: 'Car, Driving', description: 'Fast cars' }]);
  assert.deepEqual(filterGames(games, { search: '  FRUIT  ' }).map(g => g.id), [HASH]);
  assert.deepEqual(filterGames(games, { search: 'DRIVING', category: 'Racing' }).map(g => g.id), [OTHER]);
  assert.deepEqual(filterGames(games, { search: 'fast', category: 'Puzzles' }), []);
});

test('the importer preserves old links by default, supports replacement and refuses an empty feed', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'korastore-games-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, 'scripts'));
  await mkdir(join(dir, 'data'));
  await copyFile(new URL('../scripts/sync-games.mjs', import.meta.url), join(dir, 'scripts/sync-games.mjs'));
  await copyFile(new URL('../games-catalogue.mjs', import.meta.url), join(dir, 'games-catalogue.mjs'));
  const out = join(dir, 'data/gamemonetize-games.json');
  const input = join(dir, 'feed.json');
  await writeFile(out, JSON.stringify(normalizeCatalogue([sample()])));
  await writeFile(input, JSON.stringify([{ ...sample(OTHER), title: 'Formula Apex Rush' }, sample(OTHER)]));
  const run = (...args) => spawnSync(process.execPath, [join(dir, 'scripts/sync-games.mjs'), ...args], { encoding: 'utf8' });

  let result = run(input);
  assert.equal(result.status, 0, result.stderr);
  let games = JSON.parse(await readFile(out, 'utf8'));
  assert.deepEqual(games.map(game => game.id), [OTHER, HASH]);

  const before = await readFile(out, 'utf8');
  await writeFile(input, '[]');
  result = run(input, '--replace');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /existing catalogue was not changed/);
  assert.equal(await readFile(out, 'utf8'), before);

  await writeFile(input, JSON.stringify([sample(OTHER)]));
  result = run(input, '--replace');
  assert.equal(result.status, 0, result.stderr);
  games = JSON.parse(await readFile(out, 'utf8'));
  assert.deepEqual(games.map(game => game.id), [OTHER]);
});
