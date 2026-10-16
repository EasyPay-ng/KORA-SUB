import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';

// No CDN, Firebase, credentials, or browser binaries are needed for these tests.
test('eSIM sample browser interactions', async t => {
  const html = await readFile(new URL('../esim.html', import.meta.url), 'utf8');
  const dom = new JSDOM(html, { url: 'https://store.example/esim.html' });
  globalThis.document = dom.window.document;
  await import('../esim.js');
  const $ = selector => document.querySelector(selector);
  const input = value => {
    $('#esim-search').value = value;
    $('#esim-search').dispatchEvent(new dom.window.Event('input'));
  };
  await t.test('initial list and filters render', () => {
    assert.equal(document.querySelectorAll('.esim-destination').length, 41);
    $('[data-filter="region"]').click();
    assert.equal(document.querySelectorAll('.esim-destination').length, 7);
    assert.equal($('[data-filter="region"]').getAttribute('aria-pressed'), 'true');
    $('[data-filter="all"]').click();
  });
  await t.test('search opens sample plans, disables purchases, and restores focus', () => {
    input('nigeria');
    assert.equal(document.querySelectorAll('.esim-destination').length, 1);
    $('[data-destination="NG"]').click();
    assert.equal($('#destination-title').textContent, 'Nigeria');
    assert.equal($('#plans-view').hidden, false);
    assert.equal($('#destinations-view').hidden, true);
    assert.equal(document.activeElement.id, 'destination-title');
    assert.equal(document.querySelectorAll('.esim-plan').length, 3);
    assert.ok([...document.querySelectorAll('.esim-plan button')].every(b => b.disabled));
    $('#back-destinations').click();
    assert.equal($('#plans-view').hidden, true);
    assert.equal($('#esim-search').value, 'nigeria');
    assert.equal(document.activeElement.dataset.destination, 'NG');
  });
  await t.test('no-match search is safe and resets filters', () => {
    input('<img src=x onerror=alert(1)>');
    assert.equal($('#destination-list img'), null);
    assert.match($('#destination-list').textContent, /No destinations match/);
    $('#destination-list button').click();
    assert.equal($('#esim-search').value, '');
    assert.equal(document.querySelectorAll('.esim-destination').length, 41);
  });
  await t.test('tabs work with mouse and keyboard, and explore returns to search', () => {
    $('#my-tab').click();
    assert.equal($('#my-panel').hidden, false);
    assert.equal($('#buy-panel').hidden, true);
    $('#my-tab').dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    assert.equal($('#buy-tab').getAttribute('aria-selected'), 'true');
    assert.equal(document.activeElement.id, 'buy-tab');
    $('#my-tab').click();
    $('#explore-destinations').click();
    assert.equal($('#buy-panel').hidden, false);
    assert.equal($('#destinations-view').hidden, false);
  });
  dom.window.close();
  delete globalThis.document;
});
