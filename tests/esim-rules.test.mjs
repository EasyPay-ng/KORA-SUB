import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  ESIM_MAX_QUANTITY, ESIM_NOTES_MAX, ESIM_PRICE_MAX, ESIM_PRICE_MIN,
  ESIM_VALIDITY_MAX_DAYS, ESIM_VALIDITY_MIN_DAYS
} from '../esim-catalogue.mjs';

// The Firestore emulator needs a JVM, which this repo's tests deliberately do not
// require. So instead of executing the rules, these checks pin the two things that
// silently break an eSIM sale or, worse, its wallet protection: the rules file must
// still be well-formed, and its numbers must match the constants the client uses.
const rules = await readFile(new URL('../firestore.rules', import.meta.url), 'utf8');

function block(name) {
  const start = rules.indexOf(`match /${name}/`);
  assert.notEqual(start, -1, `no rule block for /${name}`);
  // Skip past the "match /name/{id}" header — its own braces are not the body's.
  let i = rules.indexOf('}', rules.indexOf('{', start)) + 1;
  let depth = 0;
  for (; i < rules.length; i += 1) {
    if (rules[i] === '{') depth += 1;
    if (rules[i] === '}') {
      depth -= 1;
      if (depth === 0) return rules.slice(start, i + 1);
    }
  }
  throw new Error(`unbalanced braces in /${name}`);
}

test('the rules file is still well formed', () => {
  // Strip comments and quoted strings before counting brackets.
  const code = rules.replace(/\/\/[^\n]*/g, '').replace(/'(?:[^'\\]|\\.)*'/g, "''");
  for (const [open, close] of [['{', '}'], ['(', ')'], ['[', ']']]) {
    const count = (char) => [...code].filter(c => c === char).length;
    assert.equal(count(open), count(close), `${open}${close} are not balanced`);
  }
});

test('eSIM plans: only admins write, and only within the client limits', () => {
  const plans = block('esimPlans');
  assert.match(plans, /allow read: if resource\.data\.active == true \|\| isAdmin\(\);/);
  assert.match(plans, /allow create: if isAdmin\(\)\s*&& planId\.matches\('\^\[A-Za-z0-9_-\]\{3,40\}\$'\)/);
  assert.match(plans, new RegExp(`request\\.resource\\.data\\.price >= ${ESIM_PRICE_MIN}`));
  assert.match(plans, new RegExp(`request\\.resource\\.data\\.price <= ${ESIM_PRICE_MAX}`));
  assert.match(plans, new RegExp(`request\\.resource\\.data\\.validityDays >= ${ESIM_VALIDITY_MIN_DAYS}`));
  assert.match(plans, new RegExp(`request\\.resource\\.data\\.validityDays <= ${ESIM_VALIDITY_MAX_DAYS}`));
  assert.match(plans, /request\.resource\.data\.destinationType in \['country', 'region'\]/);
  assert.match(plans, new RegExp(`request\\.resource\\.data\\.notes\\.size\\(\\) <= ${ESIM_NOTES_MAX}`));
  assert.equal(plans.match(/allow update: if isAdmin\(\)/g).length, 1, 'admins get exactly one edit rule');
  assert.match(plans, /allow delete: if isAdmin\(\);/);
  // A shopper may only move the sold counter, with the order from the same batch.
  assert.match(plans, /allow update: if signedIn\(\)\s*&& request\.resource\.data\.diff\(resource\.data\)\.affectedKeys\(\)\.hasOnly\(\['sold', 'lastOrderId', 'updatedAt'\]\)/);
  assert.match(plans, /esimOrders\/\$\(request\.resource\.data\.lastOrderId\)\)\.data\.status == 'paid'/);
  // No rule may let a customer change a price.
  assert.ok(!/allow update: if signedIn\(\)[\s\S]{0,400}request\.resource\.data\.price/.test(plans));
});

test('eSIM orders: paid once, priced by the catalogue, debited from the wallet', () => {
  const orders = block('esimOrders');
  assert.match(orders, /allow read: if \(signedIn\(\) && resource\.data\.uid == request\.auth\.uid\) \|\| isAdmin\(\);/);
  assert.match(orders, /allow create: if signedIn\(\)\s*&& orderId == request\.auth\.uid \+ '_' \+ request\.resource\.data\.requestId/);
  assert.match(orders, /request\.resource\.data\.status == 'paid'/);
  assert.match(orders, new RegExp(`request\\.resource\\.data\\.quantity <= ${ESIM_MAX_QUANTITY}`));
  assert.match(orders, /request\.resource\.data\.total == request\.resource\.data\.unitPrice \* request\.resource\.data\.quantity/);
  // The plan as it is now decides the price and the details recorded on the order.
  assert.match(orders, /esimPlans\/\$\(request\.resource\.data\.planId\)\)\.data\.active == true/);
  assert.match(orders, /esimPlans\/\$\(request\.resource\.data\.planId\)\)\.data\.price == request\.resource\.data\.unitPrice/);
  assert.match(orders, /esimPlans\/\$\(request\.resource\.data\.planId\)\)\.data\.data == request\.resource\.data\.data/);
  // The wallet must fall by exactly the order total, and never go negative.
  assert.match(orders, /getAfter\(\/databases\/\$\(database\)\/documents\/users\/\$\(request\.auth\.uid\)\)\.data\.balance\s*== get\(\/databases\/\$\(database\)\/documents\/users\/\$\(request\.auth\.uid\)\)\.data\.get\('balance', 0\) - request\.resource\.data\.total/);
  assert.match(orders, /getAfter\(\/databases\/\$\(database\)\/documents\/users\/\$\(request\.auth\.uid\)\)\.data\.balance >= 0/);
  // Delivery and refunds are admin-only; nothing is ever deleted.
  assert.match(orders, /allow update: if isAdmin\(\)\s*&& request\.resource\.data\.diff\(resource\.data\)\.affectedKeys\(\)\.hasOnly\(\['status', 'updatedAt', 'cancelledAt', 'instructions'\]\)/);
  assert.match(orders, /resource\.data\.status == 'paid' && request\.resource\.data\.status in \['processing', 'cancelled'\]/);
  assert.match(orders, /resource\.data\.status == 'processing' && request\.resource\.data\.status in \['delivered', 'cancelled'\]/);
  assert.match(orders, /allow delete: if false;/);
  assert.ok(!/allow update: if signedIn\(\)/.test(orders), 'a customer cannot edit their own eSIM order');
});

test('the wallet, wallet history and ledger all recognise an eSIM purchase', () => {
  const users = block('users');
  assert.match(users, /hasOnly\(\['balance', 'lastEsimOrderId', 'updatedAt'\]\)/);
  assert.match(users, /esimOrders\/\$\(request\.resource\.data\.lastEsimOrderId\)\)\.data\.uid == uid/);
  assert.match(users, /request\.resource\.data\.type == 'esim'/);
  const ledger = block('ledger');
  assert.match(ledger, /request\.resource\.data\.type == 'esim'/);
  assert.match(ledger, /esimOrders\/\$\(request\.resource\.data\.reference\)\)\.data\.uid == request\.auth\.uid/);
});
