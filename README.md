# DoodleSim — Doodle Labs RF Link Planner

Interactive GIS-style planning tool for Doodle Labs Mesh Rider networks: place radios on a map,
pick antennas from a verified catalog, and get terrain-aware link-budget analysis (LOS,
Fresnel-zone clearance, knife-edge diffraction, per-MCS throughput estimates).

## Status

**Milestone 1 (link planner) — working scaffold.**
- MapLibre map (OSM / Esri satellite + hillshade), click-to-place draggable nodes
- Per-node config: radio model, band, frequency, bandwidth, TX power, antenna (verified catalog or custom gain), height AGL, cable loss, BDA gain, platform type (mast / UAV / UGV / vessel / vehicle / handheld)
- Links between nodes with terrain profile (AWS Terrarium elevation tiles, no API key), 4/3-earth curvature, 60% first-Fresnel clearance check, ITU-R P.526 single knife-edge diffraction
- Link budget validated against the official Doodle Labs Range Estimation Tool (FSPL mode reproduced exactly)
- Terrain profile viewer with Fresnel ellipse

**Next:** coverage heatmap (Milestone 2), OSM building clutter, saved/shareable projects (Cloudflare).

## Data

- `data/radios.json` — Doodle Labs radio catalog scraped from public datasheets (per-MCS sensitivity tables)
- `data/range_estimator.json` — model tables + reverse-engineered math from the official range estimator (conservative, sales-safe numbers; the app uses these)
- `data/antennas_app.json` — 53 third-party antennas verified against manufacturer datasheets
- `data/verification_report.md` — row-by-row verification of the source antenna spreadsheet (90 rows)

## Develop

```bash
npm install
npm run dev
```

## Deploy

Cloudflare (static build via Vite):

```bash
npm run build
npx wrangler deploy
```
