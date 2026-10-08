const json = (data, status = 200, origin = "*") => new Response(JSON.stringify(data), {
  status,
  headers: {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": origin,
    "access-control-allow-headers": "Authorization, Content-Type",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "vary": "Origin"
  }
});

function allowedOrigin(request, env) {
  const origin = request.headers.get("Origin");
  if (env.FRONTEND_ORIGIN === "*") return "*";
  return origin === env.FRONTEND_ORIGIN ? origin : env.FRONTEND_ORIGIN;
}

async function gsubz(path, request, env, fields = {}) {
  const body = new URLSearchParams(fields);
  const response = await fetch(`https://api.gsubz.com${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.GSUBZ_API_KEY}` },
    body
  });
  return { status: response.status, data: await response.json() };
}

export default {
  async fetch(request, env) {
    const origin = allowedOrigin(request, env);
    if (request.method === "OPTIONS") return json({}, 204, origin);
    const url = new URL(request.url);

    if (url.pathname === "/health" && request.method === "GET") {
      return json({ status: "ok", service: "korasub-api" }, 200, origin);
    }

    if (url.pathname === "/api/plans" && request.method === "GET") {
      const service = url.searchParams.get("service");
      if (!service) return json({ message: "service is required" }, 400, origin);
      const response = await fetch(`https://api.gsubz.com/api/plans/?service=${encodeURIComponent(service)}`);
      return json(await response.json(), response.status, origin);
    }

    if (url.pathname === "/api/categories" && request.method === "GET") {
      const response = await fetch("https://api.gsubz.com/api/category/");
      return json(await response.json(), response.status, origin);
    }

    if (url.pathname === "/api/purchase" && request.method === "POST") {
      const order = await request.json().catch(() => null);
      if (!order?.serviceID || !order?.requestID) return json({ message: "serviceID and requestID are required" }, 400, origin);
      // Wallet debit, Firestore ledger write, idempotency and refund approval belong here before production use.
      // This endpoint is deliberately disabled until those checks are implemented.
      return json({ message: "Purchase workflow is not enabled yet" }, 501, origin);
    }

    return json({ message: "Not found" }, 404, origin);
  }
};
