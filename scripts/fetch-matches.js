#!/usr/bin/env node
/**
 * Fetch matches from the SSI GraphQL API, geocode missing locations,
 * and write docs/data/matches.json.
 *
 * Usage:
 *   node scripts/fetch-matches.js
 *   node scripts/fetch-matches.js --dump   # print raw data and exit
 *
 * Requires SSI_REFRESH_TOKEN in environment / GitHub Actions secret.
 * Requires Node.js 18+ (native fetch).
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

// ─── ENV FILE ────────────────────────────────────────────────────────────────
// Load .env for local development. Real env vars (e.g. GitHub Actions secrets)
// always take precedence — .env values are only applied when the key is absent.

const envPath = resolve(ROOT, '.env');
if (existsSync(envPath)) {
  readFileSync(envPath, 'utf8').split('\n').forEach(line => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return;
    const eq = trimmed.indexOf('=');
    if (eq === -1) return;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    if (key && !(key in process.env)) process.env[key] = val;
  });
}

// ─── CONFIG ──────────────────────────────────────────────────────────────────
// Adjust these once you have inspected the raw API response via --dump.

const REFRESH_TOKEN = process.env.SSI_REFRESH_TOKEN;
if (!REFRESH_TOKEN) {
  console.error('Error: SSI_REFRESH_TOKEN environment variable is not set.');
  console.error('Run: python scripts/get_refresh_token.py  then add the value to .env');
  process.exit(1);
}

const API_KEY = process.env.SSI_API_KEY;
if (!API_KEY) {
  console.error('Error: SSI_API_KEY environment variable is not set.');
  process.exit(1);
}

const GQL_ENDPOINT = 'https://shootnscoreit.com/graphql/';

/** Days of past matches to include (0 = upcoming only). */
const LOOKBACK_DAYS = 7;

/** Days ahead to fetch. */
const LOOKAHEAD_DAYS = 365;

// Comma-separated ISO-3 country codes, e.g. "NOR,SWE". Empty = all countries.
const _countriesEnv = process.env.SSI_COUNTRIES ?? '';
const COUNTRIES = new Set(_countriesEnv.split(',').map(c => c.trim().toUpperCase()).filter(Boolean));

const NOMINATIM_BASE = 'https://nominatim.openstreetmap.org/search';
/** Nominatim usage policy: max 1 req/s. Keep this >= 1200 ms. */
const NOMINATIM_DELAY_MS = 1250;

// ─── PATHS ───────────────────────────────────────────────────────────────────

const GEOCACHE_PATH = resolve(ROOT, 'data', 'organizer-geocache.json');
const MANUAL_COORDS_PATH = resolve(ROOT, 'data', 'manual-coords.json');
const EXTRA_IDS_PATH = resolve(ROOT, 'data', 'extra-event-ids.json');
const OUTPUT_PATH   = resolve(ROOT, 'docs', 'data', 'matches.json');

// ISO 3166-1 alpha-3 → alpha-2 for Nominatim's countrycodes param
const ISO3_TO_2 = {
  NOR: 'no', SWE: 'se', FIN: 'fi', DNK: 'dk', NLD: 'nl',
  AUS: 'au', ZAF: 'za', EST: 'ee', DEU: 'de', GBR: 'gb',
  FRA: 'fr', ESP: 'es', ITA: 'it', POL: 'pl', USA: 'us',
  CAN: 'ca', NZL: 'nz', LTU: 'lt', LVA: 'lv', SVN: 'si',
  HRV: 'hr', ROU: 'ro', AUT: 'at', CHE: 'ch', BEL: 'be',
};

// Bounding boxes [lat_min, lat_max, lng_min, lng_max] for country-less events
const COUNTRY_BBOX = {
  NOR: [57.0, 71.5,  4.0, 31.5],
  SWE: [55.0, 69.5, 10.0, 24.5],
  FIN: [59.5, 70.5, 19.0, 31.5],
  DNK: [54.5, 57.8,  8.0, 15.5],
  AUS: [-44.0, -10.0, 112.0, 154.0],
  NZL: [-47.5, -34.0, 166.0, 178.5],
  ZAF: [-35.0, -22.0,  16.5,  33.0],
  GBR: [49.5,  61.0,  -8.0,   2.0],
  IRL: [51.0,  55.5, -10.5,  -5.5],
  DEU: [47.0,  55.5,   5.5,  15.0],
  NLD: [50.5,  53.7,   3.0,   7.5],
  BEL: [49.5,  51.5,   2.5,   6.5],
  FRA: [41.0,  51.5,  -5.5,   9.5],
  ESP: [35.5,  43.8,  -9.5,   4.5],
  POL: [49.0,  55.0,  14.0,  24.5],
  EST: [57.5,  59.7,  21.5,  28.5],
  LVA: [55.5,  58.2,  20.5,  28.5],
  LTU: [53.5,  56.5,  20.5,  27.0],
  AUT: [46.5,  49.0,   9.5,  17.5],
  CHE: [45.5,  48.0,   5.5,  10.5],
  HRV: [42.0,  46.5,  13.0,  19.5],
  SVN: [45.5,  47.0,  13.0,  16.5],
  ROU: [43.5,  48.5,  21.5,  30.0],
  USA: [24.0,  71.5, -168.0, -66.0],
  CAN: [41.5,  83.5, -141.0, -52.0],
};

// ─── UTILITIES ───────────────────────────────────────────────────────────────

function loadJson(path, fallback) {
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch { return fallback; }
}

function sleep(ms) {
  return new Promise(res => setTimeout(res, ms));
}

async function postGql(query, variables, auth, apiKey) {
  const res = await fetch(GQL_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept':       'application/json',
      ...(auth   ? { Authorization: auth }      : {}),
      ...(apiKey ? { 'x-api-key':   apiKey }    : {}),
    },
    body: JSON.stringify({ query, ...(variables ? { variables } : {}) }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status} ${res.statusText} → ${GQL_ENDPOINT}\n${body.slice(0, 300)}`);
  }
  return res.json();
}

async function getJson(url, headers = {}) {
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} → ${url}`);
  return res.json();
}

// ─── GRAPHQL AUTH + EVENTS ───────────────────────────────────────────────────

const REFRESH_Q = `
  mutation Refresh($rt: String!) {
    refresh_token(refresh_token: $rt, revoke_refresh_token: false) {
      success
      errors
      token { token }
    }
  }
`;

async function getJwt() {
  const data = await postGql(REFRESH_Q, { rt: REFRESH_TOKEN });
  if (data.errors) {
    console.error('Auth error:', data.errors.map(e => e.message));
    process.exit(1);
  }
  const d = data.data.refresh_token;
  if (!d.success) {
    console.error('Auth failed:', d.errors);
    process.exit(1);
  }
  return d.token.token;
}

const EVENTS_Q = `
  query GetEvents($after: String!, $before: String!) {
    events(starts_after: $after, starts_before: $before) {
      ... on EventInterface {
        id name starts ends rule sub_rule
        venue lat lng
        registration registration_starts registration_closes is_registration_possible
        competitors_count max_competitors number_of_mainmatch_competitors_waiting
        get_content_type_key get_full_rule_display get_full_level_display
        organizer { name city country lat lng }
      }
    }
  }
`;

const EVENT_Q = `
  query GetEvent($ct: Int!, $id: String!) {
    event(content_type: $ct, id: $id) {
      id name starts ends rule sub_rule
      venue lat lng
      registration registration_starts registration_closes is_registration_possible
      competitors_count max_competitors number_of_mainmatch_competitors_waiting
      get_content_type_key get_full_rule_display get_full_level_display
      organizer { name city country lat lng }
    }
  }
`;

async function fetchAllMatches() {
  console.log('Authenticating via refresh token...');
  const jwt = await getJwt();
  let auth = `JWT ${jwt}`;

  const today = new Date();
  const from  = new Date(today); from.setDate(from.getDate() - LOOKBACK_DAYS);
  const to    = new Date(today); to.setDate(to.getDate() + LOOKAHEAD_DAYS);

  const variables = {
    after:  from.toISOString().slice(0, 10),
    before: to.toISOString().slice(0, 10),
  };

  console.log('Fetching events from SSI GraphQL API...');
  let result = await postGql(EVENTS_Q, variables, auth, API_KEY);

  // Fall back to Bearer prefix if JWT prefix is not recognised
  if (result.errors) {
    const msgs = result.errors.map(e => e.message);
    if (msgs.some(m => m.toLowerCase().includes('authenticated'))) {
      auth   = `Bearer ${jwt}`;
      result = await postGql(EVENTS_Q, variables, auth, API_KEY);
    }
    if (result.errors) {
      console.error('Events query errors:', result.errors.map(e => e.message));
      process.exit(1);
    }
  }

  const events = result.data.events;
  console.log(`Fetched ${events.length} events`);

  // Fetch extra events not returned by the list query (e.g. those with organizer=null)
  const extraIds = loadJson(EXTRA_IDS_PATH, []);
  if (extraIds.length > 0) {
    const existingIds = new Set(events.map(e => String(e.id)));
    console.log(`Fetching ${extraIds.length} extra event(s) by ID...`);
    for (const entry of extraIds) {
      const eid = String(entry.id);
      if (existingIds.has(eid)) continue;
      const r = await postGql(EVENT_Q, { ct: entry.content_type, id: eid }, auth, API_KEY);
      if (r.errors || !r.data?.event) {
        console.warn(`  Warning: could not fetch extra event ${eid}`);
        continue;
      }
      const ev = r.data.event;
      if (ev.organizer == null) {
        ev.organizer = {};
      }
      events.push(ev);
      console.log(`  Added extra event ${eid}: ${ev.name ?? ''}`);
    }
  }

  return events;
}

function normalizeMatch(raw) {
  const org = raw.organizer || {};
  const lat = raw.lat != null ? raw.lat : org.lat;
  const lng = raw.lng != null ? raw.lng : org.lng;
  return {
    id:                   String(raw.id ?? ''),
    name:                 raw.name ?? '',
    date:                 (raw.starts  ?? '').slice(0, 10),
    endDate:              (raw.ends    ?? '').slice(0, 10),
    organizer:            org.name    ?? '',
    discipline:           raw.get_full_rule_display || raw.rule || '',
    level:                raw.get_full_level_display ?? '',
    country:              org.country ?? '',
    city:                 org.city    ?? '',
    venue:                raw.venue   ?? '',
    lat:                  lat != null ? parseFloat(lat) : null,
    lng:                  lng != null ? parseFloat(lng) : null,
    registrationOpen:     raw.is_registration_possible ?? null,
    registrationStarts:   (raw.registration_starts ?? '').slice(0, 10),
    registrationDeadline: (raw.registration_closes  ?? '').slice(0, 10),
    participants:         raw.competitors_count ?? null,
    maxParticipants:      raw.max_competitors ?? null,  // 0 = unlimited
    waitingCount:         raw.number_of_mainmatch_competitors_waiting ?? null,
    url:                  (raw.get_content_type_key && raw.id)
                            ? `https://shootnscoreit.com/event/${raw.get_content_type_key}/${raw.id}/`
                            : '',
    geocodeSource:        lat != null ? 'api' : 'pending',
  };
}

// ─── GEOCODING ───────────────────────────────────────────────────────────────

async function geocodeOrganizer(name, country, cache, manual) {
  const key = name.toLowerCase().trim();

  // 1. Manual override
  if (key in manual) {
    const m = manual[key];
    if (m.lat != null) return { lat: m.lat, lng: m.lng, source: 'manual' };
    return null;
  }

  // 2. Geocache (includes cached failures stored as {lat:null})
  if (key in cache) {
    if (cache[key].lat == null) return null;
    return { lat: cache[key].lat, lng: cache[key].lng, source: 'cache' };
  }

  // 3. Nominatim — use countrycodes param for better accuracy
  const cc = ISO3_TO_2[country?.toUpperCase()] ?? '';
  const params = cc
    ? new URLSearchParams({ q: name, countrycodes: cc, format: 'json', limit: '1' })
    : new URLSearchParams({ q: [name, country].filter(Boolean).join(', '), format: 'json', limit: '1' });

  console.log(`  Geocoding: "${name}" (${country})`);
  await sleep(NOMINATIM_DELAY_MS);

  try {
    const results = await getJson(`${NOMINATIM_BASE}?${params}`, {
      'User-Agent': 'SSI-MatchFinder/1.0 (https://github.com/your-username/SSI-matchfinder)',
    });

    if (results.length > 0) {
      const { lat, lon, display_name } = results[0];
      const entry = { lat: parseFloat(lat), lng: parseFloat(lon), display: display_name };
      cache[key]  = entry;
      return { ...entry, source: 'nominatim' };
    }
  } catch (err) {
    console.warn(`  Geocoding failed for "${name}": ${err.message}`);
  }

  // Cache the failure so we don’t retry on future runs
  cache[key] = { lat: null, lng: null };
  return null;
}

async function enrichWithCoordinates(matches, cache) {
  const manual = loadJson(MANUAL_COORDS_PATH, {});
  let nominatimHits = 0;

  for (const match of matches) {
    if (match.lat != null && match.lng != null) {
      match.geocodeSource = 'api';
      continue;
    }

    if (!match.organizer) {
      match.geocodeSource = 'unknown';
      continue;
    }

    const result = await geocodeOrganizer(match.organizer, match.country, cache, manual);
    if (result) {
      match.lat          = result.lat;
      match.lng          = result.lng;
      match.geocodeSource = result.source;
      if (result.source === 'nominatim') nominatimHits++;
    } else {
      match.geocodeSource = 'unknown';
    }
  }

  if (nominatimHits > 0) {
    console.log(`Geocoded ${nominatimHits} new organizers via Nominatim`);
  }
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────

async function main() {
  const dump = process.argv.includes('--dump');

  console.log('Fetching events...');
  const raw = await fetchAllMatches();

  if (dump) {
    console.log('\n--- RAW API RESPONSE (first 3 events) ---');
    console.log(JSON.stringify(raw.slice(0, 3), null, 2));
    console.log('\nTotal fields in first event:', raw[0] ? Object.keys(raw[0]).join(', ') : 'n/a');
    process.exit(0);
  }

  const geocache = loadJson(GEOCACHE_PATH, {});
  let matches  = raw.map(normalizeMatch);

  if (COUNTRIES.size > 0) {
    const before = matches.length;
    // Pass-through events whose country is unknown (null organizer) if their
    // coordinates fall within any of the requested countries' bounding boxes.
    const inAnyBbox = m => {
      const { lat, lng } = m;
      if (lat == null || lng == null) return false;
      for (const c of COUNTRIES) {
        const bb = COUNTRY_BBOX[c];
        if (bb && lat >= bb[0] && lat <= bb[1] && lng >= bb[2] && lng <= bb[3]) return true;
      }
      return false;
    };
    matches = matches.filter(m =>
      COUNTRIES.has(m.country.toUpperCase()) ||
      (!m.country && inAnyBbox(m))
    );
    console.log(`Country filter (${[...COUNTRIES].sort().join(', ')}): ${matches.length} of ${before} kept`);
  }

  await enrichWithCoordinates(matches, geocache);

  // Persist any new geocache entries
  writeFileSync(GEOCACHE_PATH, JSON.stringify(geocache, null, 2) + '\n', 'utf8');

  const output = {
    generated: new Date().toISOString(),
    count: matches.length,
    matches,
  };

  mkdirSync(resolve(ROOT, 'docs', 'data'), { recursive: true });
  writeFileSync(OUTPUT_PATH, JSON.stringify(output, null, 2) + '\n', 'utf8');

  const located  = matches.filter(m => m.lat != null).length;
  const unknown  = matches.filter(m => m.geocodeSource === 'unknown').length;
  console.log(
    `Written ${matches.length} matches → ${located} with coordinates, ${unknown} without`
  );
  const missing = [...new Set(
    matches.filter(m => m.geocodeSource === 'unknown' && m.organizer).map(m => m.organizer)
  )].sort();
  if (missing.length > 0) {
    console.log(`\n${missing.length} clubs still missing coordinates.`);
    console.log('Add entries to data/manual-coords.json to fix them:');
    for (const org of missing) {
      console.log(`  "${org.toLowerCase()}": {"lat": 0, "lng": 0},`);
    }
  }}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
