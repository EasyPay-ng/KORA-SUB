// KORASTORE trusted API (Cloudflare Worker).
//
// Everything that moves money or changes stock runs here, inside Firestore
// read-write transactions, using a Google service account. Browsers never receive
// the service-account key. Every mutating route verifies the caller's Firebase ID
// token (signature, project, expiry) before doing anything.
//
//   POST /api/orders                  signed-in customer: buy from wallet (atomic debit + stock)
//   POST /api/admin/funding/review    admin only: approve or reject a funding request
//   POST /api/admin/orders/status     admin only: move an order forward, or cancel and refund
//   GET  /health                      non-secret configuration status

import NG_LOCATIONS from "../data/ng-locations.json" with { type: "json" };

const FIREBASE_JWKS_URL = "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const FIRESTORE_SCOPE = "https://www.googleapis.com/auth/datastore";
const MAX_BODY_BYTES = 8192;
const MAX_ITEMS = 20;
const MAX_QTY = 50;
const ID_PATTERN = /^[A-Za-z0-9_-]+$/;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

let jwksCache = null;
let jwksCacheExpiry = 0;
let jwksCacheFetchedAt = 0;
let accessTokenCache = null;
let accessTokenExpiry = 0;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

class FirestoreError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
    this.retryable = status === 429 || status === 503 || (status === 409 && code === "ABORTED");
  }
}

// ---------- HTTP helpers ----------

const json = (data, status = 200, origin = "*") => new Response(JSON.stringify(data), {
  status,
  headers: {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "access-control-allow-origin": origin,
    "access-control-allow-headers": "Authorization, Content-Type",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    vary: "Origin"
  }
});

function allowedOrigin(request, env) {
  const requestOrigin = request.headers.get("Origin");
  const configuredOrigin = env.FRONTEND_ORIGIN || "*";
  if (configuredOrigin === "*") return "*";
  return requestOrigin === configuredOrigin ? requestOrigin : configuredOrigin;
}

async function readJson(request) {
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) throw new HttpError(413, "The request is too large.");
  try {
    const parsed = JSON.parse(text || "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    return parsed;
  } catch {
    throw new HttpError(400, "The request body must be a JSON object.");
  }
}

function cleanId(value, label, min = 1, max = 128) {
  const text = typeof value === "string" ? value.trim() : "";
  if (text.length < min || text.length > max || !ID_PATTERN.test(text)) {
    throw new HttpError(400, `${label} is invalid.`);
  }
  return text;
}

function naira(amount) {
  return `₦${Number(amount || 0).toLocaleString("en-NG")}`;
}

// ---------- Firebase ID token verification ----------

function decodeBase64Url(value) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function decodeJsonPart(value) {
  return JSON.parse(decoder.decode(decodeBase64Url(value)));
}

async function getFirebaseJwks(forceRefresh = false) {
  if (!forceRefresh && jwksCache && Date.now() < jwksCacheExpiry) return jwksCache;
  const response = await fetch(FIREBASE_JWKS_URL, { headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error("Firebase signing keys could not be loaded.");
  const keys = await response.json();
  if (!Array.isArray(keys.keys) || !keys.keys.length) throw new Error("Firebase signing keys were empty.");
  const maxAge = Number((response.headers.get("cache-control") || "").match(/max-age=(\d+)/i)?.[1] || 3600);
  jwksCache = keys;
  jwksCacheFetchedAt = Date.now();
  jwksCacheExpiry = jwksCacheFetchedAt + Math.max(60, maxAge) * 1000;
  return keys;
}

async function verifyIdToken(token, projectId) {
  if (token.length > 12000) throw new Error("Token too long.");
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("Malformed token.");
  const header = decodeJsonPart(parts[0]);
  const claims = decodeJsonPart(parts[1]);
  if (header.alg !== "RS256" || !header.kid) throw new Error("Unsupported token signature.");

  let keys = await getFirebaseJwks();
  let jwk = keys.keys.find((key) => key.kid === header.kid && key.use === "sig");
  // Allow key rotation without letting random kid values force a Google fetch per request.
  if (!jwk && Date.now() - jwksCacheFetchedAt > 60_000) {
    keys = await getFirebaseJwks(true);
    jwk = keys.keys.find((key) => key.kid === header.kid && key.use === "sig");
  }
  if (!jwk) throw new Error("Token signing key is unknown.");

  const publicKey = await crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"]
  );
  const valid = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    publicKey,
    decodeBase64Url(parts[2]),
    encoder.encode(`${parts[0]}.${parts[1]}`)
  );
  if (!valid) throw new Error("Token signature is invalid.");

  const now = Math.floor(Date.now() / 1000);
  if (claims.iss !== `https://securetoken.google.com/${projectId}` || claims.aud !== projectId) {
    throw new Error("Token belongs to a different Firebase project.");
  }
  if (!claims.sub || !Number.isFinite(claims.exp) || claims.exp <= now || !Number.isFinite(claims.iat) || claims.iat > now + 60) {
    throw new Error("Token is expired or has invalid timestamps.");
  }
  return claims;
}

async function verifyUser(request, env) {
  const authorization = request.headers.get("Authorization") || "";
  const token = authorization.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!token) throw new HttpError(401, "Sign in to continue.");
  if (!env.FIREBASE_PROJECT_ID) throw new HttpError(503, "Firebase is not configured on the Worker.");
  let claims;
  try {
    claims = await verifyIdToken(token, env.FIREBASE_PROJECT_ID);
  } catch {
    throw new HttpError(401, "Your sign-in could not be verified. Sign in again.");
  }
  const email = String(claims.email || "").toLowerCase();
  const adminEmail = String(env.ADMIN_EMAIL || "").toLowerCase();
  const isAdmin = Boolean(adminEmail) && email === adminEmail && claims.email_verified === true && claims.admin === true;
  return { uid: claims.sub, email, isAdmin };
}

async function requireAdmin(request, env) {
  const user = await verifyUser(request, env);
  if (!user.isAdmin) throw new HttpError(403, "Admin access is required for this action.");
  return user;
}

// ---------- Google service-account access to Firestore ----------

function base64UrlBytes(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlString(text) {
  return base64UrlBytes(encoder.encode(text));
}

function pemToDer(pem) {
  const body = pem.replace(/-----BEGIN [^-]+-----/, "").replace(/-----END [^-]+-----/, "").replace(/\s+/g, "");
  return decodeBase64Url(body.replace(/\+/g, "-").replace(/\//g, "_"));
}

function serviceAccount(env) {
  if (!env.FIREBASE_SERVICE_ACCOUNT_JSON) throw new HttpError(503, "FIREBASE_SERVICE_ACCOUNT_JSON is not configured on the Worker.");
  let account;
  try {
    account = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT_JSON);
  } catch {
    throw new HttpError(503, "FIREBASE_SERVICE_ACCOUNT_JSON is not valid JSON.");
  }
  if (!account.client_email || !account.private_key) throw new HttpError(503, "The service account secret is incomplete.");
  return account;
}

async function googleAccessToken(env) {
  if (accessTokenCache && Date.now() < accessTokenExpiry - 60_000) return accessTokenCache;
  const account = serviceAccount(env);
  const now = Math.floor(Date.now() / 1000);
  const header = base64UrlString(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = base64UrlString(JSON.stringify({
    iss: account.client_email,
    scope: FIRESTORE_SCOPE,
    aud: GOOGLE_TOKEN_URL,
    iat: now,
    exp: now + 3600
  }));
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToDer(account.private_key),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, encoder.encode(`${header}.${claims}`));
  const assertion = `${header}.${claims}.${base64UrlBytes(new Uint8Array(signature))}`;
  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }),
    signal: AbortSignal.timeout(15000)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.access_token) throw new HttpError(503, "Could not authorise with Google Cloud.");
  accessTokenCache = data.access_token;
  accessTokenExpiry = Date.now() + Number(data.expires_in || 3600) * 1000;
  return accessTokenCache;
}

// ---------- Firestore REST encoding ----------

function encodeValue(value) {
  if (value === null || value === undefined) return { nullValue: null };
  if (typeof value === "string") return { stringValue: value };
  if (typeof value === "boolean") return { booleanValue: value };
  if (typeof value === "number") {
    return Number.isInteger(value) ? { integerValue: String(value) } : { doubleValue: value };
  }
  if (Array.isArray(value)) return { arrayValue: { values: value.map(encodeValue) } };
  if (typeof value === "object") return { mapValue: { fields: encodeFields(value) } };
  throw new Error("Unsupported Firestore value.");
}

function encodeFields(object) {
  return Object.fromEntries(Object.entries(object).map(([key, value]) => [key, encodeValue(value)]));
}

function decodeValue(value) {
  if (!value || typeof value !== "object") return null;
  if ("stringValue" in value) return value.stringValue;
  if ("integerValue" in value) return Number(value.integerValue);
  if ("doubleValue" in value) return Number(value.doubleValue);
  if ("booleanValue" in value) return value.booleanValue;
  if ("timestampValue" in value) return value.timestampValue;
  if ("nullValue" in value) return null;
  if ("mapValue" in value) return decodeFields(value.mapValue.fields);
  if ("arrayValue" in value) return (value.arrayValue.values || []).map(decodeValue);
  return null;
}

function decodeFields(fields = {}) {
  return Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, decodeValue(value)]));
}

// ---------- Firestore transactions ----------

function documentsBase(env) {
  return `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(env.FIREBASE_PROJECT_ID)}/databases/(default)/documents`;
}

async function firestoreCall(env, suffix, method, body, query = "") {
  const token = await googleAccessToken(env);
  const response = await fetch(`${documentsBase(env)}${suffix}${query ? `?${query}` : ""}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json"
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15000)
  });
  const text = await response.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = {};
  }
  if (!response.ok) {
    throw new FirestoreError(response.status, data?.error?.status, data?.error?.message || "Firestore request failed.");
  }
  return data;
}

class Transaction {
  constructor(env, id) {
    this.env = env;
    this.id = id;
    this.writes = [];
  }

  resourceName(path) {
    return `projects/${this.env.FIREBASE_PROJECT_ID}/databases/(default)/documents/${path}`;
  }

  // Returns the decoded document or null when it does not exist.
  async get(path) {
    try {
      const doc = await firestoreCall(this.env, `/${path}`, "GET", undefined, `transaction=${encodeURIComponent(this.id)}`);
      return decodeFields(doc.fields);
    } catch (error) {
      if (error instanceof FirestoreError && error.status === 404) return null;
      throw error;
    }
  }

  create(path, fields) {
    this.writes.push({
      update: { name: this.resourceName(path), fields: encodeFields(fields) },
      currentDocument: { exists: false }
    });
  }

  patch(path, fields) {
    this.writes.push({
      update: { name: this.resourceName(path), fields: encodeFields(fields) },
      updateMask: { fieldPaths: Object.keys(fields) },
      currentDocument: { exists: true }
    });
  }
}

async function runTransaction(env, work) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const { transaction } = await firestoreCall(env, ":beginTransaction", "POST", { options: { readWrite: {} } });
      const tx = new Transaction(env, transaction);
      const result = await work(tx);
      if (tx.writes.length) {
        await firestoreCall(env, ":commit", "POST", { transaction, writes: tx.writes });
      }
      return result;
    } catch (error) {
      if (error instanceof FirestoreError && error.retryable && attempt < 4) {
        await new Promise((resolve) => setTimeout(resolve, 60 * (attempt + 1) + Math.random() * 120));
        continue;
      }
      if (error instanceof FirestoreError) throw new HttpError(502, "The store database is unavailable. Please try again.");
      throw error;
    }
  }
  throw new HttpError(409, "The store is busy right now. Please try again.");
}

// ---------- Business rules ----------

function normaliseItems(items) {
  if (!Array.isArray(items) || items.length < 1 || items.length > MAX_ITEMS) {
    throw new HttpError(400, `Add between 1 and ${MAX_ITEMS} products to the order.`);
  }
  const merged = new Map();
  for (const item of items) {
    const productId = cleanId(item?.productId, "Product");
    const quantity = Number(item?.quantity);
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_QTY) {
      throw new HttpError(400, `Quantity must be a whole number from 1 to ${MAX_QTY}.`);
    }
    merged.set(productId, (merged.get(productId) || 0) + quantity);
  }
  return [...merged].map(([productId, quantity]) => ({ productId, quantity: Math.min(quantity, MAX_QTY) }));
}

function validateDelivery(profile) {
  const country = String(profile.country || "").trim();
  const state = String(profile.state || "").trim();
  const lga = String(profile.lga || "").trim();
  const address = String(profile.address || "").trim();
  if (!country || !state || !address) {
    throw new HttpError(409, "Add your delivery location (country, state, address) in your profile before buying.");
  }
  if (country === "Nigeria") {
    const entry = NG_LOCATIONS.find((item) => item.state === state);
    if (!entry) throw new HttpError(409, "Choose a valid Nigerian state in your profile.");
    if (!entry.lgas.includes(lga)) throw new HttpError(409, "Choose your local government area in your profile.");
  }
  return { country, state, lga, address };
}

async function placeOrder(env, user, body) {
  const requestId = cleanId(body.requestId, "Request ID", 8, 80);
  const requested = normaliseItems(body.items);
  const orderId = `${user.uid}_${requestId}`;
  const now = new Date().toISOString();

  return runTransaction(env, async (tx) => {
    // Idempotency: a retried checkout with the same requestId returns the original order.
    const existing = await tx.get(`orders/${orderId}`);
    if (existing) return { orderId, status: existing.status, total: existing.total, duplicate: true };

    const profile = await tx.get(`users/${user.uid}`);
    if (!profile) throw new HttpError(409, "Your profile is not ready yet. Sign out and back in.");
    const delivery = validateDelivery(profile);

    const lines = [];
    const stockChanges = [];
    let total = 0;
    for (const item of requested) {
      const product = await tx.get(`products/${item.productId}`);
      if (!product || product.active !== true) {
        throw new HttpError(409, "An item in your order is no longer available. Review your cart.");
      }
      const price = Number(product.price);
      const stock = Number(product.stock || 0);
      if (!Number.isInteger(price) || price <= 0) throw new HttpError(409, `${product.name} has no valid price.`);
      if (stock < item.quantity) {
        throw new HttpError(409, stock > 0 ? `Only ${stock} left of ${product.name}.` : `${product.name} is out of stock.`);
      }
      const lineTotal = price * item.quantity;
      total += lineTotal;
      lines.push({ productId: item.productId, name: String(product.name || "Product"), price, quantity: item.quantity, lineTotal });
      stockChanges.push({ id: item.productId, stock, sold: Number(product.sold || 0), quantity: item.quantity });
    }

    const balance = Number(profile.balance || 0);
    if (balance < total) {
      throw new HttpError(402, `Your wallet has ${naira(balance)} but this order costs ${naira(total)}. Fund your wallet first.`);
    }
    const newBalance = balance - total;

    tx.patch(`users/${user.uid}`, { balance: newBalance, updatedAt: now });
    for (const change of stockChanges) {
      tx.patch(`products/${change.id}`, {
        stock: change.stock - change.quantity,
        sold: change.sold + change.quantity,
        updatedAt: now
      });
    }
    tx.create(`orders/${orderId}`, {
      uid: user.uid,
      requestId,
      items: lines,
      total,
      status: "paid",
      delivery,
      createdAt: now,
      updatedAt: now
    });
    tx.create(`users/${user.uid}/transactions/purchase_${orderId}`, {
      type: "purchase",
      title: `Order ${orderId.slice(-6).toUpperCase()}`,
      amount: -total,
      status: "paid",
      orderId,
      balanceAfter: newBalance,
      createdAt: now
    });
    tx.create(`ledger/purchase_${orderId}`, {
      type: "purchase",
      uid: user.uid,
      amount: -total,
      balanceAfter: newBalance,
      reference: orderId,
      actor: user.uid,
      createdAt: now
    });
    return { orderId, status: "paid", total, balance: newBalance, duplicate: false };
  });
}

async function reviewFunding(env, admin, body) {
  const requestId = cleanId(body.requestId, "Request ID");
  const decision = body.decision;
  if (decision !== "approve" && decision !== "reject") throw new HttpError(400, "Decision must be approve or reject.");
  const now = new Date().toISOString();

  return runTransaction(env, async (tx) => {
    const request = await tx.get(`fundingRequests/${requestId}`);
    if (!request) throw new HttpError(404, "Funding request not found.");
    if (request.status !== "pending") throw new HttpError(409, `This request has already been ${request.status}.`);

    if (decision === "reject") {
      tx.patch(`fundingRequests/${requestId}`, { status: "rejected", reviewedAt: now, reviewedBy: admin.email });
      return { requestId, status: "rejected" };
    }

    const amount = Number(request.amount);
    if (!Number.isInteger(amount) || amount <= 0) throw new HttpError(409, "The request amount is invalid.");
    const profile = await tx.get(`users/${request.uid}`);
    if (!profile) throw new HttpError(409, "The customer profile for this request does not exist.");
    const newBalance = Number(profile.balance || 0) + amount;

    tx.patch(`users/${request.uid}`, { balance: newBalance, updatedAt: now });
    tx.patch(`fundingRequests/${requestId}`, { status: "approved", reviewedAt: now, reviewedBy: admin.email });
    tx.create(`users/${request.uid}/transactions/funding_${requestId}`, {
      type: "funding",
      title: `Wallet funded · ${String(request.reference || "bank transfer").slice(0, 60)}`,
      amount,
      status: "approved",
      requestId,
      balanceAfter: newBalance,
      createdAt: now
    });
    tx.create(`ledger/funding_${requestId}`, {
      type: "funding",
      uid: request.uid,
      amount,
      balanceAfter: newBalance,
      reference: requestId,
      actor: admin.email,
      createdAt: now
    });
    return { requestId, status: "approved", balance: newBalance };
  });
}

const ORDER_TRANSITIONS = {
  paid: ["processing", "cancelled"],
  processing: ["shipped", "cancelled"],
  shipped: ["delivered"],
  delivered: [],
  cancelled: []
};

async function updateOrderStatus(env, admin, body) {
  const orderId = cleanId(body.orderId, "Order ID", 1, 200);
  const status = body.status;
  if (!["processing", "shipped", "delivered", "cancelled"].includes(status)) {
    throw new HttpError(400, "Status must be processing, shipped, delivered or cancelled.");
  }
  const now = new Date().toISOString();

  return runTransaction(env, async (tx) => {
    const order = await tx.get(`orders/${orderId}`);
    if (!order) throw new HttpError(404, "Order not found.");
    if (!ORDER_TRANSITIONS[order.status]?.includes(status)) {
      throw new HttpError(409, `An order that is ${order.status} cannot be changed to ${status}.`);
    }

    if (status !== "cancelled") {
      tx.patch(`orders/${orderId}`, { status, updatedAt: now });
      return { orderId, status };
    }

    // Cancellation refunds the full order total to the wallet and restocks every line.
    const refund = Number(order.total || 0);
    const profile = await tx.get(`users/${order.uid}`);
    if (!profile) throw new HttpError(409, "The customer profile for this order does not exist.");
    const newBalance = Number(profile.balance || 0) + refund;

    const restock = [];
    for (const item of order.items || []) {
      const product = await tx.get(`products/${item.productId}`);
      if (product) restock.push({ id: item.productId, product, quantity: Number(item.quantity || 0) });
    }

    tx.patch(`users/${order.uid}`, { balance: newBalance, updatedAt: now });
    tx.patch(`orders/${orderId}`, { status: "cancelled", cancelledAt: now, updatedAt: now });
    for (const change of restock) {
      tx.patch(`products/${change.id}`, {
        stock: Number(change.product.stock || 0) + change.quantity,
        sold: Math.max(0, Number(change.product.sold || 0) - change.quantity),
        updatedAt: now
      });
    }
    tx.create(`users/${order.uid}/transactions/refund_${orderId}`, {
      type: "refund",
      title: `Refund · Order ${orderId.slice(-6).toUpperCase()}`,
      amount: refund,
      status: "refunded",
      orderId,
      balanceAfter: newBalance,
      createdAt: now
    });
    tx.create(`ledger/refund_${orderId}`, {
      type: "refund",
      uid: order.uid,
      amount: refund,
      balanceAfter: newBalance,
      reference: orderId,
      actor: admin.email,
      createdAt: now
    });
    return { orderId, status: "cancelled", refunded: refund, balance: newBalance };
  });
}

// ---------- Router ----------

export default {
  async fetch(request, env) {
    const requestOrigin = request.headers.get("Origin");
    const origin = allowedOrigin(request, env);

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "access-control-allow-origin": origin,
          "access-control-allow-headers": "Authorization, Content-Type",
          "access-control-allow-methods": "GET, POST, OPTIONS",
          "access-control-max-age": "86400",
          vary: "Origin"
        }
      });
    }
    if (requestOrigin && env.FRONTEND_ORIGIN && env.FRONTEND_ORIGIN !== "*" && requestOrigin !== env.FRONTEND_ORIGIN) {
      return json({ message: "Origin is not allowed." }, 403, origin);
    }

    const url = new URL(request.url);
    try {
      if (url.pathname === "/health" && request.method === "GET") {
        return json({
          status: "ok",
          service: "korastore-api",
          firebaseProjectConfigured: Boolean(env.FIREBASE_PROJECT_ID),
          serviceAccountConfigured: Boolean(env.FIREBASE_SERVICE_ACCOUNT_JSON),
          adminEmailConfigured: Boolean(env.ADMIN_EMAIL)
        }, 200, origin);
      }

      if (url.pathname === "/api/orders" && request.method === "POST") {
        const user = await verifyUser(request, env);
        const body = await readJson(request);
        return json(await placeOrder(env, user, body), 200, origin);
      }

      if (url.pathname === "/api/admin/funding/review" && request.method === "POST") {
        const admin = await requireAdmin(request, env);
        const body = await readJson(request);
        return json(await reviewFunding(env, admin, body), 200, origin);
      }

      if (url.pathname === "/api/admin/orders/status" && request.method === "POST") {
        const admin = await requireAdmin(request, env);
        const body = await readJson(request);
        return json(await updateOrderStatus(env, admin, body), 200, origin);
      }

      return json({ message: "Not found" }, 404, origin);
    } catch (error) {
      if (error instanceof HttpError) return json({ message: error.message }, error.status, origin);
      console.error("Unhandled API error", error?.message);
      return json({ message: "Something went wrong on the server. Please try again." }, 500, origin);
    }
  }
};

// Exported for the test suite only.
export const __test = { placeOrder, reviewFunding, updateOrderStatus, validateDelivery, normaliseItems };
