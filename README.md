# KORASTORE

**Find it. Fund it. Own it.**

KORASTORE is an online store. The administrator lists and prices every product. Customers browse the catalogue, fund a wallet by bank transfer, and buy from that wallet. Orders are delivered to a location the customer sets (country, state, local government area, address).

## Roles

- **Administrator**: only `beniwealth70@gmail.com`, with a verified email and the `admin: true` custom claim. The admin lists, prices, stocks and hides products; publishes the deposit bank account; confirms funding; and moves orders through packing, shipping and delivery.
- **Customers**: anyone who registers. They browse, add to cart, fund their wallet, check out, set delivery location and track orders. They cannot list products or change balances.
- **Visitors**: can browse the shop without an account. Checkout and funding require sign-in.

## Money flow

1. **Fund** (`wallet.html`): the customer pays into the bank account the admin published (bank name, account name, account number), then submits the amount and transfer reference. The request is `pending`.
2. **Confirm** (`admin-funding.html`): the admin approves once the transfer lands. The Worker credits the wallet, writes a transaction and a ledger entry, and marks the request `approved`. It runs in a Firestore transaction, so approval happens once.
3. **Buy** (`cart.html` → `POST /api/orders`): the Worker re-prices the cart from the database, checks stock and the delivery location, debits the wallet, decrements stock, and creates the order. A `requestId` makes retries safe, so a lost response can't double-charge.
4. **Track and refund** (`admin-orders.html`, `orders.html`): paid → processing → shipped → delivered. Cancelling refunds the full total to the wallet and restocks the items.

No card or payment gateway is integrated. All deposits are manual bank transfers confirmed by the admin.

## Pages

- Storefront: `index.html` (home), `shop.html` (catalogue with search, categories and sorting), `product.html`, `cart.html`
- Accounts: `login.html`, `register.html`
- Customer: `dashboard.html` (overview), `wallet.html` (fund), `orders.html`, `profile.html` (delivery location)
- Admin: `admin.html` (overview), `admin-products.html`, `admin-funding.html`, `admin-orders.html`, `admin-settings.html` (bank details)

Shared client code is in `store.js`, styles in `store.css`. Nigerian states and LGAs are in `data/ng-locations.json` (from the MIT-licensed `nigeria-state-lga-data` package, 37 entries, 777 LGAs). Non-Nigerian addresses use free text for state and area.

## Data model (Firestore)

| Path | Written by | Read by |
|---|---|---|
| `users/{uid}` | customer (name, location); Worker (`balance`) | owner, admin |
| `users/{uid}/transactions/{id}` | Worker | owner, admin |
| `products/{id}` | admin | anyone (active only); admin (all) |
| `settings/payment` | admin | signed-in users |
| `fundingRequests/{id}` | customer (create); Worker (review) | owner, admin |
| `orders/{uid}_{requestId}` | Worker | owner, admin |
| `ledger/{id}` | Worker | admin |

Money is stored as whole naira (integers). The Worker is the only writer of balances, stock, orders, transactions and ledger entries.

## Worker API (`worker/index.js`)

The Cloudflare Worker is the trusted server. It holds the Google service-account credential and does every balance, stock and order change inside Firestore transactions. It verifies Firebase ID tokens (signature, project, expiry) on every mutating call.

- `GET /health`: configuration status. It returns no secrets.
- `POST /api/orders`: a signed-in customer buys from their wallet. Body: `{ requestId, items: [{ productId, quantity }] }`.
- `POST /api/admin/funding/review`: admin only. Body: `{ requestId, decision: "approve" | "reject" }`.
- `POST /api/admin/orders/status`: admin only. Body: `{ orderId, status: "processing" | "shipped" | "delivered" | "cancelled" }`.

## Setup and deployment

1. **Firebase console** (project `korasub-eb0b8`): enable Email/Password and Google sign-in, and create the Firestore database.
2. **Admin claim.** Create the admin's account by registering with `beniwealth70@gmail.com` and verifying the email. Then, on a trusted machine:
   ```sh
   export GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json
   node scripts/firestore-setup.mjs set-admin beniwealth70@gmail.com
   ```
   The admin signs out and back in afterwards.
3. **Firestore rules.** Deploy `firestore.rules` (for example with `npx firebase-tools deploy --only firestore:rules`).
4. **Service account.** Create a service account with the **Cloud Datastore User** role (`roles/datastore.user`) and save its JSON key locally. Never commit it.
5. **Worker secret and deploy.**
   ```sh
   npm ci
   npx wrangler secret put FIREBASE_SERVICE_ACCOUNT_JSON   # paste the full JSON key
   npm run deploy:worker
   ```
   For local development, copy `.dev.vars.example` to `.dev.vars` (gitignored) and paste the key on one line.
6. **Publish deposit details.** Sign in as the admin, open **Bank details**, and save the bank name, account name and 10-digit account number. Customers can't fund until these are published.
7. **Frontend.** Serve the static files (GitHub Pages or any static host). `API_BASE` in `firebase-config.js` must point to the deployed Worker's `/api` URL, and `FRONTEND_ORIGIN` in `wrangler.toml` must be the exact site origin.

## Tests

```sh
npm test
```

The Worker test suite signs real RS256 tokens and runs the purchase, funding, refund, idempotency and authorisation paths against an in-memory fake of the Firestore REST API. It does not contact Google or Firebase.

## Limitations

- Product images are links you paste in (https only). There is no upload.
- No delivery fees, tax, coupons, email notifications or payment-gateway integration.
- The admin can't edit a funding request after review, and a rejected request can't be reopened.
- Product stock is only decremented by the Worker. The admin's manual stock edits are not atomic with purchases.
