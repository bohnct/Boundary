# Bohn Ag Boundaries

A phone web app (PWA) for drawing or driving field boundaries and obstacles (sloughs, tree bluffs, yards), seeing acres, and exporting shapefiles.

## What it does

- **Projects** — one per field and crop year (field name + year). Saved on the device.
- **Rail buttons** (left): projects, locate, view settings (eye: Day / Night / Auto theme and map layer: Satellite or None — plain black), edit, record. Tap the acres card (top right) for the field data list.
- **Map editor** — tap the pencil to show the tools along the bottom:
  - **Boundary** / **Obstacle**: tap corners, then Done.
  - **Move**: tap a boundary, drag its white points.
  - **Add pt**: tap a + point halfway along an edge to add a corner.
  - **Remove**: tap a red × point to delete that corner.
  - **Split**: tap a field, then two points on opposite sides of it.
  - Undo button on the left rail while editing.
  - With a keyboard (PC, iPad): Esc cancels / closes, Ctrl+Z (Cmd+Z) undoes.
- Works on iPhone, iPad (either orientation) and in a desktop browser.
- **Drive with GPS** (record button on the rail):
  - Blue line = raw GPS fixes only, joined by straight lines.
  - Yellow line = smoothed boundary, shifted by the offset (feet, left/right of travel). It trails a fix or two behind the truck because the curve into a point needs the direction you leave it in.
  - Smoothing uses each fix's heading and speed (Hermite curves), so 1 Hz fixes at speed don't cut corners. Rounded corners are kept, matching what the seeder does.
  - Raw fixes are kept with the boundary, so the offset can be changed after the drive (⋯ on the boundary in the list).
  - A drive in progress is saved every few seconds and offered for resume if the app is closed.
- **Acres** — gross, obstacle and net per field and for the project. Obstacles count against the smallest field that contains them.
- **Export** — zipped shapefile (WGS 84 or NAD83 / UTM zone), KML or GeoJSON. Obstacles cut out as holes, or as separate shapes. Optional corner-points layer. Attributes: NAME, PART, YEAR, TYPE (field/obstacle), ACRES.
- **Import** — zipped shapefile (WGS 84 or UTM), KML, GeoJSON.

## Run it on a laptop

```
cd boundary-app
python3 -m http.server 8000
```

Open http://localhost:8000. Add `?sim` to the address to replay a simulated drive at 40 km/h, 1 Hz (`?sim=fast` plays it 10x quicker). The simulated loop is centred wherever the map is when you start the drive.

## Put it on the iPhone

A PWA has to be served over HTTPS. The simplest free option is GitHub Pages:

1. Create a GitHub repository and upload the contents of this folder (`index.html` at the top level).
2. In the repo: Settings → Pages → Deploy from branch → `main` / root.
3. Open the `https://<you>.github.io/<repo>/` address in Safari on the iPhone.
4. Share → Add to Home Screen.

After that it opens full screen like an app and works offline (map tiles you have viewed are cached).

## Notes and limits

- iPhone Safari passes GPS to web apps about once a second, even with the XGPS160 connected. The XGPS160 still improves accuracy.
- Keep the app on screen while recording; iOS stops location updates to web apps when the screen locks or you switch away. The app asks the phone to keep the screen awake.
- Data lives in the browser on that device. Export to keep a copy.
- UTM export uses NAD83; coordinates recorded from GPS are WGS 84 (about 1 m difference here), which is normal for farm GIS work.

## Tests

```
node tests/geo.test.js
```

Checks acres, smoothing at 20/40/60 km/h, splitting, UTM conversion and shapefile round trips.

## Files

- `index.html`, `css/app.css` — screens and theme
- `js/app.js` — UI, editing, drive mode, export/import wiring
- `js/geo.js` — area, smoothing, offset, split, UTM
- `js/shapefile.js`, `js/zip.js`, `js/formats.js` — shapefile/KML/GeoJSON read and write
- `js/sim.js` — GPS simulator for testing
- `sw.js`, `manifest.webmanifest`, `icons/` — offline + install
- `vendor/leaflet/` — map library (Leaflet 1.9.4)
