import test from 'node:test';
import assert from 'node:assert/strict';
import { DESTINATIONS, SAMPLE_PLANS, findDestinations, flagFor } from '../esim-catalogue.mjs';

test('all destinations are unique, sorted samples without billable prices', () => {
  assert.equal(new Set(DESTINATIONS.map(d => d.id)).size, DESTINATIONS.length);
  assert.deepEqual(DESTINATIONS.map(d => d.name), DESTINATIONS.map(d => d.name).sort((a,b) => a.localeCompare(b, 'en')));
  assert.ok(DESTINATIONS.every(d => d.sample && !('price' in d)));
  assert.ok(SAMPLE_PLANS.every(p => !('price' in p)));
});
test('search handles case, whitespace, accents, country codes and aliases', () => {
  for (const term of [' nigeria ', 'NIGERIA', 'NG']) assert.equal(findDestinations(term)[0].id, 'NG');
  assert.equal(findDestinations('aland')[0].id, 'AX');
  assert.equal(findDestinations('turkey')[0].id, 'TR');
  assert.equal(findDestinations('UAE')[0].id, 'AE');
  assert.equal(findDestinations('USA')[0].id, 'US');
  assert.equal(findDestinations('<script>')[0], undefined);
});
test('destination types combine with search and reset returns all', () => {
  assert.ok(findDestinations('', 'region').every(d => d.type === 'region'));
  assert.ok(findDestinations('', 'country').every(d => d.type === 'country'));
  assert.equal(findDestinations('Nigeria', 'region').length, 0);
  assert.equal(findDestinations().length, DESTINATIONS.length);
  assert.equal(findDestinations('no such country').length, 0);
});
test('flags are correct for countries and regions', () => {
  assert.equal(flagFor(DESTINATIONS.find(d => d.id === 'NG')), '🇳🇬');
  assert.equal(flagFor(DESTINATIONS.find(d => d.id === 'africa')), '🌐');
});
