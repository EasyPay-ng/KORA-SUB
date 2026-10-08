# KORASTORE

**Find it. Fund it. Own it.**

KORASTORE is an online store. The administrator lists and prices every product. Customers browse the catalogue, fund a wallet by bank transfer, and buy from that wallet. Orders are delivered to a location the customer sets (country, state, local government area, address).

There is no server. The site is static files plus Firebase (Auth and Firestore). Balances, stock and orders are changed by the browser inside Firestore transactions, and **`firestore.rules` is the only protection**. Read the rules before changing anything.

## Roles

- **Administrator**: only `beniwealth70@gmail.com`, with a verified email. The admin lists, prices, stocks and hides products; publishes the deposit bank account; approves funding; and moves orders through packing, shipping and delivery.
- **Customers**: anyone who registers. They browse, add to cart, fund their wallet, check out, set delivery location and track orders. They cannot list products, change their own balance upward, or edit other people's data.
- **Visitors**: can browse the shop without an account. Checkout and funding require sign-in.

## Money flow

1. **Fund** (`wallet.html`): the customer pays into the bank account the admin published, then submits the amount and transfer reference. The request is `pending`.
2. **Approve** (`admin-funding.html`): the admin approves once the transfer lands. One transaction marks the request `approved`, credits the wallet, and writes a transaction and a ledger entry.
3. **Buy** (`cart.html` → `placeOrder` in `store.js`): one transaction re-reads each product's price and stock, checks the delivery location, debits the wallet, decrements stock, and creates the order. The order ID is `<uid>_<requestId>`, so a retried checkout returns the original order instead of charging twice.
4. **Track and refund** (`admin-orders.html`, `orders.html`): paid → processing → shipped → delivered. Cancelling refunds the full total to the wallet and restocks the items, in one transaction.

No card or payment gateway is integrated. All deposits are manual bank transfers approved by the admin.

## What the rules enforce

- A customer's wallet can **go down only** in the same batch that creates their own order, and only by exactly the order total.
- A customer's wallet **never goes up**. Only the admin credits funding and refunds.
- Prices and stock can only be used as they are in `/products` at checkout. The browser's totals are checked against them.
- Stock can **go down only** in the same batch that creates an order containing that product, and only by the ordered quantity.
- Orders are **create-only**. Customers can't edit or delete them.
- The admin account (email plus verified email) is the only account that approves funding, changes order status, or edits any user's balance.

## Limitations of this design

- **The admin is trusted with balances.** The rules let the admin set any balance. Protect the admin Google/email account (use 2-step verification).
- **Stock decrease is not forced by the order rule.** The order rule doesn't require the matching product updates in the same batch. The normal app always does both, but a modified browser could create a paid order without reducing stock (overselling risk, not a way to get goods for free). Fixing this needs one more `getAfter()` per line, which may exceed Firestore's per-request rule lookup limit. Check it when you test the rules.
- **Carts are capped at 5 different products per order.** Firestore rules can't loop over a list, so each line is checked by index.
- **Rules are not tested in this repo.** Test them before going live (see Setup, step 3).
- **Delivery locations** are checked in the browser against `data/ng-locations.json`. The rules only check that they're strings.
- **Product images** are links you paste in (https only). There is no upload.
- **No delivery fees, tax, coupons, email notifications or payment-gateway integration.**

## Pages

- Storefront: `index.html` (home), `shop.html` (catalogue with search, categories and sorting), `product.html`, `cart.html`
- Accounts: `login.html`, `register.html`
- Customer: `dashboard.html` (overview), `wallet.html` (fund), `orders.html`, `profile.html` (delivery location)
- Admin: `admin.html` (overview), `admin-products.html`, `admin-funding.html`, `admin-orders.html`, `admin-settings.html` (bank details)

Shared client code is in `store.js`, styles in `store.css`. Nigerian states and LGAs are in `data/ng-locations.json` (from the MIT-licensed `nigeria-state-lga-data` package, 37 entries, 777 LGAs). Non-Nigerian addresses use free text for state and area.

## Data model (Firestore)

| Path | Written by | Read by |
|---|---|---|
| `users/{uid}` | customer (name, location, one wallet decrease per order); admin (`balance`) | owner, admin |
| `users/{uid}/transactions/{id}` | customer (purchase record only); admin (funding, refund) | owner, admin |
| `products/{id}` | admin (listing, price, stock); customer (stock and `sold` on purchase only) | anyone (active only); admin (all) |
| `settings/payment` | admin | signed-in users |
| `fundingRequests/{id}` | customer (create); admin (review) | owner, admin |
| `orders/{uid}_{requestId}` | customer (create once); admin (status) | owner, admin |
| `ledger/{id}` | customer (purchase entries only); admin (all) | admin |

Money is stored as whole naira (integers).

## Setup and deployment

1. **Firebase console** (project `korasub-eb0b8`): enable Email/Password and Google sign-in, and create the Firestore database.
2. **Admin account.** Register with `beniwealth70@gmail.com` and verify the email. No custom claim is needed; the rules check the email and verification.
3. **Test the rules first.** In the Firebase console, open **Firestore → Rules → Rules Playground** and check at least:
   - a customer can create an order, and the wallet goes down by exactly the total;
   - a customer **cannot** change their own `balance` without an order;
   - a customer **cannot** raise their own `balance`;
   - a customer cannot change product price, name or stock outside a matching order;
   - only the admin can approve funding or change order status.
   Then run through a full purchase and refund on a test account.
4. **Deploy the rules.** Sign in with the Firebase CLI, then:
   ```sh
   npx firebase-tools login
   npm run deploy:rules
   ```
   Or paste `firestore.rules` into **Firestore → Rules → Publish** in the console.
5. **Publish deposit details.** Sign in as the admin, open **Bank details**, and save the bank name, account name and 10-digit account number. Customers can't fund until these are published.
6. **Frontend.** Serve the static files (GitHub Pages or any static host). The site has no backend to configure.

## Tests

There is no automated test suite in this repo. Use the Rules Playground and a manual purchase/refund run (step 3 above).

Note: Firestore rules that call `getAfter()` and `get()` need to be tested against the live project or the Firestore emulator before go-live.
