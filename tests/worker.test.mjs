// Worker tests. Run with: npm test
// Uses a real RSA key pair to sign Firebase-style ID tokens and an in-memory fake of the
// Firestore REST API (beginTransaction / get / commit with update masks and preconditions).

import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, webcrypto } from "node:crypto";

const realFetch = globalThis.fetch;
const PROJECT = "korasub-test";
const ADMIN = "beniwealth70@gmail.com";
const KID = "test-kid";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const privatePem = privateKey.export({ type: "pkcs8", format: "pem" });
const publicJwk = { ...publicKey.export({ format: "jwk" }), kid: KID, use: "sig", alg: "RS256" };
const serviceAccount = { client_email: "svc@korasub-test.iam.gserviceaccount.com", private_key: privatePem };

const env = {
  FIREBASE_PROJECT_ID: PROJECT,
  ADMIN_EMAIL: ADMIN,
  FRONTEND_ORIGIN: "*",
  FIREBASE_SERVICE_ACCOUNT_JSON: JSON.stringify(serviceAccount)
};

// ----- fake Firestore -----

let docs = new Map();      // path -> { field: encodedValue }
let txCounter = 0;
let commitCount = 0;

function encodeFields(object) {
  const out = {};
  for (const [k, v] of Object.entries(object)) out[k] = encodeValue(v);
  return out;
}
function encodeValue(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === "string") return { stringValue: v };
  if (typeof v === "boolean") return { booleanValue: v };
  if (typeof v === "number") return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(encodeValue) } };
  return { mapValue: { fields: encodeFields(v) } };
}
function decodeValue(v) {
  if ("stringValue" in v) return v.stringValue;
  if ("integerValue" in v) return Number(v.integerValue);
  if ("doubleValue" in v) return v.doubleValue;
  if ("booleanValue" in v) return v.booleanValue;
  if ("timestampValue" in v) return v.timestampValue;
  if ("nullValue" in v) return null;
  if ("mapValue" in v) return Object.fromEntries(Object.entries(v.mapValue.fields || {}).map(([k, x]) => [k, decodeValue(x)]));
  if ("arrayValue" in v) return (v.arrayValue.values || []).map(decodeValue);
  return null;
}
function plain(path) {
  const fields = docs.get(path);
  if (!fields) return null;
  return Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, decodeValue(v)]));
}
function seed(path, data) {
  docs.set(path, encodeFields(data));
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}

function docPathFromUrl(url) {
  const after = decodeURIComponent(new URL(url).pathname).split("/documents")[1] || "";
  return after.replace(/^\//, "");
}

async function fakeFetch(input, init = {}) {
  const url = typeof input === "string" ? input : input.url;
  const method = (init.method || "GET").toUpperCase();

  if (url.startsWith("https://www.googleapis.com/service_accounts/")) {
    return new Response(JSON.stringify({ keys: [publicJwk] }), { headers: { "cache-control": "max-age=3600" } });
  }
  if (url === "https://oauth2.googleapis.com/token") {
    return json({ access_token: "fake-access-token", expires_in: 3600 });
  }
  if (url.startsWith("https://firestore.googleapis.com/")) {
    const pathname = new URL(url).pathname;
    if (pathname.endsWith("/documents:beginTransaction")) {
      txCounter += 1;
      return json({ transaction: `tx${txCounter}` });
    }
    if (pathname.endsWith("/documents:commit")) {
      const body = JSON.parse(init.body);
      commitCount += 1;
      // Validate preconditions first so a failing commit leaves the store untouched.
      for (const write of body.writes) {
        const path = decodeURIComponent(write.update.name.split("/documents/")[1]);
        const exists = docs.has(path);
        if (write.currentDocument?.exists === true && !exists) return json({ error: { status: "NOT_FOUND", message: "missing" } }, 404);
        if (write.currentDocument?.exists === false && exists) return json({ error: { status: "ALREADY_EXISTS", message: "exists" } }, 409);
      }
      for (const write of body.writes) {
        const path = decodeURIComponent(write.update.name.split("/documents/")[1]);
        if (write.updateMask) {
          const current = docs.get(path) || {};
          for (const field of write.updateMask.fieldPaths) current[field] = write.update.fields[field];
          docs.set(path, current);
        } else {
          docs.set(path, write.update.fields);
        }
      }
      return json({ writeResults: [] });
    }
    if (method === "GET") {
      const path = docPathFromUrl(url);
      const fields = docs.get(path);
      if (!fields) return json({ error: { status: "NOT_FOUND", message: "not found" } }, 404);
      return json({ name: path, fields });
    }
  }
  throw new Error(`Unexpected fetch in test: ${method} ${url}`);
}

globalThis.fetch = fakeFetch;

// ----- tokens -----

function b64url(input) {
  return Buffer.from(input).toString("base64url");
}
async function makeToken({ uid, email, emailVerified = true, admin = false }) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", kid: KID, typ: "JWT" }));
  const claims = b64url(JSON.stringify({
    iss: `https://securetoken.google.com/${PROJECT}`,
    aud: PROJECT,
    sub: uid,
    iat: now,
    exp: now + 3600,
    email,
    email_verified: emailVerified,
    ...(admin ? { admin: true } : {})
  }));
  const signature = (await webcrypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    await webcrypto.subtle.importKey("pkcs8", privateKey.export({ type: "pkcs8", format: "der" }), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]),
    Buffer.from(`${header}.${claims}`)
  ));
  return `${header}.${claims}.${Buffer.from(signature).toString("base64url")}`;
}

const customerToken = (uid = "cust1") => makeToken({ uid, email: `${uid}@example.com` });
const adminToken = () => makeToken({ uid: "admin1", email: ADMIN, admin: true });

// ----- fixtures -----

const { default: worker, __test } = await import("../worker/index.js");

function resetStore() {
  docs = new Map();
  seed("products/p1", { name: "Pulse Earbuds", price: 2500, stock: 5, sold: 0, active: true });
  seed("products/p2", { name: "Canvas Tote", price: 4000, stock: 0, sold: 0, active: true });
  seed("products/p3", { name: "Retired Lamp", price: 1000, stock: 9, sold: 0, active: false });
  seed("users/cust1", {
    name: "Ada", email: "cust1@example.com", balance: 10000,
    country: "Nigeria", state: "Delta", lga: "Warri South", address: "12 Market Road"
  });
  seed("fundingRequests/fr1", { uid: "cust1", amount: 3000, reference: "TRF-001", status: "pending" });
}

const delivery = { country: "Nigeria", state: "Delta", lga: "Warri South", address: "12 Market Road" };

async function http(path, { method = "POST", token, body } = {}) {
  const headers = { "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  const response = await worker.fetch(
    new Request(`https://api.test${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }),
    env
  );
  return { status: response.status, data: await response.json() };
}

before(() => {
  // Warm the module with a clean store.
  resetStore();
});

beforeEach(() => {
  resetStore();
  commitCount = 0;
});

// ----- order placement -----

test("checkout debits wallet, decrements stock and writes an order once", async () => {
  const result = await __test.placeOrder(env, { uid: "cust1" }, {
    requestId: "req-aaaa-1111",
    items: [{ productId: "p1", quantity: 2 }]
  });
  assert.equal(result.total, 5000);
  assert.equal(result.balance, 5000);
  assert.equal(plain("users/cust1").balance, 5000);
  assert.equal(plain("products/p1").stock, 3);
  assert.equal(plain("products/p1").sold, 2);
  const order = plain("orders/cust1_req-aaaa-1111");
  assert.equal(order.total, 5000);
  assert.equal(order.status, "paid");
  assert.equal(order.items[0].lineTotal, 5000);
  assert.equal(plain("ledger/purchase_cust1_req-aaaa-1111").amount, -5000);
  assert.ok(plain("users/cust1/transactions/purchase_cust1_req-aaaa-1111"));

  // Same requestId again: no second debit, no second stock change.
  const retry = await __test.placeOrder(env, { uid: "cust1" }, {
    requestId: "req-aaaa-1111",
    items: [{ productId: "p1", quantity: 2 }]
  });
  assert.equal(retry.duplicate, true);
  assert.equal(plain("users/cust1").balance, 5000);
  assert.equal(plain("products/p1").stock, 3);
});

test("checkout refuses insufficient balance without writing anything", async () => {
  seed("users/cust1", { ...plain("users/cust1"), balance: 1000 });
  await assert.rejects(
    __test.placeOrder(env, { uid: "cust1" }, { requestId: "req-bbbb-2222", items: [{ productId: "p1", quantity: 1 }] }),
    (error) => error.status === 402 && /Fund your wallet/.test(error.message)
  );
  assert.equal(plain("users/cust1").balance, 1000);
  assert.equal(plain("products/p1").stock, 5);
  assert.equal(plain("orders/cust1_req-bbbb-2222"), null);
});

test("checkout refuses out-of-stock and inactive products", async () => {
  await assert.rejects(
    __test.placeOrder(env, { uid: "cust1" }, { requestId: "req-cccc-3333", items: [{ productId: "p2", quantity: 1 }] }),
    (error) => error.status === 409 && /out of stock/.test(error.message)
  );
  await assert.rejects(
    __test.placeOrder(env, { uid: "cust1" }, { requestId: "req-dddd-4444", items: [{ productId: "p3", quantity: 1 }] }),
    (error) => error.status === 409 && /no longer available/.test(error.message)
  );
  assert.equal(plain("users/cust1").balance, 10000);
});

test("checkout requires a valid Nigerian state and LGA", async () => {
  seed("users/cust1", { ...plain("users/cust1"), lga: "Not A Real LGA" });
  await assert.rejects(
    __test.placeOrder(env, { uid: "cust1" }, { requestId: "req-eeee-5555", items: [{ productId: "p1", quantity: 1 }] }),
    (error) => error.status === 409 && /local government area/.test(error.message)
  );
});

test("checkout requires a delivery location", async () => {
  seed("users/cust1", { ...plain("users/cust1"), state: "", address: "" });
  await assert.rejects(
    __test.placeOrder(env, { uid: "cust1" }, { requestId: "req-ffff-6666", items: [{ productId: "p1", quantity: 1 }] }),
    (error) => error.status === 409 && /delivery location/.test(error.message)
  );
});

test("normaliseItems merges duplicates and rejects bad quantities", () => {
  assert.deepEqual(
    __test.normaliseItems([{ productId: "p1", quantity: 2 }, { productId: "p1", quantity: 3 }]),
    [{ productId: "p1", quantity: 5 }]
  );
  assert.throws(() => __test.normaliseItems([{ productId: "p1", quantity: 0 }]), (e) => e.status === 400);
  assert.throws(() => __test.normaliseItems([{ productId: "../x", quantity: 1 }]), (e) => e.status === 400);
  assert.throws(() => __test.normaliseItems([]), (e) => e.status === 400);
});

// ----- funding -----

test("approving a funding request credits the wallet exactly once", async () => {
  const admin = { email: ADMIN };
  const first = await __test.reviewFunding(env, admin, { requestId: "fr1", decision: "approve" });
  assert.equal(first.status, "approved");
  assert.equal(plain("users/cust1").balance, 13000);
  assert.equal(plain("fundingRequests/fr1").status, "approved");
  assert.equal(plain("ledger/funding_fr1").amount, 3000);
  await assert.rejects(
    __test.reviewFunding(env, admin, { requestId: "fr1", decision: "approve" }),
    (e) => e.status === 409
  );
  assert.equal(plain("users/cust1").balance, 13000);
});

test("rejecting a funding request leaves the wallet untouched", async () => {
  await __test.reviewFunding(env, { email: ADMIN }, { requestId: "fr1", decision: "reject" });
  assert.equal(plain("fundingRequests/fr1").status, "rejected");
  assert.equal(plain("users/cust1").balance, 10000);
});

// ----- order status and refunds -----

test("cancelling an order refunds the wallet and restocks products", async () => {
  await __test.placeOrder(env, { uid: "cust1" }, { requestId: "req-gggg-7777", items: [{ productId: "p1", quantity: 2 }] });
  const orderId = "cust1_req-gggg-7777";
  assert.equal(plain("users/cust1").balance, 5000);

  const moved = await __test.updateOrderStatus(env, { email: ADMIN }, { orderId, status: "processing" });
  assert.equal(moved.status, "processing");

  const cancelled = await __test.updateOrderStatus(env, { email: ADMIN }, { orderId, status: "cancelled" });
  assert.equal(cancelled.refunded, 5000);
  assert.equal(plain("users/cust1").balance, 10000);
  assert.equal(plain("products/p1").stock, 5);
  assert.equal(plain("products/p1").sold, 0);
  assert.equal(plain(`orders/${orderId}`).status, "cancelled");
  assert.equal(plain(`ledger/refund_${orderId}`).amount, 5000);

  await assert.rejects(
    __test.updateOrderStatus(env, { email: ADMIN }, { orderId, status: "shipped" }),
    (e) => e.status === 409
  );
});

test("order status cannot skip steps", async () => {
  await __test.placeOrder(env, { uid: "cust1" }, { requestId: "req-hhhh-8888", items: [{ productId: "p1", quantity: 1 }] });
  await assert.rejects(
    __test.updateOrderStatus(env, { email: ADMIN }, { orderId: "cust1_req-hhhh-8888", status: "delivered" }),
    (e) => e.status === 409
  );
});

// ----- HTTP routes and auth -----

test("routes reject anonymous and non-admin callers", async () => {
  const anon = await http("/api/orders", { body: { requestId: "req-anon-0001", items: [{ productId: "p1", quantity: 1 }] } });
  assert.equal(anon.status, 401);

  const customer = await customerToken();
  const notAdmin = await http("/api/admin/funding/review", { token: customer, body: { requestId: "fr1", decision: "approve" } });
  assert.equal(notAdmin.status, 403);
  assert.equal(plain("users/cust1").balance, 10000);

  // Admin email without the admin claim is rejected too.
  const unclaimed = await makeToken({ uid: "admin1", email: ADMIN, admin: false });
  const noClaim = await http("/api/admin/funding/review", { token: unclaimed, body: { requestId: "fr1", decision: "approve" } });
  assert.equal(noClaim.status, 403);
});

test("a signed-in customer can buy through POST /api/orders", async () => {
  const token = await customerToken();
  const response = await http("/api/orders", {
    token,
    body: { requestId: "req-http-0001", items: [{ productId: "p1", quantity: 1 }] }
  });
  assert.equal(response.status, 200, JSON.stringify(response.data));
  assert.equal(response.data.total, 2500);
  assert.equal(plain("users/cust1").balance, 7500);
});

test("admin can approve funding and move orders through the HTTP API", async () => {
  const admin = await adminToken();
  const approved = await http("/api/admin/funding/review", { token: admin, body: { requestId: "fr1", decision: "approve" } });
  assert.equal(approved.status, 200, JSON.stringify(approved.data));
  assert.equal(plain("users/cust1").balance, 13000);

  const customer = await customerToken();
  const order = await http("/api/orders", { token: customer, body: { requestId: "req-http-0003", items: [{ productId: "p1", quantity: 1 }] } });
  assert.equal(order.status, 200);
  const status = await http("/api/admin/orders/status", { token: admin, body: { orderId: "cust1_req-http-0003", status: "processing" } });
  assert.equal(status.status, 200);
});

test("health reports configuration without exposing secrets", async () => {
  const response = await http("/health", { method: "GET" });
  assert.equal(response.status, 200);
  assert.equal(response.data.serviceAccountConfigured, true);
  assert.ok(!JSON.stringify(response.data).includes("PRIVATE KEY"));
});

test("unknown routes return 404", async () => {
  const response = await http("/api/balance", { method: "GET" });
  assert.equal(response.status, 404);
});

test.after(() => {
  globalThis.fetch = realFetch;
});
