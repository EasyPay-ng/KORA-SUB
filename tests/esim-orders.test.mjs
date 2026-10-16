import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { JSDOM } from 'jsdom';

// store.js adds one delegated click listener at import time, so give it a document.
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://store.example/' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.location = dom.window.location;
globalThis.localStorage = dom.window.localStorage;

// Load store.js itself — the real file — with the Firebase CDN pointed at an
// in-memory stub, so the eSIM purchase, refund and plan-write code paths actually run.
register('./helpers/firebase-loader.mjs', import.meta.url);
const { __reset, __doc } = await import('./helpers/firebase-sdk-stub.mjs');
const store = await import('../store.js');

const PLAN = {
  destinationId: 'NG', destinationName: 'Nigeria', destinationType: 'country',
  data: '5 GB', validityDays: 30, price: 9800, compareAtPrice: 0,
  notes: 'Validity starts on first connection.', active: true, sold: 0
};
const CUSTOMER = { uid: 'uid1', email: 'ada@example.com' };
const ORDER = 'uid1_request-1234';

function seed({ balance = 20000, plan = PLAN } = {}) {
  __reset({
    docs: {
      'esimPlans/NG-5GB-30D': { ...plan },
      'users/uid1': { name: 'Ada', email: CUSTOMER.email, balance }
    },
    user: CUSTOMER
  });
}

test('buying a plan debits the price × quantity and records everything the rules check', async () => {
  seed();
  const result = await store.placeEsimOrder('request-1234', { planId: 'NG-5GB-30D', quantity: 2 });
  assert.equal(result.duplicate, false);
  assert.equal(result.orderId, ORDER);
  assert.equal(result.total, 19600);
  assert.equal(result.balance, 400);

  const order = __doc(`esimOrders/${ORDER}`);
  assert.equal(order.status, 'paid');
  assert.equal(order.uid, 'uid1');
  assert.equal(order.requestId, 'request-1234');
  assert.equal(order.unitPrice, 9800);
  assert.equal(order.quantity, 2);
  assert.equal(order.total, 19600);
  assert.equal(order.destinationName, 'Nigeria');
  assert.equal(order.destinationId, 'NG');
  assert.equal(order.data, '5 GB');
  assert.equal(order.validityDays, 30);
  assert.equal(order.email, 'ada@example.com');

  assert.equal(__doc('users/uid1').balance, 400);
  assert.equal(__doc('users/uid1').lastEsimOrderId, ORDER);
  assert.equal(__doc(`users/uid1/transactions/esim_${ORDER}`).amount, -19600);
  assert.equal(__doc(`users/uid1/transactions/esim_${ORDER}`).type, 'esim');
  assert.equal(__doc(`ledger/esim_${ORDER}`).amount, -19600);
  assert.equal(__doc(`ledger/esim_${ORDER}`).uid, 'uid1');
  // The plan's counter moves with the order written in the same batch.
  assert.equal(__doc('esimPlans/NG-5GB-30D').sold, 2);
  assert.equal(__doc('esimPlans/NG-5GB-30D').lastOrderId, ORDER);
});

test('a retried checkout returns the original order instead of charging twice', async () => {
  seed();
  await store.placeEsimOrder('request-1234', { planId: 'NG-5GB-30D', quantity: 1 });
  const retry = await store.placeEsimOrder('request-1234', { planId: 'NG-5GB-30D', quantity: 3 });
  assert.equal(retry.duplicate, true);
  assert.equal(retry.total, 9800, 'the retry reports the original total, not a new one');
  assert.equal(__doc('users/uid1').balance, 10200);
  assert.equal(__doc('esimPlans/NG-5GB-30D').sold, 1);
});

test('an order costs what the plan says now, not what the browser showed', async () => {
  seed({ plan: { ...PLAN, price: 12500 } });
  const result = await store.placeEsimOrder('request-1234', { planId: 'NG-5GB-30D', quantity: 1 });
  assert.equal(result.total, 12500);
  assert.equal(__doc(`esimOrders/${ORDER}`).unitPrice, 12500);
});

test('a wallet that cannot cover the plan is refused and nothing is written', async () => {
  seed({ balance: 5000 });
  await assert.rejects(
    async () => store.placeEsimOrder('request-1234', { planId: 'NG-5GB-30D', quantity: 1 }),
    /Your wallet has ₦5,000 but this order costs ₦9,800\. Fund your wallet first\./
  );
  assert.equal(__doc('users/uid1').balance, 5000);
  assert.equal(__doc(`esimOrders/${ORDER}`), undefined);
  assert.equal(__doc('esimPlans/NG-5GB-30D').sold, 0);
});

test('only a listed plan can be bought, by a signed-in customer, within the quantity limit', async () => {
  seed({ plan: { ...PLAN, active: false } });
  await assert.rejects(
    async () => store.placeEsimOrder('request-1234', { planId: 'NG-5GB-30D', quantity: 1 }),
    /not available right now/
  );

  seed();
  await assert.rejects(
    async () => store.placeEsimOrder('request-1234', { planId: 'NG-9GB-30D', quantity: 1 }),
    /not available right now/
  );
  // A plan whose stored details the rules would refuse must fail readably, not as a
  // permission error, and must not touch the wallet.
  seed({ plan: { ...PLAN, validityDays: 0 } });
  await assert.rejects(
    async () => store.placeEsimOrder('request-1234', { planId: 'NG-5GB-30D', quantity: 1 }),
    /details are incomplete/
  );
  seed({ plan: { ...PLAN, price: 9800.5 } });
  await assert.rejects(
    async () => store.placeEsimOrder('request-1234', { planId: 'NG-5GB-30D', quantity: 1 }),
    /details are incomplete/
  );
  await assert.rejects(
    async () => store.placeEsimOrder('request-1234', { planId: 'NG-5GB-30D', quantity: 11 }),
    /between 1 and 10/
  );
  await assert.rejects(
    async () => store.placeEsimOrder('bad id', { planId: 'NG-5GB-30D', quantity: 1 }),
    /Request ID is invalid/
  );
  assert.equal(__doc('users/uid1').balance, 20000, 'none of the refused attempts touched the wallet');

  __reset({ docs: {}, user: null });
  await assert.rejects(
    async () => store.placeEsimOrder('request-1234', { planId: 'NG-5GB-30D', quantity: 1 }),
    /Sign in to continue/
  );
});

test('the admin writes a plan by hand, and an invalid one is refused', async () => {
  seed();
  await store.saveEsimPlan('KE-3GB-15D', {
    destinationName: '  Kenya ', destinationType: 'country', data: '3 GB',
    validityDays: '15', price: '6000', compareAtPrice: '', notes: ' Data only. ', active: true
  }, { isNew: true });
  const saved = __doc('esimPlans/KE-3GB-15D');
  assert.equal(saved.destinationId, 'KE');
  assert.equal(saved.destinationName, 'Kenya');
  assert.equal(saved.validityDays, 15);
  assert.equal(saved.price, 6000);
  assert.equal(saved.compareAtPrice, 0);
  assert.equal(saved.notes, 'Data only.');
  assert.equal(saved.sold, 0, 'a new plan starts with nothing sold');
  assert.ok(saved.createdAt && saved.updatedAt);

  await store.saveEsimPlan('KE-3GB-15D', { ...saved, price: 7000, active: false });
  assert.equal(__doc('esimPlans/KE-3GB-15D').price, 7000);
  assert.equal(__doc('esimPlans/KE-3GB-15D').active, false);

  await assert.rejects(async () => store.saveEsimPlan('KE-3GB-15D', { ...saved, price: 0 }), /Selling price/);
  await assert.rejects(async () => store.saveEsimPlan('ng', { ...saved }, { isNew: true }), /3–40 letters/);
  await assert.rejects(async () => store.saveEsimPlan('KE-3GB-15D', { ...saved, destinationName: '' }), /destination/i);
  assert.equal(__doc('esimPlans/KE-3GB-15D').price, 7000, 'a refused save leaves the stored plan alone');
});

test('the admin delivers an eSIM, and cancelling before delivery refunds the wallet', async () => {
  seed();
  await store.placeEsimOrder('request-1234', { planId: 'NG-5GB-30D', quantity: 1 });
  await store.setEsimOrderStatus(ORDER, 'processing');
  assert.equal(__doc(`esimOrders/${ORDER}`).status, 'processing');
  await store.setEsimOrderStatus(ORDER, 'delivered', { instructions: 'QR code sent to ada@example.com' });
  assert.equal(__doc(`esimOrders/${ORDER}`).status, 'delivered');
  assert.equal(__doc(`esimOrders/${ORDER}`).instructions, 'QR code sent to ada@example.com');
  await assert.rejects(async () => store.setEsimOrderStatus(ORDER, 'cancelled'), /cannot be changed to cancelled/);
  assert.equal(__doc('users/uid1').balance, 10200, 'a delivered order is not refunded');

  seed();
  await store.placeEsimOrder('request-4321', { planId: 'NG-5GB-30D', quantity: 1 });
  const refund = await store.setEsimOrderStatus('uid1_request-4321', 'cancelled');
  assert.equal(refund.refunded, 9800);
  assert.equal(refund.balance, 20000);
  assert.equal(__doc('users/uid1').balance, 20000);
  assert.equal(__doc('esimOrders/uid1_request-4321').status, 'cancelled');
  assert.equal(__doc('users/uid1/transactions/esimrefund_uid1_request-4321').amount, 9800);
  assert.equal(__doc('users/uid1/transactions/esimrefund_uid1_request-4321').type, 'refund');
  assert.equal(__doc('ledger/esimrefund_uid1_request-4321').actor, CUSTOMER.email);
});
