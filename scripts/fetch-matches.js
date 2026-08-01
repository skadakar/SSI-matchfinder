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
import { fileURLToPath, pathToFileURL } from 'url';

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
// Presence is validated lazily in the CLI-entry guard at the bottom of this
// file (not at module load time), so this module can be imported by tests
// without these being set.
const REFRESH_TOKEN = process.env.SSI_REFRESH_TOKEN;
const API_KEY = process.env.SSI_API_KEY;

const GQL_ENDPOINT = 'https://shootnscoreit.com/graphql/';

/** Days of past matches to include (0 = upcoming only). */
const LOOKBACK_DAYS = 60;

/** Days ahead to fetch. */
const LOOKAHEAD_DAYS = 365;

// Comma-separated ISO-3 country codes, e.g. "NOR,SWE". Empty = all countries.
const _countriesEnv = process.env.SSI_COUNTRIES ?? '';
const COUNTRIES = new Set(_countriesEnv.split(',').map(c => c.trim().toUpperCase()).filter(Boolean));

const NOMINATIM_BASE = 'https://nominatim.openstreetmap.org/search';
/** Nominatim usage policy: max 1 req/s. Keep this >= 1200 ms in production.
 * Overridable via env (e.g. NOMINATIM_DELAY_MS=0) so tests don't have to
 * wait on the real rate-limit delay. */
const NOMINATIM_DELAY_MS = process.env.NOMINATIM_DELAY_MS !== undefined
  ? Number(process.env.NOMINATIM_DELAY_MS)
  : 1250;

// ─── PATHS ───────────────────────────────────────────────────────────────────

const GEOCACHE_PATH = resolve(ROOT, 'data', 'organizer-geocache.json');
const MANUAL_COORDS_PATH = resolve(ROOT, 'data', 'manual-coords.json');
const REV_GEOCACHE_PATH = resolve(ROOT, 'data', 'reverse-geocache.json');
const OUTPUT_PATH   = resolve(ROOT, 'docs', 'data', 'matches.json');

// ISO 3166-1 alpha-3 → alpha-2 for Nominatim's countrycodes param
const ISO3_TO_2 = {
  NOR: 'no', SWE: 'se', FIN: 'fi', DNK: 'dk', NLD: 'nl',
  AUS: 'au', ZAF: 'za', EST: 'ee', DEU: 'de', GBR: 'gb',
  FRA: 'fr', ESP: 'es', ITA: 'it', POL: 'pl', USA: 'us',
  CAN: 'ca', NZL: 'nz', LTU: 'lt', LVA: 'lv', SVN: 'si',
  HRV: 'hr', ROU: 'ro', AUT: 'at', CHE: 'ch', BEL: 'be',
};
// Reverse: ISO 2-letter → ISO 3-letter (for reverse geocoding responses)
const ISO2_TO_3 = Object.fromEntries(
  Object.entries(ISO3_TO_2).map(([k3, k2]) => [k2.toUpperCase(), k3])
);

// ─── UTILITIES ───────────────────────────────────────────────────────────────

function loadJson(path, fallback) {
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch { return fallback; }
}

function sleep(ms) {
  return new Promise(res => setTimeout(res, ms));
}

export async function postGql(query, variables, auth, apiKey) {
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

const EVENT_INTERFACE_FIELDS = `
  ... on EventInterface {
    id name starts ends rule
    venue lat lng region
    registration registration_starts registration_closes is_registration_possible
    competitors_count max_competitors number_of_mainmatch_competitors_registered number_of_mainmatch_competitors_waiting
    get_content_type_key get_full_rule_display get_full_level_display
    organizer { name city country lat lng }
  }
`;

// Per-match-type division fields, keyed by GraphQL type name. Fields are
// space-separated; buildEventsQuery() can drop individual field names (not
// just whole types) from a fallback query, so a type's other (safe) fields
// are still recovered when one specific field is known to crash — see
// RISKY_FIELDS and the KNOWN RISK comment below.
const DIVISION_FRAGMENTS = {
  // `divisions` is the raw underlying field (plain model attribute, so it
  // isn't subject to the misnamed-resolver crash below); it's queried
  // alongside get_division_display as a same-tier safety net, and is only
  // used by collectDivisions() when the display field didn't come back
  // (see KNOWN RISK below).
  SteelMatchNode:     'divisions get_division_display', // get_division_display: misnamed resolver, see KNOWN RISK below
  PpcMatchNode:       'get_weapon_classes_display',
  CmpMatchNode:       'get_rifle_divs_display get_rimfire_rifle_divs_display get_pistol_divs_display get_rimfire_pistol_divs_display',
  IdpaMatchNode:      'get_handgun_divs_display get_rifle_divs_display get_shotgun_divs_display get_dmg_divs_display',
  NordicMatchNode:    'get_weapon_groups_display',
  PrecisionMatchNode: 'get_divisions_display',
  GenericMatchNode:   'get_divisions_display',
  IpscMatchNode:      'get_divisions_display',
  // "Serie"/Cup events (a container aggregating several component matches,
  // e.g. a club's DMR Cup) are a DIFFERENT GraphQL type from the individual
  // match types above, and were previously not queried for divisions at all
  // — see the DIVISION_FIELDS comment block below.
  IpscSerieNode:      'get_serie_divisions_display',
  PrecisionSerieNode: 'get_divisions_display',
  NordicSerieNode:    'get_weapon_groups_display',
  PpcSerieNode:       'get_weapon_classes_display',
};

// Field names known to crash server-side for at least one real match (see
// KNOWN RISK below). Fallback queries drop only these specific fields
// rather than a whole type's fragment, so a type's other (safe) fields —
// e.g. Steel's raw `divisions` — are still recovered.
const RISKY_FIELDS = ['get_division_display'];

const ALL_DIVISION_FIELD_NAMES = Object.values(DIVISION_FRAGMENTS).flatMap(f => f.split(' '));

function buildEventsQuery(excludeFields = []) {
  const fragments = Object.entries(DIVISION_FRAGMENTS)
    .map(([type, fields]) => {
      const kept = fields.split(' ').filter(f => !excludeFields.includes(f));
      return kept.length ? `... on ${type} { ${kept.join(' ')} }` : null;
    })
    .filter(Boolean)
    .join('\n      ');
  return `
    query GetEvents($after: String!, $before: String!) {
      events(starts_after: $after, starts_before: $before) {
        ${EVENT_INTERFACE_FIELDS}
        ${fragments}
      }
    }
  `;
}

// Tiered queries, tried in order for each window: the full query first, then
// progressively stripped-down fallbacks if a resolver crash breaks it — see
// the KNOWN RISK comment on queryWindow's retry loop below.
const EVENTS_Q          = buildEventsQuery();
const EVENTS_Q_NO_RISKY = buildEventsQuery(RISKY_FIELDS);
const EVENTS_Q_MINIMAL  = buildEventsQuery(ALL_DIVISION_FIELD_NAMES);

export async function fetchAllMatches() {
  console.log('Authenticating via refresh token...');
  const jwt = await getJwt();
  let auth = `JWT ${jwt}`;

  const today = new Date();
  const todayStr = today.toISOString().slice(0, 10);
  const allEvents = new Map(); // id → event, deduplicated across chunks

  async function runQuery(query, variables) {
    let result = await postGql(query, variables, auth, API_KEY);
    if (result.errors) {
      const msgs = result.errors.map(e => e.message);
      if (msgs.some(m => m.toLowerCase().includes('authenticated'))) {
        auth   = `Bearer ${jwt}`;
        result = await postGql(query, variables, auth, API_KEY);
      }
    }
    return result;
  }

  // KNOWN RISK: some *MatchNode "*_display" resolvers crash server-side for
  // specific events (e.g. SteelMatchNode.get_division_display is misnamed in
  // SSI's own schema and throws "'SteelMatch' object has no attribute
  // 'get_division_display'" for at least one real match). Because GraphQL's
  // `events` field is non-null-of-non-null, a crash resolving ANY single
  // event's field nulls the *entire* events list for that query window, not
  // just the offending event — so a single bad match can silently make every
  // other match starting in that ~3-day window (any discipline) vanish from
  // the whole dataset, indefinitely (the same match keeps re-triggering the
  // crash every time its window is queried again, whether that's still the
  // "future" range or, once its date passes, the "past" lookback range).
  //
  // To limit the blast radius, each window is retried with progressively
  // reduced queries rather than giving up on the first error:
  //   1. EVENTS_Q          — full query, all per-type division fields.
  //   2. EVENTS_Q_NO_RISKY — drops just the known-crash-prone field(s)
  //      (currently only get_division_display), keeping every type's other
  //      (safe) fields — e.g. Steel's raw `divisions` field still comes
  //      back, so collectDivisions() can fall back to it (see below).
  //   3. EVENTS_Q_MINIMAL  — drops ALL division fields; recovers the
  //      window's events with no divisions data at all, in case the crash
  //      turns out to be caused by a different/new field.
  // Only if even the minimal query fails is the window truly skipped.
  async function queryWindow(after, before) {
    const variables = { after, before };
    const tiers = [
      { query: EVENTS_Q,          label: 'full query' },
      { query: EVENTS_Q_NO_RISKY, label: 'fallback query without known-crash-prone display fields (e.g. get_division_display)' },
      { query: EVENTS_Q_MINIMAL,  label: 'minimal fallback query without any division fields' },
    ];
    let lastMsgs = null;
    for (let i = 0; i < tiers.length; i++) {
      const result = await runQuery(tiers[i].query, variables);
      if (!result.errors) {
        if (i > 0) {
          console.warn(`Window ${after}..${before}: recovered via ${tiers[i].label} after earlier tier(s) errored.`);
        }
        return result.data.events ?? [];
      }
      const msgs = result.errors.map(e => e.message);
      // "not authenticated" errors are systemic (nothing will work without
      // valid auth) — abort the whole run rather than silently producing
      // an empty dataset.
      if (msgs.some(m => m.toLowerCase().includes('authenticated'))) {
        console.error('Events query errors:', msgs);
        process.exit(1);
      }
      lastMsgs = msgs;
    }
    // Every tier (including the minimal, division-free one) failed — this is
    // scoped to this one query window and skipped rather than aborting the
    // entire run over one bad window.
    console.warn(`Skipping window ${after}..${before} entirely — even the minimal query failed: ${lastMsgs.join('; ')}`);
    return [];
  }

  // 1. Upcoming events in 3-day chunks to stay under the API result cap (~100/query)
  console.log('Fetching events from SSI GraphQL API...');
  const lookAheadEnd = new Date(today); lookAheadEnd.setDate(lookAheadEnd.getDate() + LOOKAHEAD_DAYS);
  let futureChunkStart = new Date(today);
  let futureChunks = 0;
  while (futureChunkStart < lookAheadEnd) {
    const futureChunkEnd = new Date(Math.min(futureChunkStart.getTime() + 3 * 86400000, lookAheadEnd.getTime()));
    for (const ev of await queryWindow(futureChunkStart.toISOString().slice(0, 10), futureChunkEnd.toISOString().slice(0, 10))) {
      if (!allEvents.has(String(ev.id))) allEvents.set(String(ev.id), ev);
    }
    futureChunks++;
    futureChunkStart = futureChunkEnd;
  }
  console.log(`  Future ${LOOKAHEAD_DAYS}d (${futureChunks} 3-day chunks): ${allEvents.size} events`);

  // 2. Past events in 3-day chunks to stay under the API result cap (~100/query)
  const lookBackStart = new Date(today); lookBackStart.setDate(lookBackStart.getDate() - LOOKBACK_DAYS);
  let chunkEnd = new Date(today);
  let pastChunks = 0;
  while (chunkEnd > lookBackStart) {
    const chunkStart = new Date(Math.max(chunkEnd - 3 * 86400000, lookBackStart));
    for (const ev of await queryWindow(chunkStart.toISOString().slice(0, 10), chunkEnd.toISOString().slice(0, 10))) {
      if (!allEvents.has(String(ev.id))) allEvents.set(String(ev.id), ev);
    }
    pastChunks++;
    chunkEnd = chunkStart;
  }
  console.log(`  Past ${LOOKBACK_DAYS}d (${pastChunks} 3-day chunks): ${allEvents.size} unique events total`);

  const events = [...allEvents.values()];
  console.log(`Fetched ${events.length} events`);

  return events;
}

/** Return false for SSI's 'no location' sentinel (85.05, -180) and any
 * other geometrically impossible values. */
export function validCoords(lat, lng) {
  if (lat == null || lng == null) return false;
  return Math.abs(parseFloat(lng)) < 180 && Math.abs(parseFloat(lat)) <= 85;
}

// Split a single human-readable, comma-separated field (e.g.
// "Rimfire Open, Rimfire Iron, PCC Open") into a trimmed array.
export function parseDivisions(str) {
  if (!str) return [];
  return String(str).split(',').map(s => s.trim()).filter(Boolean);
}

// SSI models each match's discipline as a distinct GraphQL type (SteelMatchNode,
// IpscMatchNode, CmpMatchNode, ...), each exposing its own raw field(s) listing
// the equipment divisions the match supports (e.g. a Steel Challenge match
// offering "Rimfire Open, Rimfire Iron, PCC Open, ..."). These are a facet
// of one match (not multiple separate disciplines) — often reusing IPSC's own
// division names (Open, Standard, Production, Classic, Revolver, ...) even for
// non-IPSC disciplines — so they're merged into a single `divisions` array on
// the match rather than duplicating the match per division (which would also
// duplicate Discord notifications per match id).
//
// We query each type's "*_display" field (e.g. `get_divisions_display`,
// `get_handgun_divs_display`) rather than the underlying raw field
// (`divisions`, `handgun_divs`). The display resolvers return the actual
// human-readable names SSI shows on its own match pages, so no local
// code→label translation table is needed. (A hand-maintained table was
// tried earlier and repeatedly proved to be a maintenance trap: SSI uses
// multiple different internal code schemes for the same divisions across
// different events, so new unmapped codes kept surfacing every review
// round — see git history for the abandoned DIVISION_CODE_LABELS table.)
//
// KNOWN RISK: SteelMatchNode's display resolver (`get_division_display`) is
// misnamed in SSI's own schema (singular "division" despite the underlying
// field being plural `divisions`), which crashes server-side with
// "'SteelMatch' object has no attribute 'get_division_display'". Because
// GraphQL's `events` field is doubly non-null (`[EventInterface!]!`), a
// crash resolving ANY single event's field nulls the *entire* events list
// for that query window — there's no way to get partial per-event data back
// Rather than avoid the field forever (which would mean resurrecting a
// hardcoded Steel Challenge translation table), `queryWindow` retries a
// failing window with progressively reduced queries (see EVENTS_Q_NO_STEEL /
// EVENTS_Q_MINIMAL and the KNOWN RISK comment on queryWindow further down):
// dropping just the Steel fragment means the crashing resolver is never
// invoked, so every event in the window — including the Steel match that
// triggered the crash — still comes back; only the divisions for Steel
// matches in that window come back empty (`collectDivisions` simply gets
// `undefined` for the un-queried field, same as any match with no divisions
// configured). Only if that fallback also fails is the whole window skipped.
//
// Also note: IPSC's own `categories`/`get_categories_display` GraphQL field
// (SSI's own naming) is intentionally NOT included here — it's an unrelated
// demographic classification (Senior, Junior, Lady, ...), not an equipment
// division.
//
// IpscMatchNode: every PER-FIREARM field (handgun_divs, rifle_divs,
// mini_rifle_divs, prec_rifle_divs, shotgun_divs, air_divs, pcc_divs, and
// tournament_divisions — raw AND _display variants) was verified against
// multiple real IPSC matches with known live-page divisions and found to
// return WRONG data (a bloated near-constant superset of unrelated codes,
// or a static value identical across unrelated matches) — see git history
// (commits 973ed92, b7ca371, 586bd28) for the full evidence trail. Those
// fields are NOT queried.
//
// RESOLVED (2026-08-01, commit 21fd02e): IpscMatchNode also has a
// `get_divisions_display` field (no corresponding raw `divisions` field —
// likely a computed aggregate across all the per-firearm fields above,
// unlike its broken siblings). This one is CORRECT: verified live against
// 4 real matches with known live-page divisions —
//   event/22/26862: live page shows "Open, Standard, Standard Optics,
//     Optics, Production, Revolver, Classic, Production Optics" (8) —
//     get_divisions_display returned the exact same 8 values.
//   event/22/25845: live page shows 7 divisions — returned exactly 7
//     matching values (Open, Standard, Optics, Production, Revolver,
//     Classic, Production Optics).
//   event/22/28228: live page shows 17 divisions — returned exactly 17
//     matching values.
//   event/22/29250: an IPSC Rifle match — returned 4 rifle-specific values
//     (Semi-Auto Open, Semi-Auto Standard, Semi-Auto Limited, Manual Action
//     Bolt), not the bloated all-firearm-types superset the broken fields
//     returned for the same event.
// Across the full production dataset (726 events), 362 of 364 IPSC matches
// now get non-empty, correct divisions; the 2 remaining are a beginner
// clinic and a test match with no divisions configured at all (expected).
// `get_divisions_display` is already in DIVISION_FIELDS below (shared with
// Precision/Generic), so no code change was needed there — just adding the
// query fragment was sufficient.
//
// RESOLVED (2026-08-01): "Serie"/Cup events (e.g. "UDS DMR CUP 2026",
// https://shootnscoreit.com/event/117/123/) are a SEPARATE GraphQL type
// from the individual component matches they group (e.g.
// https://shootnscoreit.com/event/110/1086/, one of the cup's matches) —
// content_type 110 is PrecisionMatchNode, but content_type 117 is
// PrecisionSerieNode, a distinct type our query never had a fragment for,
// so these Serie events always got empty divisions. Only 4 disciplines
// have a Serie type at all (confirmed via full __schema introspection —
// Steel/Cmp/Idpa/Generic/Sass do not): IpscSerieNode, PrecisionSerieNode,
// NordicSerieNode, PpcSerieNode. Their division field names mostly match
// their non-Serie counterpart (PrecisionSerieNode/NordicSerieNode/
// PpcSerieNode reuse get_divisions_display/get_weapon_groups_display/
// get_weapon_classes_display respectively — already in DIVISION_FIELDS),
// EXCEPT IpscSerieNode, which uses `get_serie_divisions_display` instead of
// IpscMatchNode's `get_divisions_display` (added to DIVISION_FIELDS below).
// Confirmed via production content_type breakdown before this fix: ctype
// 43 (IpscSerieNode, 5 events), 117 (PrecisionSerieNode, 1 event) and 136
// (NordicSerieNode, 3 events) had 100% empty divisions, while their
// individual-match counterparts (22, 110, 91) had 0% empty.
const DIVISION_FIELDS = [
  'get_divisions_display',           // Precision, Generic, IPSC, PrecisionSerie
  'get_division_display',            // Steel (misnamed resolver, see above)
  'get_handgun_divs_display',        // IDPA
  'get_rifle_divs_display',          // CMP, IDPA
  'get_shotgun_divs_display',        // IDPA
  'get_weapon_classes_display',      // PPC, PpcSerie
  'get_rimfire_rifle_divs_display',  // CMP
  'get_pistol_divs_display',         // CMP
  'get_rimfire_pistol_divs_display', // CMP
  'get_dmg_divs_display',            // IDPA
  'get_weapon_groups_display',       // Nordic, NordicSerie
  'get_serie_divisions_display',     // IpscSerie (IpscMatchNode uses get_divisions_display instead)
];

export function collectDivisions(raw) {
  const all = DIVISION_FIELDS.flatMap(field => parseDivisions(raw[field]));
  if (all.length > 0) return [...new Set(all)];
  // Fallback for the known SteelMatchNode.get_division_display crash: when
  // that field errors, queryWindow's fallback tier drops it but still
  // queries the raw underlying `divisions` field (a plain model attribute,
  // not a dynamically-generated Django method, so it isn't subject to the
  // same misnamed-resolver crash). Only used when no display field produced
  // anything, so it never overrides good display data.
  return parseDivisions(raw.divisions);
}

export function normalizeMatch(raw) {
  const org = raw.organizer || {};
  let lat = raw.lat != null ? raw.lat : org.lat;
  let lng = raw.lng != null ? raw.lng : org.lng;
  if (!validCoords(lat, lng)) { lat = null; lng = null; }
  return {
    id:                   String(raw.id ?? ''),
    name:                 raw.name ?? '',
    date:                 (raw.starts  ?? '').slice(0, 10),
    endDate:              (raw.ends    ?? '').slice(0, 10),
    organizer:            org.name    ?? '',
    discipline:           raw.get_full_rule_display || raw.rule || '',
    divisions:            collectDivisions(raw),
    level:                raw.get_full_level_display ?? '',
    country:              org.country || raw.region || '',
    city:                 org.city    ?? '',
    venue:                raw.venue   ?? '',
    lat:                  lat != null ? parseFloat(lat) : null,
    lng:                  lng != null ? parseFloat(lng) : null,
    registrationOpen:     raw.is_registration_possible ?? null,
    registrationStarts:   (raw.registration_starts ?? '').slice(0, 10),
    registrationDeadline: (raw.registration_closes  ?? '').slice(0, 10),
    participants:         raw.competitors_count ?? null,
    mainMatchParticipants: raw.number_of_mainmatch_competitors_registered ?? null,
    maxParticipants:      raw.max_competitors ?? null,  // 0 = unlimited
    waitingCount:         raw.number_of_mainmatch_competitors_waiting ?? null,
    url:                  (raw.get_content_type_key && raw.id)
                            ? `https://shootnscoreit.com/event/${raw.get_content_type_key}/${raw.id}/`
                            : '',
    county:               '',
    geocodeSource:        lat != null ? 'api' : 'pending',
  };
}

// ─── GEOCODING ───────────────────────────────────────────────────────────────

export async function geocodeOrganizer(name, country, cache, manual) {
  const key = name.toLowerCase().trim();

  // 1. Manual override
  if (key in manual) {
    const m = manual[key];
    if (m.lat != null) return { lat: m.lat, lng: m.lng, source: 'manual' };
    return null;
  }

  // 2. Geocache (includes cached failures stored as {lat:null})
  if (key in cache) {
    if (cache[key].lat == null) return null;  // known failure or rate-limited this run
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
    const res = await fetch(`${NOMINATIM_BASE}?${params}`, {
      headers: { 'User-Agent': 'SSI-MatchFinder/1.0 (https://github.com/your-username/SSI-matchfinder)' },
    });
    if (res.status === 429) {
      console.warn(`  Geocoding rate-limited for "${name}", will retry next run`);
      cache[key] = { rateLimited: true };  // mark in-memory to skip retries this run; not persisted
      return null;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const results = await res.json();

    if (results.length > 0) {
      const { lat, lon, display_name } = results[0];
      const entry = { lat: parseFloat(lat), lng: parseFloat(lon), display: display_name };
      cache[key]  = entry;
      return { ...entry, source: 'nominatim' };
    }
  } catch (err) {
    console.warn(`  Geocoding failed for "${name}": ${err.message}`);
  }

  // Cache the failure (non-429) so we don't retry on future runs
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

    const query = match.organizer || match.venue || '';
    if (!query) {
      match.geocodeSource = 'unknown';
      continue;
    }

    const result = await geocodeOrganizer(query, match.country, cache, manual);
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

export async function reverseGeocode(lat, lng, cache) {
  const key = `${lat.toFixed(5)},${lng.toFixed(5)}`;
  if (key in cache) {
    const val = cache[key];
    if (typeof val === 'string') {   // migrate old string format
      cache[key] = { country: val, county: '' };
    }
    return cache[key];
  }
  const url = `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=json&addressdetails=1`;
  console.log(`  Reverse-geocoding (${lat.toFixed(4)}, ${lng.toFixed(4)})...`);
  await sleep(NOMINATIM_DELAY_MS);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'SSI-MatchFinder/1.0 (https://github.com/your-username/SSI-matchfinder)' },
    });
    if (res.status === 429) {
      console.warn(`  Reverse-geocode rate-limited for (${lat.toFixed(4)}, ${lng.toFixed(4)}), will retry`);
      return { country: '', county: '' };  // do NOT cache — allow retry
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const result = await res.json();
    const addr   = result?.address ?? {};
    const cc2    = (addr.country_code ?? '').toUpperCase();
    const cc3    = ISO2_TO_3[cc2] ?? (cc2 || '');
    const county = addr.state || addr.county || addr.municipality || '';
    cache[key] = { country: cc3, county };
    return cache[key];
  } catch (err) {
    console.warn(`  Reverse-geocode failed for (${lat.toFixed(4)}, ${lng.toFixed(4)}): ${err.message}`);
    cache[key] = { country: '', county: '' };
    return cache[key];
  }
}

export function inheritOrganizerCoords(matches) {
  /** Where an organizer has at least one event with precise API coordinates
   * (the actual range), inherit those coords for their other events that fell
   * back to Nominatim / geocache (city-centre approximations). */
  const apiCoords = new Map(); // organizer_lower → {lat, lng}
  for (const m of matches) {
    if (!m.organizer) continue;  // skip null-organizer events — they must not share coords
    if (m.geocodeSource === 'api' && m.lat != null && m.lng != null) {
      apiCoords.set(m.organizer.toLowerCase(), { lat: m.lat, lng: m.lng });
    }
  }
  let inherited = 0;
  for (const m of matches) {
    if (!m.organizer) continue;  // skip null-organizer events
    if (m.geocodeSource === 'api' || m.geocodeSource === 'manual') continue;
    const coords = apiCoords.get(m.organizer.toLowerCase());
    if (coords) {
      m.lat = coords.lat;
      m.lng = coords.lng;
      m.geocodeSource = 'inherited';
      inherited++;
    }
  }
  if (inherited) console.log(`Inherited range coordinates for ${inherited} event(s) from same organizer`);
}

async function enrichWithCountry(matches, cache) {
  let hits = 0;
  for (const m of matches) {
    if (m.country || m.lat == null || m.lng == null) continue;
    const result = await reverseGeocode(m.lat, m.lng, cache);
    if (result.country) { m.country = result.country; hits++; }
  }
  if (hits > 0) console.log(`Reverse-geocoded country for ${hits} event(s)`);
}

async function enrichWithCounty(matches, cache) {
  let hits = 0;
  for (const m of matches) {
    if (m.county || m.lat == null || m.lng == null) continue;
    const result = await reverseGeocode(m.lat, m.lng, cache);
    if (result.county) { m.county = result.county; hits++; }
  }
  if (hits > 0) console.log(`Reverse-geocoded county for ${hits} event(s)`);
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

  // Load existing output to preserve firstSeen dates for known events
  const today = new Date().toISOString().slice(0, 10);
  const firstSeenMap = {};
  if (existsSync(OUTPUT_PATH)) {
    try {
      const existing = JSON.parse(readFileSync(OUTPUT_PATH, 'utf8'));
      for (const m of (existing.matches || [])) {
        if (m.id && m.firstSeen) firstSeenMap[m.id] = m.firstSeen;
      }
    } catch { /* ignore parse errors */ }
  }
  for (const m of matches) {
    m.firstSeen = firstSeenMap[m.id] || today;
    // Backdate using registrationStarts if it's earlier — better proxy for "when announced"
    if (m.registrationStarts && m.registrationStarts < m.firstSeen) {
      m.firstSeen = m.registrationStarts;
    }
  }

  // Pass 1: fill in country for events that already have lat/lng from the API
  const revCache = loadJson(REV_GEOCACHE_PATH, {});
  await enrichWithCountry(matches, revCache);

  // Early filter: skip geocoding events we'll discard anyway.
  // Events with blank country are kept — they may get a country via geocoding.
  if (COUNTRIES.size > 0) {
    const before = matches.length;
    matches = matches.filter(m => !m.country || COUNTRIES.has(m.country.toUpperCase()));
    console.log(`Early country filter: ${matches.length} of ${before} events to geocode`);
  }

  // Forward-geocode events missing coordinates (organizer name or venue as query)
  await enrichWithCoordinates(matches, geocache);
  // Inherit precise range coords from sibling events by the same organizer
  inheritOrganizerCoords(matches);
  // Write geocache, filtering out in-run rate-limited markers (so they retry next run)
  const cleanGeoCache = Object.fromEntries(Object.entries(geocache).filter(([, v]) => !v.rateLimited));
  writeFileSync(GEOCACHE_PATH, JSON.stringify(cleanGeoCache, null, 2) + '\n', 'utf8');

  // Pass 2: fill in country for events that just received coordinates above
  await enrichWithCountry(matches, revCache);
  // Pass 3: fill in county for all events with coordinates (mostly cache hits)
  await enrichWithCounty(matches, revCache);
  writeFileSync(REV_GEOCACHE_PATH, JSON.stringify(revCache, null, 2) + '\n', 'utf8');

  if (COUNTRIES.size > 0) {
    const before = matches.length;
    matches = matches.filter(m => COUNTRIES.has(m.country.toUpperCase()));
    console.log(`Country filter (${[...COUNTRIES].sort().join(', ')}): ${matches.length} of ${before} kept`);
  }

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

// Only run as a CLI entry point (e.g. `node scripts/fetch-matches.js`), not
// when this module is imported by tests.
const isMainModule = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  if (!REFRESH_TOKEN) {
    console.error('Error: SSI_REFRESH_TOKEN environment variable is not set.');
    console.error('Run: python scripts/get_refresh_token.py  then add the value to .env');
    process.exit(1);
  }
  if (!API_KEY) {
    console.error('Error: SSI_API_KEY environment variable is not set.');
    process.exit(1);
  }

  main().catch(err => {
    console.error(err);
    process.exit(1);
  });
}
