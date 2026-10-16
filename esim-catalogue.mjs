// Travel eSIM catalogue logic, shared by the storefront browser (esim.js), the admin
// console (admin-esim.html), store.js and — by matching constants — firestore.rules.
//
// Nothing here is supplier inventory: destinations are a convenience list for the admin,
// and every price, allowance and validity comes from a plan an admin types in by hand.
// Kept free of Firebase so it can be unit-tested in Node.

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

// The destinations an admin can pick when adding a plan. Typing any other name is
// allowed too — it simply becomes a destination of its own (destinationIdFor).
export const DESTINATIONS = Object.freeze([
  ...countries.map(([id, name, keywords = '']) => Object.freeze({ id, name, keywords, type: 'country', builtin: true })),
  ...['Africa', 'Asia', 'Caribbean', 'Europe', 'Global', 'Middle East', 'North America'].map(name => Object.freeze({
    id: name.toLowerCase().replaceAll(' ', '-'), name, keywords: '', type: 'region', builtin: true
  }))
].sort((a, b) => a.name.localeCompare(b.name, 'en')));

// Plan IDs are chosen by the admin and become the Firestore document id, so a plan has
// a stable id in its link — the same convention as /products.
export const ESIM_PLAN_ID_PATTERN = /^[A-Za-z0-9_-]{3,40}$/;
export const DESTINATION_ID_PATTERN = /^[A-Za-z0-9_-]{2,40}$/;
export const DESTINATION_TYPES = Object.freeze(['country', 'region']);

export const ESIM_PRICE_MIN = 1;
export const ESIM_PRICE_MAX = 5000000;
export const ESIM_VALIDITY_MIN_DAYS = 1;
export const ESIM_VALIDITY_MAX_DAYS = 3650;
// One eSIM per traveller, but a family can share an order.
export const ESIM_MAX_QUANTITY = 10;
export const ESIM_DESTINATION_NAME_MAX = 80;
export const ESIM_DATA_MAX = 40;
export const ESIM_NOTES_MAX = 2000;

export function flagFor(destination = {}) {
  if (destination.type === 'region') return '🌐';
  const id = String(destination.id || '');
  // Only ISO alpha-2 codes become flags; an admin's custom destination gets the globe.
  return /^[A-Z]{2}$/.test(id) ? String.fromCodePoint(...[...id].map(char => char.charCodeAt(0) + 127397)) : '🌐';
}

function normalize(value) {
  return String(value ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
}

// Searches any list of destinations — the built-ins, or the destinations that already
// have live plans grouped by groupPlansByDestination.
export function findDestinations(term = '', type = 'all', list = DESTINATIONS) {
  const needle = normalize(term);
  return list.filter(item => (type === 'all' || item.type === type)
    && normalize(`${item.name} ${item.id} ${item.keywords || ''}`).includes(needle))
    .sort((a, b) => Number(normalize(b.id) === needle) - Number(normalize(a.id) === needle));
}

export function normalizeDestinationName(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

// A built-in name (or code, or alias such as "Turkey") resolves to its ISO code; anything
// else becomes a slug, so custom destinations like "Kenya & Tanzania" work too.
export function destinationIdFor(name) {
  const wanted = normalizeDestinationName(name);
  const needle = normalize(wanted);
  const match = needle ? DESTINATIONS.find(item => normalize(item.name) === needle
    || normalize(item.id) === needle
    || normalize(item.keywords).split(' ').filter(Boolean).includes(needle)) : null;
  if (match) return match.id;
  const slug = needle.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '');
  return DESTINATION_ID_PATTERN.test(slug) ? slug : `dest-${slug || 'custom'}`.slice(0, 40);
}

export function validityLabel(days) {
  const value = Math.round(Number(days) || 0);
  return `${value} day${value === 1 ? '' : 's'}`;
}

// What a plan costs for a quantity, in whole naira. Zero means "not orderable".
export function esimOrderTotal(unitPrice, quantity) {
  const price = Math.round(Number(unitPrice));
  const amount = Math.round(Number(quantity));
  if (!Number.isSafeInteger(price) || price < ESIM_PRICE_MIN || price > ESIM_PRICE_MAX) return 0;
  if (!Number.isSafeInteger(amount) || amount < 1 || amount > ESIM_MAX_QUANTITY) return 0;
  return price * amount;
}

export function planDestination(plan = {}) {
  const id = String(plan.destinationId || '').trim();
  const type = plan.destinationType === 'region' ? 'region' : 'country';
  return {
    id,
    name: normalizeDestinationName(plan.destinationName) || 'Destination',
    type,
    keywords: '',
    flag: flagFor({ id, type })
  };
}

// The key that identifies a destination across plans ('country:ng', 'region:europe').
export function destinationKey(destination = {}) {
  const { type, id, name } = planDestination(destination);
  return `${type}:${normalize(id) || normalize(name)}`;
}

// Groups plans into the destination rows the storefront lists: cheapest plan first, and
// the cheapest price of the group is what the row advertises ("from ₦…").
export function groupPlansByDestination(plans = []) {
  const groups = new Map();
  for (const plan of plans) {
    if (!plan || typeof plan !== 'object') continue;
    const key = destinationKey(plan);
    if (!groups.has(key)) groups.set(key, { ...planDestination(plan), key, plans: [] });
    groups.get(key).plans.push(plan);
  }
  return [...groups.values()]
    .map(group => {
      const sorted = [...group.plans].sort((a, b) =>
        Number(a.price || 0) - Number(b.price || 0) || Number(a.validityDays || 0) - Number(b.validityDays || 0));
      return { ...group, plans: sorted, count: sorted.length, fromPrice: Number(sorted[0]?.price || 0) };
    })
    .sort((a, b) => a.name.localeCompare(b.name, 'en'));
}

// Everything the admin's destination field can offer: the built-ins plus any custom
// destination an existing plan already uses.
export function destinationOptions(plans = []) {
  const options = new Map(DESTINATIONS.map(item => [normalize(item.id), { ...item, flag: flagFor(item) }]));
  for (const plan of plans) {
    const destination = planDestination(plan);
    const key = normalize(destination.id) || normalize(destination.name);
    if (!options.has(key)) options.set(key, destination);
  }
  return [...options.values()].sort((a, b) => a.name.localeCompare(b.name, 'en'));
}

// The single validation used by the admin form and by store.js before it writes, so the
// browser, the write and firestore.rules cannot disagree about what a plan looks like.
export function validatePlanDraft(draft = {}, { plans = [], editingId = null } = {}) {
  const fail = error => ({ ok: false, error });
  const planId = String(draft.planId || '').trim();
  if (!ESIM_PLAN_ID_PATTERN.test(planId)) {
    return fail('Plan ID must be 3–40 letters, numbers, dashes or underscores.');
  }
  if (editingId == null && plans.some(plan => plan.id === planId)) {
    return fail(`Plan ID “${planId}” is already used. Pick another one.`);
  }
  const destinationName = normalizeDestinationName(draft.destinationName).slice(0, ESIM_DESTINATION_NAME_MAX + 1);
  if (!destinationName) return fail('Choose or type the destination this plan is for.');
  if (destinationName.length > ESIM_DESTINATION_NAME_MAX) {
    return fail(`Destination names must be ${ESIM_DESTINATION_NAME_MAX} characters or fewer.`);
  }
  const destinationType = draft.destinationType === 'region' ? 'region' : 'country';
  const data = String(draft.data || '').trim();
  if (!data) return fail('Enter the data allowance, for example “5 GB”.');
  if (data.length > ESIM_DATA_MAX) return fail(`Data allowance must be ${ESIM_DATA_MAX} characters or fewer.`);
  const validityDays = Math.round(Number(draft.validityDays));
  if (!Number.isSafeInteger(validityDays) || validityDays < ESIM_VALIDITY_MIN_DAYS || validityDays > ESIM_VALIDITY_MAX_DAYS) {
    return fail(`Validity must be a whole number of days between ${ESIM_VALIDITY_MIN_DAYS} and ${ESIM_VALIDITY_MAX_DAYS}.`);
  }
  const price = Math.round(Number(draft.price));
  if (!Number.isSafeInteger(price) || price < ESIM_PRICE_MIN || price > ESIM_PRICE_MAX) {
    return fail(`Selling price must be a whole number between ₦${ESIM_PRICE_MIN.toLocaleString('en-NG')} and ₦${ESIM_PRICE_MAX.toLocaleString('en-NG')}.`);
  }
  const compareText = String(draft.compareAtPrice ?? '').trim();
  const compareAtPrice = compareText === '' ? 0 : Math.round(Number(compareText));
  if (!Number.isSafeInteger(compareAtPrice) || compareAtPrice < 0) return fail('Original price must be zero or more.');
  if (compareAtPrice && compareAtPrice <= price) {
    return fail('The slashed original price must be higher than the selling price (or empty).');
  }
  const notes = String(draft.notes || '').trim();
  if (notes.length > ESIM_NOTES_MAX) return fail(`Activation notes must be ${ESIM_NOTES_MAX.toLocaleString('en-NG')} characters or fewer.`);

  const destinationId = destinationIdFor(destinationName);
  const twin = plans.find(plan => plan.id !== planId
    && destinationKey(plan) === destinationKey({ destinationId, destinationType })
    && String(plan.data || '').trim().toLowerCase() === data.toLowerCase()
    && Math.round(Number(plan.validityDays)) === validityDays);
  if (twin) {
    return fail(`${destinationName} already has a ${data} / ${validityLabel(validityDays)} plan (${twin.id}). Edit that plan instead.`);
  }

  return {
    ok: true,
    plan: {
      destinationId,
      destinationName,
      destinationType,
      data,
      validityDays,
      price,
      compareAtPrice,
      notes,
      active: draft.active !== false
    }
  };
}
