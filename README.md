# SSI Match Finder

A static web frontend for browsing [Shoot'N Score It](https://shootnscoreit.com) matches on a map or in a sortable table. Hosted on GitHub Pages, updated automatically every 6 hours via GitHub Actions.

## Features

- **Map view** – Leaflet.js map with marker clustering. Markers are placed from API coordinates or geocoded via OpenStreetMap (Nominatim) when the match has no geotag.
- **Table view** – Sortable, filterable table with toggleable columns. Default columns: Date, Match, Club, Discipline, Region, Registration, Participants, SSI Link.
- **Click-to-filter** – Click any Club, Discipline, Level, Country, Region, or Registration cell in the table to instantly filter by that value. Active filters are highlighted; click again to clear.
- **Region column** – Displays the county/region of each match (e.g. Norwegian fylke or Swedish län). Filterable via sidebar or cell click.
- **Participants column** – Shows registered / max spots (e.g. `12 / 20`). Cells turn amber (≥ 60 % full) or red (≥ 90 % full). Waiting-list entries appear as `+N` in red. Hover for a plain-text explanation.
- **Level filter** – Filter by match level (Club, Regional, Level I / II / III, etc.) alongside the discipline filter.
- **Shareable links** – All filters and column state are encoded in the URL so views can be bookmarked or shared.
- **Three themes** – Light, dark, and Gruvbox; cycles via the button in the top-right corner.

## Setup

### 1. Fork / clone this repo

```bash
git clone https://github.com/your-username/SSI-matchfinder.git
cd SSI-matchfinder
```

### 2. Add secrets and variables in GitHub

Go to **Settings → Secrets and variables → Actions** and create:

| Type | Name | Value |
|------|------|-------|
| Secret | `SSI_REFRESH_TOKEN` | Your SSI refresh token (used to obtain a short-lived JWT) |
| Secret | `SSI_API_KEY` | Your SSI API key |
| Variable | `SSI_COUNTRIES` | Comma-separated ISO-3 country codes to fetch, e.g. `NOR,SWE` |

### 3. Enable GitHub Pages

1. Go to **Settings → Pages**.
2. Set **Source** to `Deploy from a branch`, branch `main`, folder `/docs`.

The workflow runs every 6 hours and pushes updated data; Pages re-deploys automatically.

Each run fetches **3 months of past events** and **12 months of upcoming events** in 3-day chunks to stay under the SSI API's per-query result cap (~100 events).

### 4. Test locally

```bash
# Fetch live data (Python 3.10+)
SSI_REFRESH_TOKEN=your_token SSI_API_KEY=your_key SSI_COUNTRIES=NOR,SWE python3 scripts/fetch-matches.py

# Serve the frontend
python3 -m http.server 8000 --directory docs
# → open http://localhost:8000
```

## Organizer geocoding

When a match doesn't include coordinates, the fetch script resolves a location in this priority order:

1. `data/manual-coords.json` — hand-curated overrides, always wins
2. `data/organizer-geocache.json` — Nominatim forward-geocode cache (organizer name → lat/lng)
3. `data/reverse-geocache.json` — Nominatim reverse-geocode cache (lat/lng → country + county/region)

**Manual overrides** – pin any organizer to a fixed location by adding an entry to `data/manual-coords.json`:

```json
{
  "bergen pistolklubb": { "lat": 60.3929, "lng": 5.3241 }
}
```

The key is the organizer name in lowercase. `data/organizer-geocache.json` is committed to the repo and updated by the Actions workflow when new organizers are geocoded automatically.

The fetch script also reverse-geocodes each match's coordinates to populate a `county` field (Norwegian fylke or Swedish län), which is displayed as the **Region** column and used by the region filter.

## Project structure

```
.github/workflows/refresh.yml   GitHub Actions cron job (every 6 h)
data/manual-coords.json         highest-priority coordinate overrides (~135 NOR/SWE clubs)
data/organizer-geocache.json    Nominatim forward-geocode cache
data/reverse-geocache.json      Nominatim reverse-geocode cache (lat/lng → country + county)
docs/                           GitHub Pages root
  data/matches.json             generated match data (committed by Actions)
  index.html                    single-page app
  app.js                        frontend logic
  style.css                     styles (light / dark / gruvbox themes)
scripts/fetch-matches.js        data pipeline (Node.js 20+, used by Actions)
scripts/fetch-matches.py        data pipeline (Python 3.10+, for local use)
```

## URL filter reference

| Param        | Example                   | Description                               |
|--------------|---------------------------|-------------------------------------------|
| `view`       | `map` / `table`           | Active view                               |
| `q`          | `oslo`                    | Text search (name, club, city)            |
| `discipline` | `IPSC Handgun,IPSC Rifle` | Comma-separated disciplines               |
| `level`      | `Level II,Regional`       | Comma-separated match levels              |
| `countries`  | `NOR,SWE`                 | Comma-separated ISO-3 country codes       |
| `region`     | `Viken,Trøndelag`         | Comma-separated Norwegian/Swedish regions |
| `organizer`  | `bergen pistolklubb`      | Comma-separated organizer names           |
| `regOpen`    | `1`                       | `1` = show only matches with open registration |
| `from`       | `2026-08-01`              | Earliest match date (ISO 8601)            |
| `to`         | `2026-12-31`              | Latest match date (ISO 8601)              |
| `cols`       | `date,name,organizer`     | Visible table columns                     |
| `sort`       | `date`                    | Sort column key                           |
| `dir`        | `asc` / `desc`            | Sort direction                            |

## Contributing

Pull requests are welcome! The most common contribution needed is **fixing wrong or missing club coordinates**. If a match appears in the wrong location on the map, you can correct it by editing `data/manual-coords.json`:

```json
{
  "club name in lowercase": { "lat": 59.9139, "lng": 10.7522 }
}
```

This file takes the highest priority — it overrides both the API coordinates and the Nominatim geocache. Open a PR with your correction and a brief note on how you verified the coordinates (e.g. club website, Google Maps).
