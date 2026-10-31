import { filterGames, normalizeCatalogue } from './games-catalogue.mjs';

const CATALOGUE_URL = './data/gamemonetize-games.json';
const PAGE_SIZE = 12;

export async function fetchGames(fetcher = globalThis.fetch) {
  if (typeof fetcher !== 'function') throw new Error('Fetch is unavailable.');
  const response = await fetcher(CATALOGUE_URL, { cache: 'no-cache' });
  if (!response.ok) throw new Error('The game catalogue could not be loaded.');
  return normalizeCatalogue(await response.json());
}

function element(doc, tag, className, text) {
  const node = doc.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function gameCard(doc, game) {
  const card = element(doc, 'a', 'game-card');
  card.href = `game.html?id=${encodeURIComponent(game.id)}`;
  card.setAttribute('aria-label', `Play ${game.title}`);
  const image = element(doc, 'div', 'game-card-image');
  if (game.thumb) {
    const img = element(doc, 'img');
    img.src = game.thumb;
    img.alt = '';
    img.loading = 'lazy';
    img.decoding = 'async';
    img.addEventListener('error', () => img.remove(), { once: true });
    image.append(img);
  }
  const play = element(doc, 'span', 'game-card-play', '▶');
  play.setAttribute('aria-hidden', 'true');
  image.append(play);
  const body = element(doc, 'div', 'game-card-body');
  body.append(
    element(doc, 'span', 'game-card-category', game.category),
    element(doc, 'h3', '', game.title),
    element(doc, 'span', 'game-card-action', 'PLAY GAME  ↗')
  );
  card.append(image, body);
  return card;
}

function message(doc, host, title, detail, action) {
  host.replaceChildren(element(doc, 'b', '', title));
  if (detail) host.append(element(doc, 'p', '', detail));
  if (action) {
    const button = element(doc, 'button', 'btn btn-ghost btn-sm', action.label);
    button.type = 'button';
    button.addEventListener('click', action.run);
    host.append(button);
  }
  host.hidden = false;
}

export function createGamesPage({ doc = document, fetcher = globalThis.fetch } = {}) {
  const search = doc.querySelector('#games-search');
  const categories = doc.querySelector('#games-categories');
  const count = doc.querySelector('#games-count');
  const grid = doc.querySelector('#games-grid');
  const more = doc.querySelector('#games-more');
  const notice = doc.querySelector('#games-message');
  let games = [];
  let category = 'All';
  let visible = PAGE_SIZE;
  let ready = false;

  function renderCategories() {
    const sorted = [...new Set(games.map(game => game.category).filter(name => name !== 'All'))]
      .sort((a, b) => a.localeCompare(b));
    const names = ['All', ...sorted];
    categories.replaceChildren(...names.map(name => {
      const button = element(doc, 'button', 'game-category', name === 'All' ? 'All games' : name);
      button.type = 'button';
      button.dataset.category = name;
      button.setAttribute('aria-pressed', String(name === category));
      button.addEventListener('click', () => {
        category = name;
        visible = PAGE_SIZE;
        for (const chip of categories.querySelectorAll('button')) chip.setAttribute('aria-pressed', String(chip.dataset.category === category));
        render();
      });
      return button;
    }));
  }

  function clearFilters() {
    search.value = '';
    category = 'All';
    visible = PAGE_SIZE;
    for (const chip of categories.querySelectorAll('button')) chip.setAttribute('aria-pressed', String(chip.dataset.category === category));
    render();
    search.focus();
  }

  function render() {
    if (!ready) return;
    const list = filterGames(games, { search: search.value, category });
    const shown = Math.min(visible, list.length);
    grid.setAttribute('aria-busy', 'false');
    grid.replaceChildren(...list.slice(0, visible).map(game => gameCard(doc, game)));
    more.hidden = shown >= list.length;
    notice.hidden = true;
    if (!games.length) {
      count.textContent = 'No games available';
      message(doc, notice, 'No games available yet', 'Please check back soon.', { label: 'Try again', run: () => void load() });
    } else if (!list.length) {
      count.textContent = 'No games found';
      message(doc, notice, 'No games match your search', 'Try a different search or category.', { label: 'Clear filters', run: clearFilters });
    } else {
      count.textContent = `Showing ${shown} of ${list.length} ${list.length === 1 ? 'game' : 'games'}`;
    }
  }

  function setGames(rows) {
    games = normalizeCatalogue(rows);
    category = 'All';
    visible = PAGE_SIZE;
    ready = true;
    renderCategories();
    render();
  }

  function setError() {
    ready = false;
    count.textContent = 'Games unavailable';
    categories.replaceChildren();
    grid.replaceChildren();
    grid.setAttribute('aria-busy', 'false');
    more.hidden = true;
    message(doc, notice, 'Could not load games', 'Check your connection and try again.', { label: 'Try again', run: () => void load() });
  }

  async function load() {
    ready = false;
    count.textContent = 'Loading games…';
    grid.setAttribute('aria-busy', 'true');
    grid.replaceChildren();
    categories.replaceChildren();
    more.hidden = true;
    notice.hidden = true;
    try { setGames(await fetchGames(fetcher)); } catch { setError(); }
  }

  search.addEventListener('input', () => { visible = PAGE_SIZE; render(); });
  more.addEventListener('click', () => {
    const firstNew = visible;
    visible += PAGE_SIZE;
    render();
    grid.querySelectorAll('.game-card')[firstNew]?.focus();
  });
  return { load, setGames, setError };
}

export function createGamePage({ doc = document, fetcher = globalThis.fetch, gameId } = {}) {
  const id = (gameId ?? new URL(doc.defaultView.location.href).searchParams.get('id') ?? '').toLowerCase();
  const notice = doc.querySelector('#player-message');
  const content = doc.querySelector('#game-content');
  const title = doc.querySelector('#game-title');
  const category = doc.querySelector('#game-category');
  const description = doc.querySelector('#game-description');
  const instructions = doc.querySelector('#game-instructions');
  const instructionsSection = doc.querySelector('#game-instructions-section');
  const cover = doc.querySelector('#game-cover');
  const coverImage = doc.querySelector('#game-cover-image');
  const coverTitle = doc.querySelector('#game-cover-title');
  const stage = doc.querySelector('#game-stage');
  const frameHost = doc.querySelector('#game-frame-host');
  const play = doc.querySelector('#game-play');
  const restart = doc.querySelector('#game-restart');
  const stop = doc.querySelector('#game-stop');
  const fullscreen = doc.querySelector('#game-fullscreen');
  const note = doc.querySelector('#game-player-note');
  const external = doc.querySelector('#game-external');
  const relatedSection = doc.querySelector('#related-section');
  const relatedGrid = doc.querySelector('#related-grid');
  let selected = null;

  function resetPlayer() {
    frameHost.replaceChildren(); // Disposes the iframe and stops its audio/network activity.
    frameHost.hidden = true;
    cover.hidden = false;
    restart.hidden = true;
    stop.hidden = true;
    fullscreen.hidden = true;
    note.textContent = 'Games load from GameMonetize and may take a moment to start.';
  }

  function showProblem(heading, detail, retry = false) {
    selected = null;
    resetPlayer();
    content.hidden = true;
    message(doc, notice, heading, detail, retry ? { label: 'Try again', run: () => void load() } : null);
  }

  function setGames(rows) {
    const games = normalizeCatalogue(rows);
    const game = games.find(item => item.id === id);
    if (!game) {
      showProblem('Game not found', 'It may have been removed from the catalogue. Choose another game above.');
      return;
    }
    selected = game;
    resetPlayer();
    category.textContent = game.category;
    title.textContent = game.title;
    coverTitle.textContent = game.title;
    description.textContent = game.description || 'A browser game provided by GameMonetize.';
    instructions.textContent = game.instructions;
    instructionsSection.hidden = !game.instructions;
    external.href = game.url;
    coverImage.hidden = !game.thumb;
    coverImage.removeAttribute('src');
    coverImage.onerror = () => { coverImage.hidden = true; };
    if (game.thumb) coverImage.src = game.thumb;
    // Bound extreme feed dimensions so a malformed entry cannot collapse the player.
    const aspect = Math.max(.4, Math.min(2.5, game.width / game.height));
    stage.style.aspectRatio = String(aspect);
    stage.style.maxWidth = `${Math.round(Math.min(1200, aspect * 720))}px`;
    doc.title = `${game.title} — Play on KORASTORE`;
    const same = games.filter(item => item.id !== game.id && item.category === game.category);
    const others = games.filter(item => item.id !== game.id && item.category !== game.category);
    const related = [...same, ...others].slice(0, 4);
    relatedGrid.replaceChildren(...related.map(item => gameCard(doc, item)));
    relatedSection.hidden = related.length === 0;
    notice.hidden = true;
    content.hidden = false;
  }

  async function load() {
    selected = null;
    resetPlayer();
    content.hidden = true;
    message(doc, notice, 'Getting your game ready…');
    if (!/^[a-z0-9]{32}$/.test(id)) {
      showProblem('Game not found', 'Choose a game from the catalogue to start playing.');
      return;
    }
    try { setGames(await fetchGames(fetcher)); }
    catch { showProblem('Could not load this game', 'Check your connection and try again.', true); }
  }

  function startGame() {
    if (!selected) return;
    const iframe = element(doc, 'iframe');
    iframe.src = selected.url; // Already checked against the exact GameMonetize host allowlist.
    iframe.title = `Play ${selected.title}`;
    iframe.setAttribute('allow', 'autoplay; fullscreen; gamepad');
    iframe.setAttribute('allowfullscreen', '');
    iframe.setAttribute('referrerpolicy', 'strict-origin-when-cross-origin');
    // The game runs on a separate origin. Permit game controls and ad click-throughs,
    // but not automatic top-level navigation or access to the storefront's DOM.
    iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-pointer-lock allow-orientation-lock allow-popups allow-popups-to-escape-sandbox allow-top-navigation-by-user-activation');
    frameHost.replaceChildren(iframe);
    frameHost.hidden = false;
    cover.hidden = true;
    restart.hidden = false;
    stop.hidden = false;
    fullscreen.hidden = typeof stage.requestFullscreen !== 'function';
    note.textContent = 'Games are hosted by GameMonetize and may contain ads.';
    iframe.focus();
  }

  play.addEventListener('click', startGame);
  restart.addEventListener('click', startGame);
  stop.addEventListener('click', () => { resetPlayer(); play.focus(); });
  fullscreen.addEventListener('click', async () => {
    try { await stage.requestFullscreen(); }
    catch { note.textContent = 'Fullscreen is unavailable in this browser. You can still play here.'; }
  });
  return { load, setGames };
}
