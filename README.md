# KORASTORE

**Find it. Fund it. Own it.**

KORASTORE is an online store. The administrator lists and prices every product. Customers browse the catalogue, fund a wallet by bank transfer, and buy from that wallet. Orders are delivered to a location the customer sets (country, state, local government area, address).

There is no server. The site is static files plus Firebase (Auth and Firestore). Balances, stock and orders are changed by the browser inside Firestore transactions, and **`firestore.rules` is the only protection**. Read the rules before changing anything.

## Roles

- **Administrators**: `beniwealth70@gmail.com` and `okogbagideon28@gmail.com`, each with a verified email. Either admin can list, price, stock and hide products; upload up to 5 photos per product; set search keywords, slashed original prices, clothing variations with their own prices and the "Recommended" flag; publish the deposit bank account; set the checkout fee schedule; approve funding; and move orders through packing, shipping and delivery. They also run the **social media boosting** catalogue: categories (e.g. Twitter Views) and plans with prices, min/max quantities and average delivery times. They can search the product list by Product ID (typing an exact ID and pressing Enter jumps straight to editing it).
- **Customers**: anyone who registers. They browse, add to cart, fund their wallet, check out, set delivery location and track orders. They cannot list products, change their own balance upward, or edit other people's data.
- **Visitors**: can browse the shop without an account. Checkout and funding require sign-in.

## Products

Every product has an **admin-chosen product ID** (3–40 letters, numbers, `-`, `_`) which is also its Firestore document id and its link: `product.html?id=<productId>`. Clicking a product opens its own page with:

- a photo gallery (up to **5 images**, uploaded by the admin and stored **compressed as base64 in Firestore** — no image host or URL needed),
- the **discounted price** with the **original price slashed through** (and the % off),
- quantity available (stock, shared across all variations),
- the admin-set **minimum order quantity** (any positive whole number, with no fixed 50-item cap),
- **variations with prices** for clothing products (the admin names each variation — e.g. different styles — and sets its price; shoppers must pick one before adding to cart),
- **search keywords** set by the admin, so search finds the product even by words not in its name,
- the product ID and the "Recommended" badge where applicable.

The **Recommended** section sits at the top of the shop. The admin flags a product as recommended when creating (or editing) it, and every shopper's browser raises a **notification** for it: live while the site is open, and a catch-up the next time they visit (Notification API, with an in-page toast fallback; shoppers opt in via the "Turn on alerts" button).

## Social media boosting

Alongside the product catalogue, the store sells **social media boosting services** (Facebook, TikTok, YouTube and more) through a single order form on `boost.html`, styled like a classic SMM panel: **Category** dropdown (e.g. Twitter Views) → **Plans** dropdown (e.g. Twitter Video Views | No Refill - ₦17) → Min/Max line → average-time info box → link → quantity → amount → pay from wallet. (`boost-platform.html` only exists to forward old per-platform links to the order form with the platform preselected.)

The catalogue has three levels, all managed under **Admin → Boosting** (`admin-boost.html`), but the admin only thinks in two:

- **Categories** — what shoppers pick first, e.g. Twitter Views. The form asks for a platform (e.g. Twitter) plus a category (e.g. Views) and shows a live "shoppers will see" preview. New platform names are created automatically — the Platforms section at the bottom of the page exists only to rename a platform or hide everything under it.
- **Plans** — the listings themselves, each with a **name, a unit** (e.g. "followers"), **a price per unit** (whole naira, or a fraction down to ₦0.10 for cheap units — e.g. views), a **minimum and maximum quantity** (blank maximum means no maximum) and an **average delivery time** (e.g. "1 minute") shown on the order form.

Shoppers pick a category and plan, enter the link/username to boost and the quantity (kept within the plan's Min–Max), and pay **from their KORASTORE wallet**. A boost order is `boostOrders/<uid>_<requestId>`: the total is **unit price × quantity**, worked out in kobo (the price may be a fraction of ₦1) and rounded to the nearest whole naira, never below ₦1, because the wallet only holds whole naira. There are no checkout fees and no delivery on a boost order. The order form says so under the amount whenever a plan prices a unit below ₦1. The order transaction re-reads the plan at purchase time, so the price charged is always the admin's current price and the quantity always honours the plan's limits; the security rules re-verify the price, names and wallet debit. The admin moves orders through **paid → processing → delivered**, and cancelling refunds the wallet in one transaction. Boost orders appear on `orders.html` next to product orders.

## Money flow

1. **Fund** (`wallet.html`): the customer pays into the bank account the admin published, then submits the amount and transfer reference. The request is `pending`.
2. **Approve** (`admin-funding.html`): the admin approves once the transfer lands. One transaction marks the request `approved`, credits the wallet, and writes a transaction and a ledger entry.
3. **Buy** (`cart.html` → `placeOrder` in `store.js`): one transaction re-reads each product's price, stock and variations, checks the delivery location, debits the wallet, decrements stock, and creates the order. The charged amount is **items + platform service fee + delivery fee**. The order ID is `<uid>_<requestId>`, so a retried checkout returns the original order instead of charging twice.
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
- A customer's wallet **never goes up**. Only approved admins credit funding and refunds.
- Prices, stock and variation choices can only be used as they are in `/products` at checkout. An order must meet each product's admin-set minimum quantity and cannot exceed available stock; there is no fixed 50-item cap. The browser's totals are checked against them.
- A boost order's `total` must be the plan's current `price` × quantity, worked out in kobo and rounded to whole naira (minimum ₦1), and the boost debit rule makes the wallet fall by exactly that total. Boost plan prices may be fractional (₦0.10 minimum, checked as a number rather than an integer).
- The **service fee and delivery fee** on an order must equal the fee schedule (admin-edited `settings/fees`, defaults ₦2,000 / ₦2,500 / ₦6,000), and the total must be exactly items + those fees.
- Stock can **go down only** in the same batch that creates an order containing that product, and only by the ordered quantity.
- Orders are **create-only**. Customers can't edit or delete them.
- Product documents use the admin's product ID as their id, and only approved admins can create/edit them (including photos, keywords, variations and the recommended flag).
- Either approved admin account (email plus verified email) can approve funding, change order status, edit any user's balance, or post recommended-product announcements.

## Limitations of this design

- **The admin is trusted with balances.** The rules let the admin set any balance. Protect the admin Google/email account (use 2-step verification).
- **Stock decrease is not forced by the order rule.** The order rule doesn't require the matching product updates in the same batch. The normal app always does both, but a modified browser could create a paid order without reducing stock (overselling risk, not a way to get goods for free). Fixing this needs one more `getAfter()` per line, which may exceed Firestore's per-request rule lookup limit. Check it when you test the rules.
- **Carts are capped at 5 lines per order.** Firestore rules can't loop over a list, so each line is checked by index.
- **Boost plan limits (min/max quantity) are enforced in the app's order transaction**, which re-reads the plan at purchase time — not in the security rules, which pin the price, names and wallet debit instead. A modified browser could order outside the limits but would still pay the correct unit price × quantity.
- **Rules are not tested in this repo.** Test them before going live (see Setup, step 3).
- **Delivery locations** are checked in the browser against `data/ng-locations.json`. The rules only check that they're strings. The delivery location itself is stored in Firestore (`users/{uid}`), not in browser storage.
- **Product photos are compressed client-side** (JPEG, max 5) and stored as base64 inside the product document — Firestore's 1 MB per-document limit is why the uploader compresses them. Very photo-heavy products (5 large photos) push that limit; the uploader blocks oversized sets.
- **Browser notifications** are best-effort: they fire live while the site is open and as a catch-up on the next visit. There is no push server, so a closed browser is notified only when the shopper returns.
- **No tax, coupons, email notifications or payment-gateway integration.**

## Pages

- Storefront: `index.html` (home), `shop.html` (catalogue with search, categories and sorting), `product.html`, `boost.html` (boost order form: category → plan → link → quantity → pay), `boost-platform.html` (forwards old platform links to the order form), `cart.html`
- Accounts: `login.html`, `register.html`
- Customer: `dashboard.html` (overview), `wallet.html` (fund), `orders.html`, `profile.html` (delivery location)
- Admin: `admin.html` (overview), `admin-products.html` (searchable by Product ID), `admin-boost.html` (boosting categories, plans with min/max and average times, orders), `admin-funding.html`, `admin-orders.html`, `admin-fees.html` (checkout fees), `admin-settings.html` (deposit bank details)

Shared client code is in `store.js`, styles in `store.css`. Nigerian states and LGAs are in `data/ng-locations.json` (from the MIT-licensed `nigeria-state-lga-data` package, 37 entries, 777 LGAs). Non-Nigerian addresses use free text for state and area.

## Data model (Firestore)

| Path | Written by | Read by |
|---|---|---|
| `users/{uid}` | customer (name, delivery location, one wallet decrease per order); admin (`balance`) | owner, admin |
| `users/{uid}/transactions/{id}` | customer (purchase record only); admin (funding, refund) | owner, admin |
| `products/{productId}` | admin (listing, prices, stock, photos, keywords, variations, recommended); customer (stock and `sold` on purchase only) | anyone (active only); admin (all) |
| `boostPlatforms/{id}` | admin (platform name + description, visibility) | anyone (active only); admin (all) |
| `boostCategories/{id}` | admin (category inside a platform) | anyone (active only); admin (all) |
| `boostSubcategories/{id}` | admin (plan: name, unit, price, min/max quantity, average time) | anyone (active only); admin (all) |
| `boostOrders/{uid}_{requestId}` | customer (create once); admin (status) | owner, admin |
| `settings/payment` | admin | signed-in users |
| `settings/fees` | admin (checkout fee schedule) | signed-in users |
| `fundingRequests/{id}` | customer (create); admin (review) | owner, admin |
| `orders/{uid}_{requestId}` | customer (create once); admin (status) | owner, admin |
| `notifications/{id}` | admin (recommended-product announcements) | everyone |
| `ledger/{id}` | customer (purchase entries only); admin (all) | admin |

Money is stored as whole naira (integers) — the wallet never holds kobo. A boost plan's `price` is the one fractional amount in the store (₦0.10 and up); its order `total` is `unitPrice × quantity` in kobo, rounded to whole naira. Product documents hold the admin-chosen `productId` as their id plus `name`, `category`, `price` (selling), `compareAtPrice` (slashed original, optional), `stock`, `minOrderQuantity`, `sold`, `description`, `keywords[]`, `images[]` (base64), `variations[]` (each `{name, price}` — clothing options with their own prices), `recommended`, `active`. Orders hold `items[]` (with quantity and optional `variant` name and `variantIndex` per line), `subtotal`, `serviceFee`, `deliveryFee`, `total` and the `delivery` snapshot. Boosting: `boostPlatforms` (`name`, `description`, `active` — created automatically from the category form), `boostCategories` (`platformId`, `name`, `description`, `active`), `boostSubcategories` (`categoryId`, `name`, `description`, `unit`, `price`, `minQuantity`, `maxQuantity` where 0 means no maximum, `averageTime`, `active`) and `boostOrders` (`uid`, `requestId`, platform/category/service names and ids, `unit`, `unitPrice`, `quantity`, `total`, `link`, `status`).

## Setup and deployment

1. **Firebase console** (project `korasub-eb0b8`): enable Email/Password and Google sign-in, and create the Firestore database.
2. **Admin accounts.** Register using either approved email (`beniwealth70@gmail.com` or `okogbagideon28@gmail.com`) and verify it. No custom claim is needed; the rules check the email and verification.
3. **Test the rules first.** In the Firebase console, open **Firestore → Rules → Rules Playground** and check at least:
   - a customer can create an order, and the wallet goes down by exactly the total (items + fees);
   - a customer **cannot** change their own `balance` without an order;
   - a customer **cannot** raise their own `balance`;
   - a customer cannot change product price, name or stock outside a matching order;
   - a customer cannot skip the platform service fee or the delivery fee on an order;
   - a boost order pays exactly the plan's price × quantity (rounded to whole naira, minimum ₦1) — try a plan priced at ₦0.10 with 10 units (₦1) and 15 units (₦2);
   - only approved admins can approve funding, change order status, list products, or post notifications.
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
