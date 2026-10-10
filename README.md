# KORASTORE

**Find it. Fund it. Own it.**

KORASTORE is an online store. The administrator lists and prices every product. Customers browse the catalogue, fund a wallet by bank transfer, and buy from that wallet. Orders are delivered to a location the customer sets (country, state, local government area, address).

There is no server. The site is static files plus Firebase (Auth and Firestore). Balances, stock and orders are changed by the browser inside Firestore transactions, and **`firestore.rules` is the only protection**. Read the rules before changing anything.

## Roles

- **Administrators**: `beniwealth70@gmail.com` and `okogbagideon28@gmail.com`, each with a verified email. Either admin lists, prices, stocks and hides products; uploads up to 5 photos per product; sets search keywords, slashed original prices, size/colour variants and the "Recommended" flag; publishes the deposit bank account; sets the checkout fee schedule; approves funding; and moves orders through packing, shipping and delivery.
- **Customers**: anyone who registers. They browse, add to cart, fund their wallet, check out, set delivery location and track orders. They cannot list products, change their own balance upward, or edit other people's data.
- **Visitors**: can browse the shop without an account. Checkout and funding require sign-in.

## Products

Every product has an **admin-chosen product ID** (3–40 letters, numbers, `-`, `_`) which is also its Firestore document id and its link: `product.html?id=<productId>`. Clicking a product opens its own page with:

- a photo gallery (up to **5 images**, uploaded by the admin and stored **compressed as base64 in Firestore** — no image host or URL needed),
- the **discounted price** with the **original price slashed through** (and the % off),
- quantity available (stock, shared across all variants),
- a **minimum order quantity** the admin sets per product (1 or more, with **no upper limit** — the ceiling for any purchase is the stock available),
- **size and colour options** for clothing products (set by the admin; shoppers must pick them before adding to cart),
- **search keywords** set by the admin, so search finds the product even by words not in its name,
- the product ID and the "Recommended" badge where applicable.

The **Recommended** section sits at the top of the shop. The admin flags a product as recommended when creating (or editing) it, and every shopper's browser raises a **notification** for it: live while the site is open, and a catch-up the next time they visit (Notification API, with an in-page toast fallback; shoppers opt in via the "Turn on alerts" button).

## Money flow

1. **Fund** (`wallet.html`): the customer pays into the bank account the admin published, then submits the amount and transfer reference. The request is `pending`.
2. **Approve** (`admin-funding.html`): the admin approves once the transfer lands. One transaction marks the request `approved`, credits the wallet, and writes a transaction and a ledger entry.
3. **Buy** (`cart.html` → `placeOrder` in `store.js`): one transaction re-reads each product's price, stock and variants, checks the delivery location, debits the wallet, decrements stock, and creates the order. The charged amount is **items + platform service fee + delivery fee**. The order ID is `<uid>_<requestId>`, so a retried checkout returns the original order instead of charging twice.
4. **Track and refund** (`admin-orders.html`, `orders.html`): paid → processing → shipped → delivered. Cancelling refunds the full total (items and fees) to the wallet and restocks the items, in one transaction.

No card or payment gateway is integrated. All deposits are manual bank transfers approved by the admin.

## Checkout fees

Added to every order on top of the items price, shown on the cart before paying:

| Fee | Default | Applies to |
|---|---|---|
| Platform service fee | ₦2,000 | every order |
| Delivery — local state | ₦2,500 | delivery inside the store's local state |
| Delivery — rest of Nigeria & abroad | ₦6,000 | every other delivery address |

The admin can change the amounts and which state counts as "local" under **Admin → Checkout fees** (`settings/fees`). These fees are added when the customer checks out and their wallet balance is debited — they are unrelated to the deposit bank details (which are only for funding the wallet). The security rules re-verify the fee amounts and the total on every order, with the same defaults built in, so an order cannot skip or fake the fees.

## What the rules enforce

- A customer's wallet can **go down only** in the same batch that creates their own order, and only by exactly the order total (items + service fee + delivery fee).
- A customer's wallet **never goes up**. Only the admin credits funding and refunds.
- Prices, stock and size/colour choices can only be used as they are in `/products` at checkout. The browser's totals are checked against them.
- The **service fee and delivery fee** on an order must equal the fee schedule (admin-edited `settings/fees`, defaults ₦2,000 / ₦2,500 / ₦6,000), and the total must be exactly items + those fees.
- Stock can **go down only** in the same batch that creates an order containing that product, and only by the ordered quantity.
- Orders are **create-only**. Customers can't edit or delete them.
- Product documents use the admin's product ID as their id, and only the admin can create/edit them (including photos, keywords, variants and the recommended flag).
- The admin accounts (email plus verified email) are the only accounts that approve funding, change order status, edit any user's balance, or post recommended-product announcements.

## Limitations of this design

- **The admin is trusted with balances.** The rules let the admin set any balance. Protect the admin Google/email account (use 2-step verification).
- **Stock decrease is not forced by the order rule.** The order rule doesn't require the matching product updates in the same batch. The normal app always does both, but a modified browser could create a paid order without reducing stock (overselling risk, not a way to get goods for free). Fixing this needs one more `getAfter()` per line, which may exceed Firestore's per-request rule lookup limit. Check it when you test the rules.
- **Carts are capped at 5 lines per order.** Firestore rules can't loop over a list, so each line is checked by index.
- **Rules are not tested in this repo.** Test them before going live (see Setup, step 3).
- **Delivery locations** are checked in the browser against `data/ng-locations.json`. The rules only check that they're strings. The delivery location itself is stored in Firestore (`users/{uid}`), not in browser storage.
- **Product photos are compressed client-side** (JPEG, max 5) and stored as base64 inside the product document — Firestore's 1 MB per-document limit is why the uploader compresses them. Very photo-heavy products (5 large photos) push that limit; the uploader blocks oversized sets.
- **Browser notifications** are best-effort: they fire live while the site is open and as a catch-up on the next visit. There is no push server, so a closed browser is notified only when the shopper returns.
- **No tax, coupons, email notifications or payment-gateway integration.**

## Pages

- Storefront: `index.html` (home), `shop.html` (catalogue with search, categories and sorting), `product.html`, `cart.html`
- Accounts: `login.html`, `register.html`
- Customer: `dashboard.html` (overview), `wallet.html` (fund), `orders.html`, `profile.html` (delivery location)
- Admin: `admin.html` (overview), `admin-products.html`, `admin-funding.html`, `admin-orders.html`, `admin-fees.html` (checkout fees), `admin-settings.html` (deposit bank details)

Shared client code is in `store.js`, styles in `store.css`. Nigerian states and LGAs are in `data/ng-locations.json` (from the MIT-licensed `nigeria-state-lga-data` package, 37 entries, 777 LGAs). Non-Nigerian addresses use free text for state and area.

## Data model (Firestore)

| Path | Written by | Read by |
|---|---|---|
| `users/{uid}` | customer (name, delivery location, one wallet decrease per order); admin (`balance`) | owner, admin |
| `users/{uid}/transactions/{id}` | customer (purchase record only); admin (funding, refund) | owner, admin |
| `products/{productId}` | admin (listing, prices, stock, photos, keywords, variants, recommended); customer (stock and `sold` on purchase only) | anyone (active only); admin (all) |
| `settings/payment` | admin | signed-in users |
| `settings/fees` | admin (checkout fee schedule) | signed-in users |
| `fundingRequests/{id}` | customer (create); admin (review) | owner, admin |
| `orders/{uid}_{requestId}` | customer (create once); admin (status) | owner, admin |
| `notifications/{id}` | admin (recommended-product announcements) | everyone |
| `ledger/{id}` | customer (purchase entries only); admin (all) | admin |

Money is stored as whole naira (integers). Product documents hold the admin-chosen `productId` as their id plus `name`, `category`, `price` (selling), `compareAtPrice` (slashed original, optional), `stock`, `sold`, `description`, `keywords[]`, `images[]` (base64), `sizes[]`, `colors[]`, `recommended`, `active`. Orders hold `items[]` (with optional `size`/`color` per line), `subtotal`, `serviceFee`, `deliveryFee`, `total` and the `delivery` snapshot.

## Setup and deployment

1. **Firebase console** (project `korasub-eb0b8`): enable Email/Password and Google sign-in, and create the Firestore database.
2. **Admin accounts.** Register `beniwealth70@gmail.com` and `okogbagideon28@gmail.com`, and verify each email. No custom claim is needed; the rules check the email and verification. To add or remove an admin later, edit the list in **both** `firestore.rules` (`isAdmin()`) and `firebase-config.js` (`ADMIN_EMAILS`), then redeploy the rules — the rules are the real gate, so editing only the JS just shows or hides the admin screens.
3. **Test the rules first.** In the Firebase console, open **Firestore → Rules → Rules Playground** and check at least:
   - a customer can create an order, and the wallet goes down by exactly the total (items + fees);
   - a customer **cannot** change their own `balance` without an order;
   - a customer **cannot** raise their own `balance`;
   - a customer cannot change product price, name or stock outside a matching order;
   - a customer cannot skip the platform service fee or the delivery fee on an order;
   - only the admin can approve funding, change order status, list products, or post notifications.
   Then run through a full purchase and refund on a test account.
4. **Deploy the rules.** Sign in with the Firebase CLI, then:
   ```sh
   npx firebase-tools login
   npm run deploy:rules
   ```
   Or paste `firestore.rules` into **Firestore → Rules → Publish** in the console.
5. **Publish deposit details.** Sign in as the admin, open **Bank details**, and save the bank name, account name and 10-digit account number. These are for wallet **deposits only** — customers transfer in, the admin approves, and orders then debit the wallet balance. Customers can't fund until these are published. Review **Checkout fees** at the same time.
6. **Frontend.** Serve the static files (GitHub Pages or any static host). The site has no backend to configure.

## Tests

There is no automated test suite in this repo. Use the Rules Playground and a manual purchase/refund run (step 3 above).

Note: Firestore rules that call `getAfter()` and `get()` need to be tested against the live project or the Firestore emulator before go-live.
