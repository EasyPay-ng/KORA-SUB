# KORASTORE

**Find it. Fund it. Own it.**

KORASTORE is an online store. The administrator lists and prices every product. Customers browse the catalogue, fund a wallet by bank transfer, and buy from that wallet. Orders are **collected at a pickup station**: the customer picks their state, then the station closest to them. Shipping is blank when the order is placed; the admin sets it per order after reviewing the pickup details, and the customer receives the final amount breakdown in a browser notification.

There is no server. The site is static files plus Firebase (Auth and Firestore). Balances, stock and orders are changed by the browser inside Firestore transactions, and **`firestore.rules` is the only protection**. Read the rules before changing anything.

## Roles

- **Administrators**: `beniwealth70@gmail.com` and `okogbagideon28@gmail.com`, each with a verified email. Either admin can list, price, stock and hide products; upload up to 5 photos per product; set search keywords, slashed original prices, clothing variations with their own prices and the "Recommended" flag; publish the deposit bank account; set the platform fee; approve funding; set shipping per order; and move fully paid orders through packing, shipping and delivery. They also run the **social media boosting** catalogue: categories (e.g. Twitter Views) and plans with prices, min/max quantities and average delivery times. They can search the product list by Product ID (typing an exact ID and pressing Enter jumps straight to editing it).
- **Customers**: anyone who registers. They browse, add to cart, fund their wallet, choose a pickup station and check out, then track orders. They cannot list products, change their own balance upward, or edit other people's data.
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

Alongside the product catalogue, the store sells **social media boosting services** (Facebook, TikTok, YouTube and more) through a single order form on `boost.html`: **Category** → **Plan** (shown with a rate per 1,000 units) → source Min/Max → average-time info → link → quantity → amount → pay from wallet. (`boost-platform.html` only exists to forward old per-platform links to the order form with the platform preselected.)

The catalogue is a snapshot of **GSUBZ's "Socials Media Market"** (`data/gsubz-socials-services.json`; see `data/gsubz-socials-services.README.md`). **Admin → Boosting** (`admin-boost.html`) picks the **cheapest qualifying plan(s)** in each category whose KORASTORE rate is between **₦500 and ₦50,000 per 1,000 units**; ties at the lowest eligible rate are included. The site rate remains **2× the GSUBZ rate**. GSUBZ's original min/max quantities are kept (including its "no maximum" marker). Free-service categories are excluded. Publishing writes to `boostPlatforms` / `boostCategories` / `boostSubcategories` and hides plans not selected by the current snapshot. The admin edits just the **rate per 1,000** and **average time**; a re-publish keeps those edits. Old per-unit prices are deliberately reset on the first publish of this rate-basis change. Average times are never shown below 1 hour.

Shoppers pick a category and plan, enter the link/username to boost and a quantity within the plan's GSUBZ Min–Max, then pay **from their KORASTORE wallet**. The order total is **rate per 1,000 × quantity ÷ 1,000**, calculated in kobo and rounded to the nearest whole naira (minimum ₦1), because the wallet only holds whole naira. For example, ₦1,500 per 1,000 units costs ₦750 for 500 units. There are no checkout fees or delivery charges on boosts. The order transaction re-reads the plan at purchase time and verifies its rate, source limits and names; Firestore rules independently check the rate basis, quantity limits, total and wallet debit. The admin moves orders through **paid → processing → delivered**; cancelling refunds the wallet in one transaction. Boost orders appear on `orders.html` next to product orders.

## Travel eSIMs

`esim.html` sells travel data plans, and **Admin → eSIM plans** (`admin-esim.html`) is where the catalogue comes from. Every plan is typed in by hand: **Plan ID** (3–40 letters, numbers, `-` or `_`), **destination** (picked from the 41 built-in countries/regions, or typed as a new one such as "Kenya & Tanzania"), country or region type, **data allowance**, **validity in days**, **selling price** (₦1–₦5,000,000), an optional slashed original price, activation notes and a listed/hidden switch. There is no supplier feed, so **nothing can be bought that an admin did not write**.

Travellers search the destinations that have listed plans — each row shows how many plans it has and its cheapest price — open a destination, and buy a plan for 1–10 people on one order. Payment is from the **KORASTORE wallet**, in one transaction that re-reads the plan, so the amount charged is the plan's price at that moment. The order ID is `<uid>_<requestId>`, so a retried payment returns the original order instead of charging twice. There is no service fee and no shipping on an eSIM: `total = price × quantity`.

The admin fulfils the order on the same page: **paid → processing → delivered**, sending the QR code or activation details to the customer's account email and recording what was sent. The traveller reads those instructions under **My eSIMs** (`esim.html`) and on `orders.html`. **Cancelling before delivery refunds the full amount** to the wallet in the same transaction; a delivered order cannot be cancelled. eSIM orders are included in the admin overview and analytics revenue.

- `esim-catalogue.mjs` holds the destination list plus the validation, grouping and pricing logic shared by the storefront, the admin form, `store.js` and — through matching constants — the rules. It is Firebase-free so it runs in Node.
- `esim.js` renders the browser, the purchase box and My eSIMs. It never touches Firebase: `esim.html` subscribes to the plans, the wallet and the customer's orders and pushes them in, which is also what makes the page testable.
- `esim.css` extends the existing navy/gold theme, with stacked layouts on smaller screens and keyboard-accessible tabs.

**Before scaling this up:** a hand-typed catalogue means the admin owns coverage, pricing and fulfilment, so keep each plan's notes truthful about coverage and when validity starts. When a supplier API is connected, keep its credentials in a trusted backend/secret store (never in these static files or chat), validate quotes server-side, store installation credentials in owner-only records, and process verified supplier status/refund events.

## Pickup stations

Customers do not enter a doorstep address: every order is collected at a **pickup station**. Checkout (and the account page) lists them like a classic SMM/checkout panel:

1. the customer picks their **state** — only states that have stations are offered, with the number of stations in brackets;
2. the stations in that state are listed (name, address, landmark) and the customer picks the one closest to them — a **Use my location** button sorts them by distance with the GPS position and pre-selects the nearest (the position never leaves the browser);
3. the choice is saved on the customer's profile (`users/{uid}.pickup`), shown in the cart summary, recorded on the order, and gives the admin the destination used to set shipping and fulfil the order.

The station snapshot is recorded on the order so the admin can review the destination before choosing shipping. The customer is told the shipping amount only after it is set for that order.

The catalogue is a snapshot of **Jumia's own pickup-station data** (451 stations across 34 states + the FCT) shipped as `data/jumia-pickup-stations.json`; see `data/jumia-pickup-stations.README.md` for the source and caveats. The admin publishes it into the database under **Admin → Pickup stations** (`admin-pickup.html`) — stations live in `pickupStations/{stationId}` and are what the app and the security rules read, so the store can hide a closed station or re-publish the file when Jumia's list changes. The page also shows which published stations are no longer in the file.

## Money flow

1. **Fund** (`wallet.html`): the customer pays into the bank account the admin published, then submits the amount and transfer reference. The request is `pending`.
2. **Approve** (`admin-funding.html`): the admin approves once the transfer lands. One transaction marks the request `approved`, credits the wallet, and writes a transaction and a ledger entry.
3. **Buy** (`cart.html` → `placeOrder` in `store.js`): the customer picks their pickup station, then one transaction re-reads each product's price, stock and variations, re-reads the station, debits the wallet for **items + platform service fee**, decrements stock, and creates an order with `shippingFee: null`. The order ID is `<uid>_<requestId>`, so a retried checkout returns the original order instead of charging twice.
4. **Set shipping and notify** (`admin-orders.html`): the admin enters the shipping fee for that order. The order's final total becomes **items + platform service fee + shipping**, and a private account notification triggers an in-page toast plus browser notification. The customer can then pay the disclosed shipping amount from the wallet.
5. **Track and refund** (`admin-orders.html`, `orders.html`): paid → processing → shipped → delivered. Fulfilment cannot begin while shipping is unpaid. Cancelling refunds only what the customer has paid and restocks the items, in one transaction.

Digital purchases skip delivery: a **boost** (`boost.html`) or an **eSIM** (`esim.html`) is one transaction that re-reads the catalogue item, debits the wallet for the catalogue price and creates an order the admin moves to delivered. No shipping is set and no service fee is added; cancelling before delivery refunds the wallet.

No card or payment gateway is integrated. All deposits are manual bank transfers approved by the admin.

## Checkout fees and per-order shipping

The platform service fee is shown in the cart and charged when the customer places the order. The default is:

| Fee | Default | Applies to |
|---|---:|---|
| Platform service fee | ₦2,000 | every product order, charged at checkout |
| Shipping | blank | set later by the admin for each order |

The admin can change the platform service fee under **Admin → Checkout fees** (`settings/fees`). Shipping is entered under **Admin → Orders** after the order and pickup station are visible. Setting shipping updates the final total and creates a private customer notification containing the item subtotal, service fee, shipping fee, total and amount still due. The customer pays the disclosed shipping amount from the wallet; only then can fulfilment begin. The rules re-verify both the admin's final total and the customer's later shipping debit.

## What the rules enforce

- A customer's wallet can **go down only** in the same batch that creates their own order, and only by the items subtotal plus the platform service fee. A later wallet debit can only pay the shipping amount disclosed on that customer's order.
- A customer's wallet **never goes up** from a customer write. Only approved admins credit funding and refunds.
- Prices, stock and variation choices can only be used as they are in `/products` at checkout. An order must meet each product's admin-set minimum quantity and cannot exceed available stock; there is no fixed 50-item cap. The browser's totals are checked against them.
- A pickup order's `delivery` must name a station that exists in `/pickupStations`, is active, and whose **name, state and address** match the station document exactly. The snapshot lets the admin choose an appropriate per-order shipping amount.
- The `pickup` saved on a customer's profile is checked the same way (station exists, is active, name and state match).
- A boost order's `total` must be the plan's current rate per 1,000 × quantity ÷ 1,000, rounded to whole naira (minimum ₦1). Firestore also checks the ₦500–₦50,000 rate range, `priceBasis: 1000`, source min/max quantity and exact wallet debit.
- An eSIM order's `total` must be the plan's **current** price × quantity (1–10), the plan must be active, and the destination, allowance and validity on the order must match the plan exactly. The wallet debit is checked exactly, as with other purchases.
- eSIM plans can only be created and edited by approved admins (plan ID 3–40 characters, price ₦1–₦5,000,000, validity 1–3,650 days). A customer write may move a plan's `sold` counter only, by the quantity in the order created in the same batch.
- The platform service fee must equal the admin-edited `settings/fees` amount (default ₦2,000). A new order's `shippingFee` must be null; an admin update must pin the final total to items + service fee + shipping, and the private notification must carry the same breakdown.
- Stock can **go down only** in the same batch that creates an order containing that product, and only by the ordered quantity.
- Orders are **create-only**. Customers can't edit or delete them.
- Product documents use the admin's product ID as their id, and only approved admins can create/edit them (including photos, keywords, variations and the recommended flag).
- Either approved admin account (email plus verified email) can approve funding, change order status, edit any user's balance, or post recommended-product announcements.

## Limitations of this design

- **The admin is trusted with balances.** The rules let the admin set any balance. Protect the admin Google/email account (use 2-step verification).
- **Stock decrease is not forced by the order rule.** The order rule doesn't require the matching product updates in the same batch. The normal app always does both, but a modified browser could create a paid order without reducing stock (overselling risk, not a way to get goods for free). Fixing this needs one more `getAfter()` per line, which may exceed Firestore's per-request rule lookup limit. Check it when you test the rules.
- **Carts are capped at 5 lines per order.** Firestore rules can't loop over a list, so each line is checked by index.
- **Boost plan limits are checked by both the app transaction and Firestore rules.** Each order re-reads the plan and must stay within its current source min/max (and the site-wide quantity ceiling); the rule pins the rate per 1,000 and recalculates the total.
- **Rules are not tested in this repo.** Test them before going live (see Setup, step 3).
- **Pickup stations are a snapshot.** The list comes from Jumia's own station data through a third-party mirror (451 stations in the current file), so stations open, move and close between snapshots. The admin page shows what changed, hides stations that vanished and re-publishes the file — but confirm important stations before promising one. The GPS position used for "closest station" is only used in the browser and never saved.
- **The old doorstep address is record-only.** `users/{uid}` still keeps `country`, `state`, `lga` and `address` (nothing is delivered there any more). The rules only check that they're strings. The pickup location itself is stored in Firestore (`users/{uid}`), not in browser storage.
- **Product photos are compressed client-side** (JPEG, max 5) and stored as base64 inside the product document — Firestore's 1 MB per-document limit is why the uploader compresses them. Very photo-heavy products (5 large photos) push that limit; the uploader blocks oversized sets.
- **Analytics are approximate.** Visits are page views, not unique people. Counters are open to anyone who can reach the site, so a script could inflate them (Firebase App Check would reduce that, but it is not set up here). Clicks are measured by the page, so a click on a link that opens another site can be missed if the page closes before the count is saved.
- **Funding alerts need a browser.** They run only while an admin's browser has the site open. A closed browser learns about a request on its next visit.
- **Browser notifications** are best-effort: shipping breakdowns fire live while the customer's site is open and are caught up on the next visit from a private account feed. The customer must grant browser notification permission; the in-page toast remains available as a fallback. Closed-browser push still needs OneSignal/server delivery.
- **No tax, coupons, email notifications or payment-gateway integration.**

## Pages

- Storefront: `index.html` (home), `shop.html` (catalogue with search, categories and sorting), `product.html`, `boost.html` (boost order form: category → plan → link → quantity → pay), `boost-platform.html` (forwards old platform links to the order form), `esim.html` (travel eSIM browser, purchase and My eSIMs), `cart.html`
- Accounts: `login.html`, `register.html`
- Customer: `dashboard.html` (overview), `wallet.html` (fund), `orders.html`, `profile.html` (pickup station)
- Admin: `admin.html` (overview), `admin-analytics.html` (visits, clicks, leads, sales), `admin-products.html` (searchable by Product ID), `admin-boost.html` (boosting categories, plans with min/max and average times, orders), `admin-esim.html` (eSIM plans added by hand, plus eSIM order fulfilment), `admin-pickup.html` (publish and hide pickup stations), `admin-funding.html`, `admin-orders.html`, `admin-fees.html` (checkout fees), `admin-settings.html` (deposit bank details)

Shared client code is in `store.js`, styles in `store.css`. Nigerian states and LGAs are in `data/ng-locations.json` (from the MIT-licensed `nigeria-state-lga-data` package, 37 entries, 777 LGAs). Non-Nigerian addresses use free text for state and area.

## Data model (Firestore)

| Path | Written by | Read by |
|---|---|---|
| `users/{uid}` | customer (name, pickup station, wallet debits); admin (`balance`) | owner, admin |
| `users/{uid}/transactions/{id}` | customer (purchase and shipping payment records); admin (funding, refund) | owner, admin |
| `users/{uid}/notifications/{id}` | admin (shipping breakdown) | owner, admin |
| `products/{productId}` | admin (listing, prices, stock, photos, keywords, variations, recommended); customer (stock and `sold` on purchase only) | anyone (active only); admin (all) |
| `pickupStations/{stationId}` | admin (publish from data/jumia-pickup-stations.json, hide) | anyone (active only); admin (all) |
| `settings/pickupStations` | admin (states + counts summary) | everyone |
| `boostPlatforms/{id}` | admin (platform name + description, visibility) | anyone (active only); admin (all) |
| `boostCategories/{id}` | admin (category inside a platform) | anyone (active only); admin (all) |
| `boostSubcategories/{id}` | admin (plan: name, unit, `price` per 1,000, `priceBasis: 1000`, GSUBZ min/max quantity, average time) | anyone (active only); admin (all) |
| `boostOrders/{uid}_{requestId}` | customer (create once; rate per 1,000, quantity, total); admin (status) | owner, admin |
| `esimPlans/{planId}` | admin (destination, allowance, validity, price, notes, listing); customer (`sold` on purchase only) | anyone (active only); admin (all) |
| `esimOrders/{uid}_{requestId}` | customer (create once; price, quantity, total); admin (status and delivery `instructions`) | owner, admin |
| `settings/payment` | admin | signed-in users |
| `settings/fees` | admin (platform service fee) | signed-in users |
| `fundingRequests/{id}` | customer (create); admin (review) | owner, admin |
| `orders/{uid}_{requestId}` | customer (create once and pay disclosed shipping); admin (shipping, status) | owner, admin |
| `notifications/{id}` | admin (recommended-product announcements) | everyone |
| `ledger/{id}` | customer (purchase and shipping entries); admin (all) | admin |
| `analyticsDaily/{YYYY-MM-DD}` | anyone on the storefront (`visits`, `whatsappClicks`, `linkClicks`, +1 each write) | admin |
| `analyticsLinks/{label}` | anyone clicking a tracked link (`count` +1, label slug) | admin |

Money is stored as whole naira (integers) — the wallet never holds kobo. A boost plan's `price` is a naira rate per 1,000 units and carries `priceBasis: 1000`; its order `total` is `unitPrice × quantity ÷ 1,000`, rounded to whole naira. Product documents hold the admin-chosen `productId` as their id plus `name`, `category`, `price` (selling), `compareAtPrice` (slashed original, optional), `stock`, `minOrderQuantity`, `sold`, `description`, `keywords[]`, `images[]` (base64), `variations[]` (each `{name, price}` — clothing options with their own prices), `recommended`, `active`. Orders hold `items[]` (with quantity and optional `variant` name and `variantIndex` per line), `subtotal`, `serviceFee`, nullable `shippingFee`, `total`, `amountPaid`, `amountDue`, `shippingStatus` and the `delivery` snapshot. A shipping update also creates `users/{uid}/notifications/shipping_{orderId}` with the same amount breakdown. Boosting: `boostPlatforms` (`name`, `description`, `active` — created automatically from the category form), `boostCategories` (`platformId`, `name`, `description`, `active`), `boostSubcategories` (`categoryId`, `name`, `description`, `unit`, `price` per 1,000, `priceBasis: 1000`, `minQuantity`, `maxQuantity` where 0 means no maximum, `averageTime`, `active`) and `boostOrders` (`uid`, `requestId`, platform/category/service names and ids, `unit`, `unitPrice` per 1,000, `priceBasis: 1000`, `quantity`, `total`, `link`, `status`). eSIMs: `esimPlans` (the admin-chosen `planId` as the id, plus `destinationId`, `destinationName`, `destinationType`, `data`, `validityDays`, `price`, `compareAtPrice`, `notes`, `active`, `sold`) and `esimOrders` (`uid`, `requestId`, `planId`, a snapshot of the destination/allowance/validity, `unitPrice`, `quantity`, `total`, `email`, `status`, and `instructions` written by the admin when delivering).

## WhatsApp channel, funding alerts and analytics

**WhatsApp channel.** Every storefront page shows a green **Join our channel** button (bottom right) that opens KORASTORE's WhatsApp channel. The footer has the same link. The URL lives in `WHATSAPP_CHANNEL_URL` in `store.js`.

**Funding alerts for admins.** While an approved admin is signed in on any page, each new `pending` funding request raises a browser notification (and an in-page toast) with the customer's name, the amount and the reference. Admins turn this on with **🔔 Turn on funding alerts** in the admin sidebar, because browsers only show the permission prompt after a click. Alerts are best-effort, like recommended-product alerts: they fire while an admin page or the storefront is open, and anything that arrived while the browser was closed is caught up on the next visit. Closed-browser push would need Firebase Cloud Messaging plus a Cloud Function, which this no-server design does not have.

**Analytics** (`admin-analytics.html`). Anonymous counters, with no IP addresses, no device IDs and no personal data in the counters:

- **Visits** are storefront page views, counted once per page load in `analyticsDaily/{YYYY-MM-DD}` (Lagos time). Admin accounts are not counted. A page view is not a unique visitor.
- **Clicks** come from elements marked `data-track="<label>"`. The header nav, footer, the home-page buttons and the WhatsApp button are tagged. WhatsApp clicks are counted separately as `whatsappClicks`, and all other tracked links as `linkClicks`. Per-link totals live in `analyticsLinks/{label}`.
- **Total users** counts registered customer accounts, not counting the admin accounts.
- **Leads** are registered customers who have not placed a product or boost order yet. The page lists them newest first, with a search box.
- **Sales and funding** come from the existing orders, boost orders and funding requests (cancelled orders are excluded from revenue).

Firestore rules only let these counters go up by exactly 1 per write, and only admins can read them. A WhatsApp **join** cannot be measured; the page counts clicks on the button.

## Closed-browser push (OneSignal, no server)

Shoppers who press **Turn on alerts** on the shop page are subscribed through **OneSignal's free web-push plan**. Their browser then gets a notification even when the site is closed (desktop and Android Chrome, Edge and Firefox; iPhone only after the site is added to the home screen). The site itself stays static: the OneSignal web SDK runs in the browser and uses `sw.js`. Nothing secret is stored in this repo.

**Setup (one time):**

1. Create a free account at onesignal.com and make a **Web** app. Use your store's address as the site URL.
2. Copy the **OneSignal App ID** into `ONESIGNAL_APP_ID` in `push-config.js`, then deploy the site. Until this is set, closed-browser push is off.
3. Keep the **REST API key** from OneSignal (Settings → Keys & IDs) private. Do not put it in the repo or the site.

**Sending a recommended product:** when you mark a product as recommended, the in-browser alert goes out automatically to shoppers with the site open. For closed browsers, open the OneSignal dashboard → **Messages → New Push**, use the product name as the message, and link it to `product.html?id=<productId>`. The admin Products page reminds you of this after each new recommendation.

Sending from the admin page automatically would need a small server-side function that keeps the REST key secret. That isn't part of this setup.

## Setup and deployment

1. **Firebase console** (project `korasub-eb0b8`): enable Email/Password and Google sign-in, and create the Firestore database.
2. **Admin accounts.** Register using either approved email (`beniwealth70@gmail.com` or `okogbagideon28@gmail.com`) and verify it. No custom claim is needed; the rules check the email and verification.
3. **Test the rules first.** In the Firebase console, open **Firestore → Rules → Rules Playground** and check at least:
   - a customer can create an order, the wallet goes down by items + service fee, and `shippingFee` is blank;
   - a customer **cannot** change their own `balance` without an order;
   - a customer **cannot** raise their own `balance`;
   - a customer cannot change product price, name or stock outside a matching order;
   - a customer cannot skip the platform service fee, and cannot set shipping during checkout;
   - a boost order pays the plan's rate per 1,000 × quantity ÷ 1,000 — for example, ₦1,500 per 1,000 costs ₦750 for 500 units and ₦1,500 for 1,000 units; a quantity outside that plan's GSUBZ limits is rejected;
   - a customer cannot order to a station that does not exist, is hidden, or whose state does not match the station document;
   - only approved admins can approve funding, change order status, list products, or post notifications.
   Then run through a full purchase and refund on a test account.
4. **Deploy the rules.** Required for the analytics counters, the admin analytics page and the funding alerts to work. Sign in with the Firebase CLI, then:
   ```sh
   npx firebase-tools login
   npm run deploy:rules
   ```
   Or paste `firestore.rules` into **Firestore → Rules → Publish** in the console.
5. **Publish the pickup stations.** Sign in as the admin, open **Pickup stations** (`admin-pickup.html`) and press **Publish stations**. This writes the 451 stations from `data/jumia-pickup-stations.json` into `pickupStations/` and the state summary into `settings/pickupStations`. **Customers cannot check out until this is done** — the security rules only accept a station that exists in the database. Re-run it whenever the file is updated (new stations are added, existing ones refreshed, stations you hid stay hidden) and use **Hide stations missing from the file** to close ones Jumia has dropped.
6. **Publish deposit details.** Sign in as the admin, open **Bank details**, and save the bank name, account name and 10-digit account number. These are for wallet **deposits only** — customers transfer in, the admin approves, and orders then debit the wallet balance. Customers can't fund until these are published. Review **Checkout fees** at the same time.
7. **Publish the boost catalogue.** Sign in as admin, open **Boosting** (`admin-boost.html`), and press **Publish catalogue**. Do this after deploying the per-1,000 pricing update: it publishes the cheapest qualifying plans and quantity limits from the bundled GSUBZ snapshot, hides old plans, and resets any legacy per-unit price override.
8. **Frontend.** Serve the static files (GitHub Pages or any static host). The site has no backend to configure.

## Tests

`npm ci` then `npm test` runs the Node suite — no Firebase project, credentials or browser binaries needed:

- `tests/esim.test.mjs` — catalogue logic: destination search, grouping, custom destination IDs, plan validation and order totals.
- `tests/esim-ui.test.mjs` — drives the real `esim.html` in jsdom with sample plans: browsing, filters, the purchase box, wallet shortfalls, My eSIMs, and the empty/error states.
- `tests/esim-orders.test.mjs` — runs the **real** `store.js` against an in-memory Firestore stand-in (`tests/helpers/`): purchases, retry safety, refused orders, refunds and admin plan writes.
- `tests/esim-rules.test.mjs` — checks `firestore.rules` is still well formed and that its eSIM limits match the constants the client uses.

The Firestore emulator needs a JVM, so the rules themselves are **not executed** by this suite. Before go-live, exercise them in the console's Rules Playground or against the emulator with a real purchase, a retry and a refund (money flow step 3).
