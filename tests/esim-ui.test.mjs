import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { createEsimPage } from '../esim.js';

// No CDN, Firebase, credentials or browser binaries are needed: esim.js is handed the
// plans, the signed-in customer and their orders, so the whole page can be driven here.
const PLANS = [
  { id: 'NG-1GB-7D', destinationId: 'NG', destinationName: 'Nigeria', destinationType: 'country', data: '1 GB', validityDays: 7, price: 3500, compareAtPrice: 0, notes: 'Data only, no calls.', active: true },
  { id: 'NG-5GB-30D', destinationId: 'NG', destinationName: 'Nigeria', destinationType: 'country', data: '5 GB', validityDays: 30, price: 9800, compareAtPrice: 12000, notes: 'Validity starts on first connection.', active: true },
  { id: 'EU-10GB-30D', destinationId: 'europe', destinationName: 'Europe', destinationType: 'region', data: '10 GB', validityDays: 30, price: 21000, compareAtPrice: 0, notes: '', active: true },
  { id: 'KE-3GB-15D', destinationId: 'KE', destinationName: 'Kenya', destinationType: 'country', data: '3 GB', validityDays: 15, price: 6000, compareAtPrice: 0, notes: '', active: false }
];

async function setup({ onBuy } = {}) {
  const html = await readFile(new URL('../esim.html', import.meta.url), 'utf8');
  const dom = new JSDOM(html, { url: 'https://store.example/esim.html' });
  const doc = dom.window.document;
  const bought = [];
  const page = createEsimPage({
    doc,
    statusLabel: (status) => ({ paid: 'Paid', processing: 'Processing', delivered: 'Delivered', cancelled: 'Cancelled' })[status] || status,
    statusClass: (status) => (status === 'delivered' ? 'ok' : 'wait'),
    onBuy: onBuy || (async (planId, quantity) => {
      bought.push({ planId, quantity });
      return { orderId: 'uid_abcdef123456', total: 3500 * quantity, status: 'paid' };
    })
  });
  const $ = (selector) => doc.querySelector(selector);
  // click() returns before an async listener finishes; let its microtasks run.
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  return { dom, doc, page, bought, $, settle };
}

test('eSIM browser: destinations, plans and buying from the wallet', async t => {
  const { dom, doc, page, bought, $, settle } = await setup();

  await t.test('lists only destinations with listed plans, cheapest first', () => {
    page.setPlans(PLANS);
    const rows = [...doc.querySelectorAll('.esim-destination')];
    assert.deepEqual(rows.map(row => row.dataset.destination), ['europe', 'NG'], 'hidden Kenya is not listed, Europe sorts first');
    assert.match(rows[1].textContent, /2 plans · from ₦3,500/);
    assert.match($('#destination-count').textContent, /2 destinations with live plans/);
  });

  await t.test('search and filters narrow the list', () => {
    $('#esim-search').value = 'nigeria';
    $('#esim-search').dispatchEvent(new dom.window.Event('input'));
    assert.equal(doc.querySelectorAll('.esim-destination').length, 1);
    $('#esim-search').value = '';
    $('#esim-search').dispatchEvent(new dom.window.Event('input'));
    $('[data-filter="region"]').click();
    assert.deepEqual([...doc.querySelectorAll('.esim-destination b')].map(b => b.textContent), ['Europe']);
    assert.equal($('[data-filter="region"]').getAttribute('aria-pressed'), 'true');
    $('[data-filter="all"]').click();
    assert.equal(doc.querySelectorAll('.esim-destination').length, 2);
  });

  await t.test('a destination shows its plans with live prices', () => {
    $('[data-destination="NG"]').click();
    assert.equal($('#plans-view').hidden, false);
    assert.equal($('#destinations-view').hidden, true);
    assert.equal($('#destination-title').textContent, 'Nigeria');
    assert.equal($('#destination-flag').textContent, '🇳🇬');
    assert.equal(doc.activeElement.id, 'destination-title');
    const cards = [...doc.querySelectorAll('.esim-plan')];
    assert.deepEqual(cards.map(card => card.querySelector('h3').textContent), ['1 GB', '5 GB']);
    assert.equal(cards[0].querySelector('b').textContent, '₦3,500');
    assert.equal(cards[1].querySelector('b').textContent, '₦12,000 ₦9,800');
    assert.equal(cards[1].querySelector('s').textContent, '₦12,000');
    assert.equal(cards[0].querySelector('small').textContent, 'Data only, no calls.');
    assert.equal($('#buy-box').hidden, true);
  });

  await t.test('buying asks for sign-in while signed out', () => {
    doc.querySelector('[data-buy="NG-1GB-7D"]').click();
    assert.equal($('#buy-box').hidden, false);
    assert.equal($('#buy-plan-title').textContent, 'Nigeria · 1 GB · 7 days');
    assert.equal($('#buy-plan-price').textContent, '₦3,500');
    assert.equal($('#buy-signed-out').hidden, false);
    assert.equal($('#buy-signed-in').hidden, true);
    $('#buy-signin').click();
    assert.equal(bought.length, 0, 'nothing is charged while signed out');
  });

  await t.test('a signed-in customer sees the wallet total and can pay', async () => {
    page.setViewer({ signedIn: true, balance: 20000 });
    assert.equal($('#buy-signed-in').hidden, false);
    assert.equal($('#buy-balance').textContent, '₦20,000');
    assert.equal($('#buy-pay').textContent, 'Pay ₦3,500 from wallet');
    assert.equal($('#buy-pay').disabled, false);
    $('#buy-quantity').value = '3';
    $('#buy-quantity').dispatchEvent(new dom.window.Event('input'));
    assert.equal($('#buy-pay').textContent, 'Pay ₦10,500 from wallet');
    $('#buy-pay').click();
    await settle();
    assert.deepEqual(bought, [{ planId: 'NG-1GB-7D', quantity: 3 }]);
    assert.match($('#esim-notice').textContent, /eSIM ordered/);
    assert.match($('#esim-notice').textContent, /EF123456/);
    assert.equal($('#buy-box').hidden, true);
    assert.equal($('#my-panel').hidden, false, 'the traveller is taken to My eSIMs');
    assert.equal($('#buy-tab').getAttribute('aria-selected'), 'false');
  });

  await t.test('an order appears under My eSIMs with its activation details', () => {
    page.setOrders([{
      id: 'uid_abcdef123456', status: 'delivered', destinationName: 'Nigeria', data: '1 GB',
      validityDays: 7, quantity: 3, total: 10500, email: 'ada@example.com',
      instructions: 'QR code sent to ada@example.com', createdAt: null
    }]);
    assert.match($('#esim-orders').textContent, /eSIM EF123456/);
    assert.match($('#esim-orders').textContent, /Nigeria · 1 GB · 7 days × 3/);
    assert.match($('#esim-orders').textContent, /Your activation details/);
    assert.equal($('#esim-orders .notice-icon').textContent, '✓');
  });

  await t.test('tabs work with mouse and keyboard', () => {
    $('#buy-tab').click();
    assert.equal($('#buy-panel').hidden, false);
    $('#buy-tab').dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    assert.equal($('#my-tab').getAttribute('aria-selected'), 'true');
    assert.equal(doc.activeElement.id, 'my-tab');
    $('#buy-tab').click();
  });

  await t.test('back to destinations keeps the search and restores focus', () => {
    $('#esim-search').value = 'nigeria';
    $('#esim-search').dispatchEvent(new dom.window.Event('input'));
    $('[data-destination="NG"]').click();
    $('#back-destinations').click();
    assert.equal($('#plans-view').hidden, true);
    assert.equal($('#destinations-view').hidden, false);
    assert.equal($('#esim-search').value, 'nigeria');
    assert.equal(doc.activeElement.dataset.destination, 'NG');
  });

  await t.test('a plan hidden mid-browse closes its purchase box', () => {
    $('[data-destination="NG"]').click();
    doc.querySelector('[data-buy="NG-5GB-30D"]').click();
    assert.equal($('#buy-box').hidden, false);
    page.setPlans(PLANS.map(plan => plan.id === 'NG-5GB-30D' ? { ...plan, active: false } : plan));
    assert.equal($('#buy-box').hidden, true);
    assert.equal(doc.querySelectorAll('.esim-plan').length, 1);
  });

  await t.test('a low balance says how much is missing instead of charging', async () => {
    doc.querySelector('[data-buy="NG-1GB-7D"]').click();
    page.setViewer({ signedIn: true, balance: 1000 });
    assert.equal($('#buy-short').textContent, 'You need ₦2,500 more to pay for this.');
    $('#buy-pay').click();
    await settle();
    assert.match($('#buy-error').textContent, /Your wallet has ₦1,000 but this costs ₦3,500\. Fund your wallet first\./);
    assert.equal(bought.length, 1, 'still only the earlier purchase');
  });

  await t.test('an out-of-range quantity is rejected before any charge', async () => {
    page.setViewer({ signedIn: true, balance: 999999 });
    doc.querySelector('[data-buy="NG-1GB-7D"]').click();
    $('#buy-quantity').value = '50';
    $('#buy-quantity').dispatchEvent(new dom.window.Event('input'));
    $('#buy-pay').click();
    await settle();
    assert.match($('#buy-error').textContent, /between 1 and 10/);
    assert.equal(bought.length, 1);
  });

  await t.test('admin text is shown, never parsed as HTML', () => {
    $('#esim-search').value = '';
    $('#esim-search').dispatchEvent(new dom.window.Event('input'));
    page.setPlans([{
      id: 'GH-1GB-7D', destinationId: 'GH', destinationName: '<img src=x onerror=alert(1)>',
      destinationType: 'country', data: '<b>1 GB</b>', validityDays: 7, price: 2000,
      compareAtPrice: 0, notes: '<script>alert(1)</script>', active: true
    }]);
    assert.equal(doc.querySelector('#destination-list img'), null);
    assert.match($('#destination-list').textContent, /<img src=x onerror=alert\(1\)>/);
    doc.querySelector('.esim-destination').click();
    assert.equal(doc.querySelector('#plan-list script'), null);
    assert.equal(doc.querySelector('#plan-list b b'), null);
    assert.match($('#plan-list small').textContent, /<script>alert\(1\)<\/script>/);
    page.setPlans(PLANS);
    $('[data-destination="NG"]').click();
    assert.equal(doc.querySelector('#plan-list img'), null);
    assert.equal(doc.querySelector('#plan-list script'), null);
    page.setOrders([{
      id: 'uid_zzzzzzzz9999', status: 'paid', destinationName: 'Nigeria', data: '1 GB',
      validityDays: 7, quantity: 1, total: 3500, email: 'a@b.c',
      instructions: '<img src=x onerror=alert(1)>', createdAt: null
    }]);
    assert.equal(doc.querySelector('#esim-orders img'), null);
    assert.match($('#esim-orders').textContent, /<img src=x onerror=alert\(1\)>/);
  });

  await t.test('an empty catalogue and a failed load both explain themselves', () => {
    page.setPlans([]);
    assert.match($('#destination-list').textContent, /No plans listed yet/);
    page.setPlansError('Permission denied.');
    assert.match($('#destination-list').textContent, /Could not load eSIM plans/);
    assert.match($('#destination-list').textContent, /Permission denied/);
    assert.equal($('#destination-list button').textContent, 'Try again');
    page.setPlans(PLANS);
    assert.equal(doc.querySelectorAll('.esim-destination').length, 2);
  });

  await t.test('a search with no match offers a reset', () => {
    $('#esim-search').value = '<img src=x onerror=alert(1)>';
    $('#esim-search').dispatchEvent(new dom.window.Event('input'));
    assert.equal($('#destination-list img'), null);
    assert.match($('#destination-list').textContent, /No destinations match/);
    $('#destination-list button').click();
    assert.equal($('#esim-search').value, '');
    assert.equal(doc.querySelectorAll('.esim-destination').length, 2);
  });

  dom.window.close();
});

test('My eSIMs asks a signed-out visitor to sign in', async () => {
  const { dom, page, $ } = await setup();
  page.setPlans(PLANS);
  $('#my-tab').click();
  assert.match($('#esim-orders').textContent, /Sign in to see your eSIMs/);
  assert.equal($('#esim-orders button').textContent, 'Sign in');
  page.setViewer({ signedIn: true, balance: 0 });
  assert.match($('#esim-orders').textContent, /Loading your eSIMs…/);
  page.setOrders([]);
  assert.match($('#esim-orders').textContent, /Your next connection starts here/);
  $('#esim-orders button').click();
  assert.equal($('#buy-panel').hidden, false);
  dom.window.close();
});
