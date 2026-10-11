# Jumia Nigeria pickup stations

A snapshot of Jumia's Nigerian **pickup stations** (the collection points shoppers pick at
checkout instead of a home delivery), used by the store to offer a pickup option.

| File | What it is |
|---|---|
| `jumia-pickup-stations.json` | All stations as JSON: `id`, `name`, `state`, `address`, `landmark`, `latitude`, `longitude`, `is_active` |
| `jumia-pickup-stations.csv` | The same rows as a spreadsheet-friendly CSV (header: `id,name,state,address,landmark,latitude,longitude,active` where active is `yes`/`no`) |
| `jumia-pickup-stations-summary.json` | Station counts per state (`state`, `stations`, `active`) |

## Snapshot

- **451 stations** across **34 states + the Federal Capital Territory**.
- Largest networks: Lagos (74), Delta (36), Ogun (35), Oyo (30), FCT (28), Rivers (28), Edo (23).
- **No stations in this snapshot** for Jigawa, Taraba and Zamfara.
- Every row has a unique id and name, and coordinates inside Nigeria's bounding box.
- Source rows were last updated at the source on 2026-08-24 and pulled on 2026-10-11.

## Source and caveats

- The data originates from **Jumia's own location data** (the pickup-station list behind their
  checkout). It is read through a third-party mirror that re-syncs daily, not from an
  official Jumia API or dataset — treat it as a good snapshot, not a guarantee.
- Station names, addresses and landmarks are **as published by Jumia** (typos included);
  `landmark` is Jumia's own "close to …" hint and is sometimes empty in other snapshots.
- Coordinates are Jumia's; a few are approximate.
- Jumia opens and closes stations regularly and the state naming here is Jumia's
  (`Federal Capital Territory` rather than `FCT - Abuja`), so match states by their
  `data/ng-locations.json` names when comparing.
- Re-check before using this for anything a customer is promised (e.g. confirm the station
  is still open on Jumia's site: <https://www.jumia.com.ng/sp-pickup-stations/>).
