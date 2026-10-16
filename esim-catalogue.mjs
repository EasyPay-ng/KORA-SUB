// UI samples, NOT supplier inventory. Do not use these records for checkout.
// A live integration must replace these with server-validated supplier products.
const countries = [
  ['AF', 'Afghanistan'], ['AX', 'Åland Islands'], ['AL', 'Albania'],
  ['DZ', 'Algeria'], ['AD', 'Andorra'], ['AO', 'Angola'], ['AI', 'Anguilla'],
  ['AG', 'Antigua and Barbuda'], ['AR', 'Argentina'], ['AM', 'Armenia'],
  ['AW', 'Aruba'], ['AU', 'Australia'], ['AT', 'Austria'], ['BE', 'Belgium'],
  ['BR', 'Brazil'], ['CA', 'Canada'], ['CN', 'China'], ['EG', 'Egypt'],
  ['FR', 'France'], ['DE', 'Germany'], ['GH', 'Ghana'], ['IN', 'India'],
  ['IT', 'Italy'], ['JP', 'Japan'], ['KE', 'Kenya'], ['NG', 'Nigeria'],
  ['PT', 'Portugal'], ['SA', 'Saudi Arabia'], ['ZA', 'South Africa'],
  ['ES', 'Spain'], ['TR', 'Türkiye', 'Turkey'], ['AE', 'United Arab Emirates', 'UAE Dubai'],
  ['GB', 'United Kingdom', 'UK Britain'], ['US', 'United States', 'USA America']
];
export const SAMPLE_PLANS = Object.freeze([
  Object.freeze({ id: 'light', data: '1 GB', validity: '7 days' }),
  Object.freeze({ id: 'everyday', data: '3 GB', validity: '15 days' }),
  Object.freeze({ id: 'explorer', data: '5 GB', validity: '30 days' })
]);
export const DESTINATIONS = Object.freeze([
  ...countries.map(([id, name, keywords = '']) => Object.freeze({ id, name, keywords, type: 'country', sample: true })),
  ...['Africa', 'Asia', 'Caribbean', 'Europe', 'Global', 'Middle East', 'North America'].map(name => Object.freeze({
    id: name.toLowerCase().replaceAll(' ', '-'), name, keywords: '', type: 'region', sample: true
  }))
].sort((a, b) => a.name.localeCompare(b.name, 'en')));

export function flagFor(destination) {
  if (destination.type === 'region') return '🌐';
  return String.fromCodePoint(...[...destination.id].map(char => char.charCodeAt(0) + 127397));
}
function normalize(value) {
  return String(value).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
}
export function findDestinations(term = '', type = 'all') {
  const needle = normalize(term);
  return DESTINATIONS.filter(item => (type === 'all' || item.type === type)
    && normalize(`${item.name} ${item.id} ${item.keywords}`).includes(needle))
    .sort((a, b) => Number(normalize(b.id) === needle) - Number(normalize(a.id) === needle));
}
