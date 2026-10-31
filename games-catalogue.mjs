// GameMonetize's feed is third-party input. Keep URL validation and normalisation
// shared by the static catalogue, the player and the optional feed import script.
const EMBED_HOSTS = new Set(['html5.gamemonetize.co', 'html5.gamemonetize.com']);
const IMAGE_HOSTS = new Set(['img.gamemonetize.com']);
const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  ndash: '–', mdash: '—', hellip: '…', rsquo: '’', lsquo: '‘',
  rdquo: '”', ldquo: '“', bull: '•', copy: '©', reg: '®', trade: '™'
};

function decodeEntities(text) {
  return text.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (original, entity) => {
    if (entity[0] !== '#') return ENTITIES[entity.toLowerCase()] ?? original;
    const hex = entity[1]?.toLowerCase() === 'x';
    const code = Number.parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
    if (!Number.isInteger(code) || code < 1 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return ' ';
    return String.fromCodePoint(code);
  });
}

// The result is always displayed via textContent, never inserted as HTML. This
// cleanup is for readable descriptions, not the security boundary.
export function cleanGameText(value, maxLength = 500) {
  let text = typeof value === 'string' || typeof value === 'number' ? String(value) : '';
  for (let i = 0; i < 2; i += 1) {
    text = decodeEntities(text)
      .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
      .replace(/<a\b[^>]*>[\s\S]*?<\/a\s*>/gi, ' ')
      .replace(/<[^>]*>/g, ' ');
  }
  return text.replace(/https?:\/\/\S+/gi, ' ').replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ').trim().slice(0, maxLength).trim();
}

export function trustedEmbed(value) {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    const match = /^\/([a-z0-9]{32})\/?$/i.exec(url.pathname);
    if (url.protocol !== 'https:' || !EMBED_HOSTS.has(url.hostname) || url.username || url.password || url.port || !match) return null;
    return { id: match[1].toLowerCase(), url: url.href };
  } catch {
    return null;
  }
}

function trustedThumbnail(value, id) {
  if (typeof value !== 'string') return '';
  try {
    const url = new URL(value);
    const match = /^\/([a-z0-9]{32})\/[a-z0-9_-]+\.(?:jpe?g|png|webp)$/i.exec(url.pathname);
    if (url.protocol !== 'https:' || !IMAGE_HOSTS.has(url.hostname) || url.username || url.password || url.port || !match || match[1].toLowerCase() !== id) return '';
    return url.href;
  } catch {
    return '';
  }
}

function dimension(value, fallback) {
  const n = Number(value);
  return Number.isInteger(n) && n >= 100 && n <= 8192 ? n : fallback;
}

export function normalizeGame(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const embed = trustedEmbed(raw.url);
  const title = cleanGameText(raw.title, 120);
  if (!embed || !title) return null;
  const tags = Array.isArray(raw.tags) ? raw.tags : typeof raw.tags === 'string' ? raw.tags.split(',') : [];
  return {
    id: embed.id,
    title,
    category: cleanGameText(raw.category, 40) || 'Other',
    description: cleanGameText(raw.description, 600),
    instructions: cleanGameText(raw.instructions, 400),
    tags: [...new Set(tags.map(tag => cleanGameText(tag, 40)).filter(Boolean))].slice(0, 30),
    url: embed.url,
    thumb: trustedThumbnail(raw.thumb, embed.id),
    width: dimension(raw.width, 800),
    height: dimension(raw.height, 600)
  };
}

export function normalizeCatalogue(input) {
  if (!Array.isArray(input)) throw new Error('The game catalogue must be a JSON array.');
  const games = [];
  const seen = new Set();
  for (const entry of input) {
    const game = normalizeGame(entry);
    if (!game || seen.has(game.id)) continue;
    seen.add(game.id);
    games.push(game);
  }
  return games;
}

export function filterGames(games, { search = '', category = 'All' } = {}) {
  const term = String(search).trim().toLocaleLowerCase();
  return games.filter(game => {
    const categoryMatches = category === 'All' || game.category === category;
    const words = [game.title, game.category, game.description, ...game.tags].join(' ').toLocaleLowerCase();
    return categoryMatches && (!term || words.includes(term));
  });
}
