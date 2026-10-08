# KORASUB

Clean VTU frontend for airtime, data, bills, exam pins, social services, eSIM and more.

## Security
The GSUBZ API key is intentionally not included in this repository. Store the regenerated key as a Render secret/environment variable named `GSUBZ_API_KEY`. Firebase web configuration is public by design. All GSUBZ calls must happen in the Render backend, not in browser JavaScript.

## Current frontend
- `index.html` marketing landing page
- `dashboard.html` and `admin.html` are the application shells to be wired to Firebase Auth/Firestore
- `styles.css` shared visual system
- `firebase-config.js` public Firebase configuration and admin allowlist

## Suggested Render architecture
Deploy a Node/Express API on Render with:
- `GSUBZ_API_KEY` as a Render secret
- Firebase Admin SDK service-account credentials as Render secrets
- `/api/*` routes for balance, plans, purchases, transaction verification, and eSIM orders
- unique request IDs and idempotency checks before retrying purchases
- Firestore wallet ledger writes performed server-side only

The browser should call the Render API using relative `/api` URLs. Configure the frontend host or Render static site rewrite so `/api/*` is proxied to the backend.

## Wallet policy
Customers submit funding requests. The admin reviews and approves them. Every credit/debit must create an immutable ledger entry. Failed transactions are marked pending refund for admin approval; no automatic customer balance change should happen without the configured policy.
