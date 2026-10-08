const GSUBZ_BASE = "https://api.gsubz.com";
const FIREBASE_JWKS_URL = "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com";
const encoder = new TextEncoder();
let jwksCache = null;
let jwksCacheExpiry = 0;
let jwksCacheFetchedAt = 0;

const json = (data, status = 200, origin = "*") => new Response(JSON.stringify(data), {
  status,
  headers: {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "access-control-allow-origin": origin,
    "access-control-allow-headers": "Authorization, Content-Type",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "vary": "Origin"
  }
});

function allowedOrigin(request, env) {
  const requestOrigin = request.headers.get("Origin");
  const configuredOrigin = env.FRONTEND_ORIGIN || "*";
  if (configuredOrigin === "*") return "*";
  return requestOrigin === configuredOrigin ? requestOrigin : configuredOrigin;
}

function decodeBase64Url(value) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - normalized.length % 4) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function decodeJsonPart(value) {
  return JSON.parse(new TextDecoder().decode(decodeBase64Url(value)));
}

async function getFirebaseJwks(forceRefresh = false) {
  if (!forceRefresh && jwksCache && Date.now() < jwksCacheExpiry) return jwksCache;
  const response = await fetch(FIREBASE_JWKS_URL, { headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error("Firebase signing keys could not be loaded.");
  const keys = await response.json();
  if (!Array.isArray(keys.keys) || !keys.keys.length) throw new Error("Firebase signing keys were empty.");
  const cacheControl = response.headers.get("cache-control") || "";
  const maxAge = Number(cacheControl.match(/max-age=(\d+)/i)?.[1] || 3600);
  jwksCache = keys;
  jwksCacheFetchedAt = Date.now();
  jwksCacheExpiry = jwksCacheFetchedAt + Math.max(60, maxAge) * 1000;
  return keys;
}

async function verifyFirebaseAdmin(request, env) {
  const authorization = request.headers.get("Authorization") || "";
  const token = authorization.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!token) return { ok: false, status: 401, message: "A Firebase sign-in token is required." };
  if (token.length > 12_000) return { ok: false, status: 401, message: "Firebase sign-in token is invalid." };
  if (!env.FIREBASE_PROJECT_ID || !env.ADMIN_EMAIL) {
    return { ok: false, status: 503, message: "Firebase admin verification is not configured." };
  }

  try {
    const parts = token.split(".");
    if (parts.length !== 3) throw new Error("Malformed token.");
    const header = decodeJsonPart(parts[0]);
    const claims = decodeJsonPart(parts[1]);
    if (header.alg !== "RS256" || !header.kid) throw new Error("Unsupported token signature.");

    let keys = await getFirebaseJwks();
    let jwk = keys.keys.find((key) => key.kid === header.kid && key.use === "sig");
    // Allow key rotation without letting random `kid` values force a Google fetch per request.
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
    const validSignature = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      publicKey,
      decodeBase64Url(parts[2]),
      encoder.encode(`${parts[0]}.${parts[1]}`)
    );
    if (!validSignature) throw new Error("Token signature is invalid.");

    const now = Math.floor(Date.now() / 1000);
    const projectId = env.FIREBASE_PROJECT_ID;
    if (claims.iss !== `https://securetoken.google.com/${projectId}` || claims.aud !== projectId) {
      throw new Error("Token belongs to a different Firebase project.");
    }
    if (!claims.sub || !Number.isFinite(claims.exp) || claims.exp <= now || !Number.isFinite(claims.iat) || claims.iat > now + 60) {
      throw new Error("Token is expired or has invalid timestamps.");
    }
    if (claims.email_verified !== true || String(claims.email || "").toLowerCase() !== env.ADMIN_EMAIL.toLowerCase() || claims.admin !== true) {
      return { ok: false, status: 403, message: "Admin access is required for this provider account." };
    }
    return { ok: true, claims };
  } catch {
    return { ok: false, status: 401, message: "Firebase sign-in could not be verified." };
  }
}

function providerStatusSucceeded(data) {
  if (!data || typeof data !== "object" || data.status === undefined || data.status === null || data.status === "") return true;
  if (data.status === true || data.status === 1) return true;
  if (data.status === false || data.status === 0) return false;
  return ["success", "successful", "ok", "true", "1", "200", "00"].includes(String(data.status).trim().toLowerCase());
}

function providerErrorMessage(data) {
  return data?.api_response || data?.message || data?.error || "GSUBZ reported that the request was unsuccessful.";
}

async function providerJson(url, origin) {
  try {
    const response = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(15000)
    });
    const text = await response.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      return json({ message: "The GSUBZ API returned a non-JSON response." }, 502, origin);
    }
    // GSUBZ can return HTTP 200 for application-level failures; check its body status too.
    if (!response.ok || !providerStatusSucceeded(data)) {
      return json({ message: providerErrorMessage(data) }, response.ok ? 502 : response.status, origin);
    }
    return json(data, response.status, origin);
  } catch {
    return json({ message: "The GSUBZ API could not be reached." }, 502, origin);
  }
}

async function providerBalance(env, origin) {
  if (!env.GSUBZ_API_KEY) {
    return json({ message: "GSUBZ_API_KEY is not configured on the Worker." }, 503, origin);
  }
  try {
    const body = new URLSearchParams({ api: env.GSUBZ_API_KEY });
    const response = await fetch(`${GSUBZ_BASE}/api/balance/`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.GSUBZ_API_KEY}`,
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json"
      },
      body,
      signal: AbortSignal.timeout(15000)
    });
    const text = await response.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      return json({ message: "The GSUBZ balance endpoint returned a non-JSON response." }, 502, origin);
    }
    if (!response.ok || !providerStatusSucceeded(data)) {
      return json({ message: providerErrorMessage(data) }, 502, origin);
    }
    if (data.balance === undefined || data.balance === null || !Number.isFinite(Number(data.balance))) {
      return json({ message: data.api_response || data.message || "GSUBZ did not return a wallet balance." }, 502, origin);
    }
    return json({ balance: Number(data.balance), currency: "NGN", checkedAt: new Date().toISOString() }, 200, origin);
  } catch {
    return json({ message: "The GSUBZ balance endpoint could not be reached." }, 502, origin);
  }
}

function copyAllowedQuery(url, params) {
  const query = new URLSearchParams();
  for (const key of params) {
    const value = url.searchParams.get(key);
    if (value) query.set(key, value);
  }
  const suffix = query.toString();
  return suffix ? `?${suffix}` : "";
}

export default {
  async fetch(request, env) {
    const requestOrigin = request.headers.get("Origin");
    const origin = allowedOrigin(request, env);
    if (request.method === "OPTIONS") return new Response(null, {
      status: 204,
      headers: {
        "access-control-allow-origin": origin,
        "access-control-allow-headers": "Authorization, Content-Type",
        "access-control-allow-methods": "GET, POST, OPTIONS",
        "access-control-max-age": "86400",
        "vary": "Origin"
      }
    });
    if (requestOrigin && env.FRONTEND_ORIGIN && env.FRONTEND_ORIGIN !== "*" && requestOrigin !== env.FRONTEND_ORIGIN) {
      return json({ message: "Origin is not allowed." }, 403, origin);
    }

    const url = new URL(request.url);
    if (url.pathname === "/health" && request.method === "GET") {
      return json({
        status: "ok",
        service: "korasub-api",
        gsubzKeyConfigured: Boolean(env.GSUBZ_API_KEY),
        firebaseAdminVerificationConfigured: Boolean(env.FIREBASE_PROJECT_ID && env.ADMIN_EMAIL)
      }, 200, origin);
    }

    // Public GSUBZ catalogue endpoints: no provider key is required by GSUBZ.
    if (url.pathname === "/api/categories" && request.method === "GET") {
      return providerJson(`${GSUBZ_BASE}/api/category/`, origin);
    }
    if (url.pathname === "/api/plans" && request.method === "GET") {
      const service = url.searchParams.get("service");
      if (!service) return json({ message: "service is required" }, 400, origin);
      if (service.length > 80) return json({ message: "service is too long" }, 400, origin);
      return providerJson(`${GSUBZ_BASE}/api/plans/?service=${encodeURIComponent(service)}`, origin);
    }
    if (url.pathname === "/api/esim/countries" && request.method === "GET") {
      return providerJson(`${GSUBZ_BASE}/api/esim/countries/${copyAllowedQuery(url, ["q"])}`, origin);
    }
    if (url.pathname === "/api/esim/packages" && request.method === "GET") {
      const locationCode = url.searchParams.get("locationCode");
      if (!locationCode) return json({ message: "locationCode is required" }, 400, origin);
      if (locationCode.length > 200) return json({ message: "locationCode is too long" }, 400, origin);
      return providerJson(`${GSUBZ_BASE}/api/esim/packages/${copyAllowedQuery(url, ["locationCode"])}`, origin);
    }
    if (url.pathname === "/api/games/list" && request.method === "GET") {
      return providerJson(`${GSUBZ_BASE}/api/games/list/${copyAllowedQuery(url, ["q"])}`, origin);
    }
    if (url.pathname === "/api/games/products" && request.method === "GET") {
      const gameID = url.searchParams.get("gameID");
      if (!gameID) return json({ message: "gameID is required" }, 400, origin);
      return providerJson(`${GSUBZ_BASE}/api/games/products/${copyAllowedQuery(url, ["gameID"])}`, origin);
    }

    if (url.pathname === "/api/balance" && request.method === "GET") {
      const access = await verifyFirebaseAdmin(request, env);
      if (!access.ok) return json({ message: access.message }, access.status, origin);
      return providerBalance(env, origin);
    }

    if (url.pathname === "/api/purchase" && request.method === "POST") {
      // Purchases remain disabled until KORASUB's customer-wallet debit, idempotency,
      // transaction verification and ledger writes are implemented server-side.
      return json({ message: "Purchase workflow is not enabled yet." }, 501, origin);
    }

    return json({ message: "Not found" }, 404, origin);
  }
};
