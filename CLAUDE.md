# Bohn Ag Boundaries — project context

Phone PWA (iPhone, Safari "Add to Home Screen") for Bohn AgVentures, a farm in Saskatchewan. Draw or drive field boundaries and sloughs, see acres, export shapefiles. Plain HTML/CSS/JS ES modules, no build step. Map is Leaflet 1.9.4 (vendored in `vendor/leaflet/`).

## Decisions made with the owner (keep these)

- **Units: acres only.** No hectare toggle.
- **Every project has a field name and a crop year.** Both go into export file names (`Name_2026.zip`) and attributes.
- **Theme: dark.** Near-black olive glass panels (`--panel: rgba(20,22,12,0.93)`), black borders, yellow accent `#f5d33a` for field boundaries, cyan `#5fc8f0` for sloughs, blue `#4da3ff` for GPS. Layout copied from the owner's LiDAR tool: square 60 px buttons down the left rail (Bohn Ag logo button on top, locate, layers…), icon-over-label toolbar along the bottom, area chip top right.
- **Sloughs are cut out of the field**: net = gross − sloughs. A slough counts against the smallest field that contains it.
- **Split fields** are supported (split tool cuts a field along a line into two fields).
- **GPS drive mode:**
  - Driving line (blue + white dots) = raw GPS fixes only, straight segments, no smoothing.
  - Boundary line (yellow) = smoothed and offset. Hermite curve through the fixes using each fix's GPS heading/speed, to fill in what 1 Hz misses at speed. It deliberately lags 1–2 fixes behind the truck (the curve into a fix needs the direction you leave it in).
  - Offset setting in feet, Left / Off / Right of travel direction, so the vehicle doesn't have to be on the boundary. Changeable during the drive and afterwards (raw fixes are stored with the boundary and it is rebuilt).
  - **No corner-squaring feature.** The owner asked to remove it: rounded corners match what the air seeder actually covers, so they are realistic. Don't add it back.
- **Export:** zipped shapefile (.shp/.shx/.dbf/.prj/.cpg), WGS 84 or NAD83 / UTM zone (auto-picked, zone 13N around Regina). Option: sloughs as holes (default) or separate shapes; optional corner-points layer. DBF fields: NAME, PART, YEAR, TYPE (field/slough), ACRES. Also KML and GeoJSON.
- **Import:** zipped shapefile (WGS 84 or UTM .prj), KML, GeoJSON.

## Hardware / platform facts

- Owner has a Dual XGPS160 Bluetooth GPS (10 Hz capable). In an iPhone PWA, Safari only delivers ~1 fix/second regardless; the XGPS160 still improves accuracy through iOS location services. Full 10 Hz would need a native app. Design everything to work well at 1 Hz.
- iOS stops web-app location updates when the screen locks; the app requests a screen wake lock and saves an in-progress drive every few seconds so it can be resumed.

## Status

First working version done and tested (see README). The owner has UI changes in mind and will describe them; ask rather than guess. Design mockups were made on a Claude design canvas ("Field Boundary App Screens") — the built app follows them.

## Working on it

- Run: `python3 -m http.server 8000` in this folder, open http://localhost:8000. Add `?sim` (or `?sim=fast`) to replay a simulated 40 km/h, 1 Hz drive around wherever the map is centred.
- On the owner's Windows laptop it's `py -m http.server 8000` (`.claude/launch.json` has it). Node is not installed there.
- Tests: `node tests/geo.test.js` (acres vs a quarter section, smoothing at 20/40/60 km/h, split, UTM, shapefile round-trip). Keep them passing. Without Node, run them in a browser on the local server: `await import('/tests/geo.test.js')` in the console prints the same PASS/FAIL lines.
- Area math is ellipsoidal (WGS84); verified against pyproj Geod to 0.001 ac. Don't swap in a spherical formula — it was 0.2% off.
- Bump `VERSION` in `sw.js` when shipping changes so installed phones pick them up.
- Data is in localStorage keys `bab.projects.v1`, `bab.drive.v1`, `bab.prefs.v1`. Don't change the shape without a migration.

## Files

- `index.html`, `css/app.css` — screens, sheets, theme
- `js/app.js` — UI, editing tools, drive mode, export/import wiring
- `js/geo.js` — area, smoothing + offset (`buildBoundary`), split, UTM
- `js/shapefile.js`, `js/zip.js`, `js/formats.js` — file formats, acre totals
- `js/sim.js` — GPS simulator
- `sw.js`, `manifest.webmanifest`, `icons/` — offline + install
