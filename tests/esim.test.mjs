import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DESTINATIONS, ESIM_MAX_QUANTITY, ESIM_PRICE_MAX, ESIM_PRICE_MIN,
  destinationIdFor, destinationKey, destinationOptions, esimOrderTotal, findDestinations,
  flagFor, groupPlansByDestination, planDestination, validatePlanDraft, validityLabel
} from '../esim-catalogue.mjs';

const plan = (over = {}) => ({
  id: 'NG-5GB-30D', destinationId: 'NG', destinationName: 'Nigeria', destinationType: 'country',
  data: '5 GB', validityDays: 30, price: 9800, compareAtPrice: 0, notes: '', active: true, ...over
});

test('built-in destinations are unique, sorted and carry no prices', () => {
  assert.equal(new Set(DESTINATIONS.map(d => d.id)).size, DESTINATIONS.length);
  assert.deepEqual(DESTINATIONS.map(d => d.name), DESTINATIONS.map(d => d.name).sort((a, b) => a.localeCompare(b, 'en')));
  assert.ok(DESTINATIONS.every(d => d.builtin && !('price' in d)));
});

test('search handles case, whitespace, accents, country codes and aliases', () => {
  for (const term of [' nigeria ', 'NIGERIA', 'NG']) assert.equal(findDestinations(term)[0].id, 'NG');
  assert.equal(findDestinations('aland')[0].id, 'AX');
  assert.equal(findDestinations('turkey')[0].id, 'TR');
  assert.equal(findDestinations('UAE')[0].id, 'AE');
  assert.equal(findDestinations('USA')[0].id, 'US');
  assert.equal(findDestinations('<script>')[0], undefined);
});

test('destination types combine with search, and any list can be searched', () => {
  assert.ok(findDestinations('', 'region').every(d => d.type === 'region'));
  assert.ok(findDestinations('', 'country').every(d => d.type === 'country'));
  assert.equal(findDestinations('Nigeria', 'region').length, 0);
  assert.equal(findDestinations().length, DESTINATIONS.length);
  assert.equal(findDestinations('no such country').length, 0);
  const live = [{ id: 'NG', name: 'Nigeria', type: 'country', keywords: '' }];
  assert.equal(findDestinations('nigeria', 'all', live).length, 1);
  assert.equal(findDestinations('ghana', 'all', live).length, 0);
});

test('flags come from ISO codes; regions and custom destinations get the globe', () => {
  assert.equal(flagFor(DESTINATIONS.find(d => d.id === 'NG')), '🇳🇬');
  assert.equal(flagFor(DESTINATIONS.find(d => d.id === 'africa')), '🌐');
  assert.equal(flagFor({ id: 'kenya-tanzania', type: 'country' }), '🌐');
  assert.equal(flagFor({}), '🌐');
  assert.equal(planDestination(plan({ destinationId: 'KE' })).flag, '🇰🇪');
});

test('built-in names, codes and aliases resolve to ISO ids; other names become slugs', () => {
  assert.equal(destinationIdFor('Nigeria'), 'NG');
  assert.equal(destinationIdFor('  nigeria '), 'NG');
  assert.equal(destinationIdFor('Türkiye'), 'TR');
  assert.equal(destinationIdFor('UAE'), 'AE');
  assert.equal(destinationIdFor('Kenya & Tanzania'), 'kenya-tanzania');
  assert.equal(destinationIdFor('X'), 'dest-x');
  assert.match(destinationIdFor('Kenya & Tanzania'), /^[A-Za-z0-9_-]{2,40}$/);
});

test('validity labels read naturally', () => {
  assert.equal(validityLabel(1), '1 day');
  assert.equal(validityLabel(30), '30 days');
});

test('an order costs the plan price per eSIM, and only within the limits', () => {
  assert.equal(esimOrderTotal(9800, 1), 9800);
  assert.equal(esimOrderTotal(9800, 3), 29400);
  assert.equal(esimOrderTotal(9800, 0), 0);
  assert.equal(esimOrderTotal(9800, ESIM_MAX_QUANTITY + 1), 0);
  assert.equal(esimOrderTotal(0, 1), 0);
  assert.equal(esimOrderTotal(ESIM_PRICE_MAX + 1, 1), 0);
  assert.equal(esimOrderTotal('not a price', 1), 0);
  assert.ok(ESIM_PRICE_MIN === 1);
});

test('plans group into destinations, cheapest first, with a from-price', () => {
  const groups = groupPlansByDestination([
    plan({ id: 'NG-5GB-30D', price: 9800 }),
    plan({ id: 'NG-1GB-7D', data: '1 GB', validityDays: 7, price: 3500 }),
    plan({ id: 'EU-10GB-30D', destinationId: 'europe', destinationName: 'Europe', destinationType: 'region', data: '10 GB', price: 21000 }),
    plan({ id: 'NG-1GB-7D-DUP', destinationName: ' nigeria ', price: 4000 })
  ]);
  assert.deepEqual(groups.map(g => g.name), ['Europe', 'Nigeria']);
  const nigeria = groups.find(g => g.name === 'Nigeria');
  assert.equal(nigeria.count, 3, 'the same destination written differently still groups together');
  assert.deepEqual(nigeria.plans.map(p => p.price), [3500, 4000, 9800]);
  assert.equal(nigeria.fromPrice, 3500);
  assert.equal(nigeria.flag, '🇳🇬');
  assert.equal(nigeria.key, 'country:ng');
  assert.equal(destinationKey({ destinationId: 'europe', destinationType: 'region' }), 'region:europe');
});

test('the admin destination list keeps the built-ins and learns custom ones', () => {
  const options = destinationOptions([plan({ destinationId: 'kenya-tanzania', destinationName: 'Kenya & Tanzania' })]);
  assert.ok(options.some(option => option.id === 'NG' && option.name === 'Nigeria'));
  assert.ok(options.some(option => option.name === 'Kenya & Tanzania'));
  assert.equal(options.filter(option => option.name === 'Nigeria').length, 1);
  assert.ok(options.every(option => option.flag));
});

test('a complete draft validates into the exact plan that gets written', () => {
  const result = validatePlanDraft({
    planId: 'KE-3GB-15D', destinationName: '  Kenya ', destinationType: 'country',
    data: '3 GB', validityDays: '15', price: '6000', compareAtPrice: '', notes: ' Data only. ', active: true
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.plan, {
    destinationId: 'KE', destinationName: 'Kenya', destinationType: 'country',
    data: '3 GB', validityDays: 15, price: 6000, compareAtPrice: 0, notes: 'Data only.', active: true
  });
});

test('invalid drafts are rejected with a reason the admin can act on', () => {
  const good = {
    planId: 'NG-5GB-30D', destinationName: 'Nigeria', destinationType: 'country',
    data: '5 GB', validityDays: 30, price: 9800, compareAtPrice: '', notes: '', active: true
  };
  const reason = (draft, options) => validatePlanDraft({ ...good, ...draft }, options).error;
  assert.match(reason({ planId: 'ng' }), /3–40 letters/);
  assert.match(reason({ destinationName: '   ' }), /destination/i);
  assert.match(reason({ data: '' }), /data allowance/i);
  assert.match(reason({ validityDays: 0 }), /whole number of days/);
  assert.match(reason({ validityDays: 4000 }), /whole number of days/);
  assert.match(reason({ price: 0 }), /Selling price/);
  assert.match(reason({ price: 'abc' }), /Selling price/);
  assert.match(reason({ compareAtPrice: 5000 }), /higher than the selling price/);
  assert.equal(validatePlanDraft(good).ok, true);
});

test('a plan ID cannot be reused, and a destination cannot hold two identical plans', () => {
  const good = {
    planId: 'NG-5GB-30D', destinationName: 'Nigeria', destinationType: 'country',
    data: '5 GB', validityDays: 30, price: 9800, compareAtPrice: '', notes: '', active: true
  };
  const existing = [plan({ id: 'NG-5GB-30D' })];
  assert.match(validatePlanDraft(good, { plans: existing }).error, /already used/);
  // Editing that same plan is allowed — it is not a duplicate of itself.
  assert.equal(validatePlanDraft({ ...good, price: 9000 }, { plans: existing, editingId: 'NG-5GB-30D' }).ok, true);
  const twin = validatePlanDraft({ ...good, planId: 'NG-5GB-30D-2', price: 9000 }, { plans: existing });
  assert.match(twin.error, /already has a 5 GB \/ 30 days plan/);
  assert.equal(validatePlanDraft({ ...good, planId: 'NG-10GB-30D', data: '10 GB' }, { plans: existing }).ok, true);
});

test('hidden plans stay valid drafts, and unknown types fall back to country', () => {
  const result = validatePlanDraft({
    planId: 'EU-1GB-7D', destinationName: 'Europe', destinationType: 'galaxy',
    data: '1 GB', validityDays: 7, price: 5000, notes: '', active: false
  });
  assert.equal(result.ok, true);
  assert.equal(result.plan.destinationType, 'country');
  assert.equal(result.plan.active, false);
});
