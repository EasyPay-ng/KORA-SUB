import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { createGamesPage, createGamePage } from '../games.mjs';

// Stable fixture data, independent of the publisher's periodically refreshed catalogue.
function fixture(index, title, category) {
  const id = index.toString(36).padStart(32, '0');
  return {
    id, title, category, description: `${title} description`, instructions: 'Click or tap to play.',
    tags: [category], url: `https://html5.gamemonetize.co/${id}/`,
    thumb: `https://img.gamemonetize.com/${id}/512x384.jpg`, width: 750, height: 1334
  };
}
const GAMES = [fixture(1, 'Fruit Box Sort', 'Puzzles'), fixture(2, 'PocketGolf', 'Sports'),
  ...Array.from({ length: 30 }, (_, i) => fixture(i + 3, `Sample Game ${i + 3}`, ['Puzzles', 'Sports', 'Racing'][i % 3]))];
const GALLERY = await readFile(new URL('../games.html', import.meta.url), 'utf8');
const PLAYER = await readFile(new URL('../game.html', import.meta.url), 'utf8');
const settle = () => new Promise(resolve => setTimeout(resolve, 0));
const response = rows => ({ ok: true, json: async () => rows });

function gallery(fetcher = async () => response(GAMES)) {
  const dom = new JSDOM(GALLERY, { url: 'https://store.example/games.html' });
  const doc = dom.window.document;
  const page = createGamesPage({ doc, fetcher });
  return { dom, doc, page, $: selector => doc.querySelector(selector) };
}

function player({ id = GAMES[0].id, fetcher = async () => response(GAMES) } = {}) {
  const dom = new JSDOM(PLAYER, { url: `https://store.example/game.html?id=${encodeURIComponent(id)}` });
  const doc = dom.window.document;
  const page = createGamePage({ doc, fetcher });
  return { dom, doc, page, $: selector => doc.querySelector(selector) };
}

test('gallery loads the local catalogue, searches, filters and paginates', async t => {
  let requested;
  const { dom, doc, page, $ } = gallery(async url => { requested = url; return response(GAMES); });
  t.after(() => dom.window.close());
  assert.equal($('#games-grid').getAttribute('aria-busy'), 'true');
  await page.load();
  assert.equal(requested, './data/gamemonetize-games.json');
  assert.equal(doc.querySelectorAll('.game-card').length, 12);
  assert.match($('#games-count').textContent, /Showing 12 of 32 games/);
  assert.equal(doc.querySelectorAll('iframe').length, 0, 'the gallery never loads game frames');
  assert.equal(doc.querySelector('.game-card').getAttribute('href'), `game.html?id=${GAMES[0].id}`);
  assert.equal($('#games-more').hidden, false);
  $('#games-more').click();
  assert.equal(doc.querySelectorAll('.game-card').length, 24);
  assert.equal(doc.activeElement, doc.querySelectorAll('.game-card')[12]);
  $('#games-more').click();
  assert.equal(doc.querySelectorAll('.game-card').length, 32);
  assert.equal($('#games-more').hidden, true);

  const sports = [...doc.querySelectorAll('.game-category')].find(button => button.textContent === 'Sports');
  sports.click();
  assert.equal(sports.getAttribute('aria-pressed'), 'true');
  assert.ok([...doc.querySelectorAll('.game-card-category')].every(node => node.textContent === 'Sports'));
  $('#games-search').value = 'golf';
  $('#games-search').dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  assert.equal(doc.querySelectorAll('.game-card').length, 1);
  assert.equal(doc.querySelector('.game-card h3').textContent, 'PocketGolf');
  assert.match($('#games-count').textContent, /1 of 1 game$/);
  $('#games-search').value = 'not a real game';
  $('#games-search').dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  assert.match($('#games-message').textContent, /No games match/);
  $('#games-message button').click();
  assert.equal($('#games-search').value, '');
  assert.equal(doc.activeElement, $('#games-search'));
  assert.equal(doc.querySelector('[data-category="All"]').getAttribute('aria-pressed'), 'true');
  assert.equal(doc.querySelectorAll('.game-card').length, 12);
});

test('gallery explains failures and retries; empty data has its own state', async t => {
  let attempts = 0;
  const { dom, doc, page, $ } = gallery(async () => {
    attempts += 1;
    if (attempts === 1) throw new Error('offline');
    return response(GAMES);
  });
  t.after(() => dom.window.close());
  await page.load();
  assert.match($('#games-message').textContent, /Could not load games/);
  assert.equal($('#games-grid').getAttribute('aria-busy'), 'false');
  $('#games-message button').click();
  await settle();
  assert.equal(attempts, 2);
  assert.equal(doc.querySelectorAll('.game-card').length, 12);
  page.setGames([]);
  assert.match($('#games-message').textContent, /No games available yet/);
  assert.equal($('#games-more').hidden, true);
});

test('player loads an approved game only after Play, supports fullscreen, restart and stop', async t => {
  const { dom, doc, page, $ } = player();
  t.after(() => dom.window.close());
  let fullscreenCalls = 0;
  $('#game-stage').requestFullscreen = async () => { fullscreenCalls += 1; };
  await page.load();
  assert.equal($('#game-content').hidden, false);
  assert.equal($('#game-title').textContent, GAMES[0].title);
  assert.equal(doc.querySelector('iframe'), null);
  assert.equal($('#game-external').href, GAMES[0].url);
  assert.equal($('#game-external').getAttribute('referrerpolicy'), 'strict-origin-when-cross-origin');
  assert.ok(doc.querySelectorAll('#related-grid .game-card').length > 0);
  assert.equal(parseFloat($('#game-stage').style.aspectRatio), GAMES[0].width / GAMES[0].height);

  $('#game-play').click();
  const frame = doc.querySelector('#game-frame-host iframe');
  assert.ok(frame);
  assert.equal(frame.src, GAMES[0].url);
  assert.equal(frame.getAttribute('title'), 'Play Fruit Box Sort');
  assert.equal(frame.getAttribute('referrerpolicy'), 'strict-origin-when-cross-origin');
  assert.match(frame.getAttribute('sandbox'), /allow-popups-to-escape-sandbox/);
  assert.match(frame.getAttribute('sandbox'), /allow-top-navigation-by-user-activation/);
  assert.doesNotMatch(frame.getAttribute('sandbox'), /(?:^| )allow-top-navigation(?: |$)/);
  assert.equal($('#game-cover').hidden, true);
  assert.equal($('#game-fullscreen').hidden, false);
  $('#game-fullscreen').click();
  await settle();
  assert.equal(fullscreenCalls, 1);
  $('#game-restart').click();
  assert.notEqual(doc.querySelector('#game-frame-host iframe'), frame, 'restart replaces the old frame');
  $('#game-stop').click();
  assert.equal(doc.querySelector('iframe'), null);
  assert.equal($('#game-cover').hidden, false);
  assert.equal(doc.activeElement, $('#game-play'));
});

test('invalid or missing games never open an iframe; feed errors can be retried', async t => {
  let calls = 0;
  const missing = player({ id: 'javascript:alert(1)', fetcher: async () => { calls += 1; return response(GAMES); } });
  t.after(() => missing.dom.window.close());
  await missing.page.load();
  assert.equal(calls, 0);
  assert.match(missing.$('#player-message').textContent, /Game not found/);
  assert.equal(missing.doc.querySelector('iframe'), null);

  const unknown = player({ id: 'z'.repeat(32) });
  t.after(() => unknown.dom.window.close());
  await unknown.page.load();
  assert.match(unknown.$('#player-message').textContent, /Game not found/);
  assert.equal(unknown.$('#game-content').hidden, true);

  let attempts = 0;
  const retry = player({ fetcher: async () => { attempts += 1; return attempts === 1 ? { ok: false } : response(GAMES); } });
  t.after(() => retry.dom.window.close());
  await retry.page.load();
  assert.match(retry.$('#player-message').textContent, /Could not load this game/);
  retry.$('#player-message button').click();
  await settle();
  assert.equal(retry.$('#game-content').hidden, false);
});

test('third-party text and untrusted URLs are never interpreted as markup or embedded', async t => {
  const dirty = {
    ...GAMES[0], title: '<img src=x onerror=alert(1)> Safe title',
    description: 'Description <script>alert(1)</script> with <b>words</b>',
    instructions: '<svg onload=alert(1)>Click or tap</svg>', category: '<img src=x> Puzzles'
  };
  const { dom, doc, page, $ } = player({ fetcher: async () => response([dirty]) });
  t.after(() => dom.window.close());
  await page.load();
  assert.equal($('#game-title').textContent, 'Safe title');
  assert.equal($('#game-title img'), null);
  assert.equal($('#game-description script'), null);
  assert.equal($('#game-instructions svg'), null);
  assert.equal($('#game-category img'), null);
  $('#game-play').click();
  assert.equal(doc.querySelector('iframe').src, GAMES[0].url);

  const rejected = player({ fetcher: async () => response([{ ...dirty, url: `https://evil.example/${GAMES[0].id}/` }]) });
  t.after(() => rejected.dom.window.close());
  await rejected.page.load();
  assert.match(rejected.$('#player-message').textContent, /Game not found/);
  assert.equal(rejected.doc.querySelector('iframe'), null);
});
