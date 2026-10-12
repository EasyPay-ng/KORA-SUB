# GSUBZ "Socials Media Market" services

A snapshot of every service (plan) on GSUBZ's **Socials Media Market** SMM panel — the
catalogue behind <https://gsubz.com/service/buy.php?id=socials>.

| File | What it is |
|---|---|
| `gsubz-socials-services.json` | All **5,105 services**: `id`, `category`, `name`, `price` (naira per unit), `min`, `max`, `description`, sorted by category then name. The `form` object names the order-form fields the plan id posts under. |
| `gsubz-socials-services.csv` | The same rows as a spreadsheet-friendly CSV (header: `id,category,name,price,min,max,description`) |
| `gsubz-socials-services-summary.json` | Service counts and price range per category, largest first |

## Snapshot

- **5,105 services** in **567 categories** — exactly the category list in the buy page's
  dropdown and the plans in its "Plans" selector.
- Fetched from GSUBZ's public, unauthenticated JSON endpoint
  `https://gsubz.com/api/plans?service=socials` (the same data the buy page is built
  from; `api.gsubz.com` mirrors it).
- `price` is the **per-unit price in naira** (₦0.30 for the cheapest views up to
  ₦12,338,859.68 for the most expensive premium package); `min`/`max` are the per-order
  quantity limits.
- The order form posts the chosen plan id in the `service` field (`phone`, `amount`,
  `email` are the other fields — see `form` in the JSON).
- Category names are GSUBZ's own (emoji, spelling and casing as published).
- Synced on **2026-10-12**. GSUBZ changes prices often — re-pull before promising any
  price.

## Source and caveats

- The payload is ~2 MB, so it was pulled by a temporary GitHub Actions workflow that
  committed these files into `data/` (the workflow itself was removed after use — see
  git history), the same way `data/jumia-pickup-stations.json` was synced.
- `description` is GSUBZ's free text — usually an "Average time: …" line, sometimes with
  a trailing quantity note.
- Duplicate-looking plan names across categories are normal: every `id` is a distinct
  service (server, refill policy and targeting differ).
- This is a snapshot of a third-party reseller's catalogue, not a guarantee — confirm
  on GSUBZ before a price is promised to a customer.
