# KORASUB

KORASUB is a VTU frontend for airtime, data, bills, exam pins, social services, eSIM and related digital services.

## Frontend pages

- `index.html` — public overview; loads active GSUBZ service groups and IDs without demo account figures.
- `dashboard.html` — the signed-in user's Firebase wallet balance, transactions and funding requests.
- `services.html` — GSUBZ's live service directory and live plans. Checkout stays unavailable until the secure purchase workflow is deployed.
- `transactions.html`, `fund-wallet.html`, and `support.html` — customer activity, funding requests and account help.
- `admin.html` — live profile, wallet-balance, pending-request and transaction summaries.
- `admin-funding.html`, `admin-ledger.html`, `admin-orders.html`, `admin-pricing.html`, and `admin-services.html` — the destinations linked from the admin quick controls.

The UI does not seed or display fabricated account statistics, balances, transaction rows or funding requests. Empty Firestore collections are shown as empty. Admin pages are read-only in the browser; wallet adjustments, funding approvals and refunds must be performed by trusted server-side code.

## Firebase and admin access

Firebase web configuration is public by design. Never put the GSUBZ API key or a service-account key in browser code.

Admin data access requires both the configured admin email in `firebase-config.js` and a Firebase custom claim `admin: true`. Grant the claim from a trusted machine with the Firebase Admin SDK:

```sh
export GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json
node scripts/firestore-setup.mjs set-admin beniwealth70@gmail.com
```

The admin must sign out and sign back in after the claim is set. Firestore rules—not the UI email check—protect admin reads. Customer profile and transaction data remains scoped to the signed-in user; wallet balances, transaction records, ledger entries and request approvals cannot be written from the browser.

The `seed-wallet` setup command updates only the selected profile's balance. It deliberately does not insert synthetic transaction history.

## Live data collections

- `users/{uid}` — profile and server-managed wallet balance.
- `users/{uid}/transactions/{transactionId}` — actual transaction activity written by a trusted server.
- `fundingRequests/{requestId}` — customer requests with amount, transfer reference, status and timestamp. Customers can submit pending requests; only a trusted backend may approve or reject them.
- `ledger/{entryId}` — immutable server-written financial audit entries.

Admin summaries are derived from these records. The platform does not currently have a separate orders/refunds store or browser-accessible admin mutation endpoint; the admin transaction page reads the existing transaction subcollections and clearly keeps review actions read-only until a secured backend is connected.

## GSUBZ API configuration

The Cloudflare Worker in `worker/index.js` is the only code that calls GSUBZ. The browser never receives the provider secret.

Configure the key locally (the real `.dev.vars` file is gitignored):

```sh
cp .dev.vars.example .dev.vars
# Edit .dev.vars locally and replace the placeholder with the key from your GSUBZ dashboard.
npm ci
npm run dev:worker
```

For the deployed Worker, set the secret through Wrangler—do not add it to `wrangler.toml`, `firebase-config.js`, HTML, Git, or chat:

```sh
npx wrangler secret put GSUBZ_API_KEY
npm run deploy:worker
```

`wrangler secret put` prompts for the value in your terminal. The key should remain in that prompt/local secret store. `GET /health` reports whether the Worker has a key without returning it.

### Worker endpoints

- `GET /api/categories` proxies GSUBZ's public `GET /api/category/` (List All Services) endpoint and returns its live nested service groups.
- `GET /api/plans?service=mtn_sme` fetches current plans directly from GSUBZ. This endpoint is public and does not use the secret. It returns the plan's `value`, list `price`, `api_price` and provider discount where available.
- The Worker checks both HTTP status and GSUBZ's response-body `status`; application-level failures are returned as errors even when GSUBZ responds with HTTP 200.
- `GET /api/esim/countries`, `/api/esim/packages`, `/api/games/list` and `/api/games/products` proxy the documented public catalog endpoints. They are available for future eSIM/game screens.
- `GET /api/balance` calls GSUBZ's authenticated wallet endpoint. The Worker sends `GSUBZ_API_KEY` as both the Bearer token and the required `api` form field. It only allows a verified Firebase ID token for the configured admin email with the `admin: true` custom claim.
- `POST /api/purchase` remains disabled. Do not enable provider purchases until KORASUB implements customer-wallet authorization/debit, request-ID idempotency, transaction verification and immutable ledger writes on the trusted server.

### Connect the frontend

By default, `API_BASE` in `firebase-config.js` is `/api`, which expects a same-origin rewrite/proxy from the frontend host to this Worker. If the Worker is hosted on its own `workers.dev` origin, set `API_BASE` to the Worker URL ending in `/api` (the URL printed by `wrangler deploy`). Also replace `FRONTEND_ORIGIN = "*"` in `wrangler.toml` with the exact deployed frontend origin before production deployment. The Worker enforces that origin for browser requests.

The Worker needs `FIREBASE_PROJECT_ID` and `ADMIN_EMAIL` in its non-secret vars; these are already present in `wrangler.toml`. It verifies Firebase ID token signatures against Google's public Firebase signing keys and fails closed if verification does not pass.

## Development

The pages are static HTML modules. Serve them through an HTTP server (not `file://`) so Firebase and ES modules load correctly. Configure the frontend host's `/api/*` rewrite to the Worker to use the live GSUBZ integration. Configure Firebase Auth, Firestore, rules and admin claims to load account and admin records. Catalog groups, service IDs and plans are fetched from the GSUBZ public catalog endpoints.
