import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validCoords,
  normalizeMatch,
  parseCategories,
  collectDivisions,
  geocodeOrganizer,
  reverseGeocode,
  inheritOrganizerCoords,
  postGql,
  fetchAllMatches,
} from '../scripts/fetch-matches.js';
import { stubFetch, restoreFetch } from './helpers/mock-fetch.js';

// ─── validCoords ─────────────────────────────────────────────────────────────

test('validCoords accepts ordinary coordinates', () => {
  assert.equal(validCoords(59.9, 10.7), true);
});

test('validCoords rejects null/undefined lat or lng', () => {
  assert.equal(validCoords(null, 10), false);
  assert.equal(validCoords(59, null), false);
  assert.equal(validCoords(undefined, undefined), false);
});

test('validCoords rejects the SSI "no location" sentinel (85.05, -180)', () => {
  assert.equal(validCoords(85.05, -180), false);
});

test('validCoords is inclusive at lat=85 but exclusive at lng=180', () => {
  assert.equal(validCoords(85, 10), true);
  assert.equal(validCoords(10, 180), false);
  assert.equal(validCoords(10, 179.999), true);
});

// ─── normalizeMatch ──────────────────────────────────────────────────────────

test('normalizeMatch maps API fields, prefers direct coords, and builds the event URL', () => {
  const raw = {
    id: 42,
    name: 'Nordic Open',
    starts: '2026-06-01T10:00:00Z',
    ends: '2026-06-02T10:00:00Z',
    rule: 'IPSC',
    get_full_rule_display: 'IPSC Rifle',
    get_full_level_display: 'Level II',
    region: 'Europe',
    venue: 'Range 1',
    lat: 59.9,
    lng: 10.7,
    is_registration_possible: true,
    registration_starts: '2026-05-01T00:00:00Z',
    registration_closes: '2026-05-20T00:00:00Z',
    competitors_count: 10,
    number_of_mainmatch_competitors_registered: 8,
    max_competitors: 100,
    number_of_mainmatch_competitors_waiting: 2,
    get_content_type_key: 'event',
    organizer: { name: 'Acme Club', city: 'Oslo', country: 'NOR', lat: 1, lng: 1 },
  };
  const m = normalizeMatch(raw);
  assert.equal(m.id, '42');
  assert.equal(m.name, 'Nordic Open');
  assert.equal(m.date, '2026-06-01');
  assert.equal(m.endDate, '2026-06-02');
  assert.equal(m.organizer, 'Acme Club');
  assert.equal(m.discipline, 'IPSC Rifle'); // prefers get_full_rule_display over rule
  assert.equal(m.country, 'NOR'); // prefers organizer.country over raw.region
  assert.equal(m.lat, 59.9); // prefers raw.lat over organizer.lat
  assert.equal(m.lng, 10.7);
  assert.equal(m.url, 'https://shootnscoreit.com/event/event/42/');
  assert.equal(m.geocodeSource, 'api');
});

test('normalizeMatch falls back to organizer coordinates when event has none', () => {
  const raw = { id: 1, organizer: { name: 'Acme Club', lat: 59.9, lng: 10.7 } };
  const m = normalizeMatch(raw);
  assert.equal(m.lat, 59.9);
  assert.equal(m.lng, 10.7);
  assert.equal(m.geocodeSource, 'api');
});

test('normalizeMatch nulls out invalid/sentinel coordinates and marks geocodeSource pending', () => {
  const raw = { id: 2, lat: 85.05, lng: -180, organizer: { name: 'Acme Club' } };
  const m = normalizeMatch(raw);
  assert.equal(m.lat, null);
  assert.equal(m.lng, null);
  assert.equal(m.geocodeSource, 'pending');
});

test('normalizeMatch handles a missing organizer object gracefully', () => {
  const m = normalizeMatch({ id: 3, name: 'No Organizer Event' });
  assert.equal(m.organizer, '');
  assert.equal(m.city, '');
  assert.equal(m.url, '');
});

// ─── parseCategories / collectDivisions / normalizeMatch categories ────────

test('parseCategories splits a comma-separated display string into a trimmed array', () => {
  assert.deepEqual(
    parseCategories('Rimfire Open, Rimfire Iron, PCC Open,PCC Iron'),
    ['Rimfire Open', 'Rimfire Iron', 'PCC Open', 'PCC Iron'],
  );
});

test('parseCategories returns an empty array for missing/blank input', () => {
  assert.deepEqual(parseCategories(''), []);
  assert.deepEqual(parseCategories(null), []);
  assert.deepEqual(parseCategories(undefined), []);
});

test('collectDivisions merges a Steel match\'s get_division_display field', () => {
  const raw = { get_division_display: 'Rimfire Open, Rimfire Iron, PCC Open, PCC Iron, Open, Standard, Optics, Production' };
  assert.deepEqual(
    collectDivisions(raw),
    ['Rimfire Open', 'Rimfire Iron', 'PCC Open', 'PCC Iron', 'Open', 'Standard', 'Optics', 'Production'],
  );
});

test('collectDivisions merges a Precision/Generic match\'s get_divisions_display field', () => {
  const raw = { get_divisions_display: 'SA Open, Bolt Open, 5.56 SA' };
  assert.deepEqual(collectDivisions(raw), ['SA Open', 'Bolt Open', '5.56 SA']);
});

test('collectDivisions merges multiple per-firearm *_display division fields (e.g. IDPA) and dedupes', () => {
  const raw = {
    get_handgun_divs_display: 'Open, Standard, Production',
    get_rifle_divs_display: 'Open, Manual',
    get_shotgun_divs_display: 'Open',
  };
  assert.deepEqual(collectDivisions(raw), ['Open', 'Standard', 'Production', 'Manual']);
});

test('collectDivisions ignores IPSC\'s unrelated categories field (demographic, not equipment)', () => {
  const raw = { get_handgun_divs_display: 'Open, Standard', categories: 'Senior, Lady' };
  assert.deepEqual(collectDivisions(raw), ['Open', 'Standard']);
});

test('collectDivisions never collects any broken IpscMatchNode per-firearm division field (see DIVISION_FIELDS comment)', () => {
  const raw = {
    handgun_divs: 'Open',
    mini_rifle_divs: 'Open',
    prec_rifle_divs: 'Open',
    air_divs: 'Open',
    pcc_divs: 'Open',
    tournament_divisions: 'Open, Standard, Optics, Production, Revolver, Classic, Production Optics',
    get_tournament_divisions_display: 'Open, Standard, Optics, Production, Revolver, Classic, Production Optics',
  };
  assert.deepEqual(collectDivisions(raw), []);
});

test('collectDivisions merges an IpscMatchNode\'s get_divisions_display field (confirmed correct, unlike its per-firearm siblings)', () => {
  const raw = { get_divisions_display: 'Open, Standard, Standard Optics, Optics, Production, Revolver, Classic, Production Optics' };
  assert.deepEqual(collectDivisions(raw), [
    'Open', 'Standard', 'Standard Optics', 'Optics', 'Production', 'Revolver', 'Classic', 'Production Optics',
  ]);
});

test('collectDivisions returns an empty array when no division fields are present', () => {
  assert.deepEqual(collectDivisions({}), []);
});

test('collectDivisions no longer needs a code-translation step — *_display fields already return human-readable text', () => {
  // Previously this required a hardcoded DIVISION_CODE_LABELS table mapping
  // raw codes (rio, DOS, BGX, ...) to labels. Querying *_display fields
  // directly means whatever SSI's API returns is used as-is.
  const raw = { get_division_display: 'rio,ris,pco,pci,opp,std,opt,prd,pro,cls,rvl,rlo,rli' };
  assert.deepEqual(collectDivisions(raw), [
    'rio', 'ris', 'pco', 'pci', 'opp', 'std', 'opt', 'prd', 'pro', 'cls', 'rvl', 'rlo', 'rli',
  ]);
});

test('normalizeMatch exposes merged equipment categories without duplicating the match', () => {
  const raw = {
    id: 1190,
    name: 'NM Steel Challenge 2026',
    rule: 'Steel',
    get_division_display: 'Rimfire Open, Rimfire Iron, PCC Open, PCC Iron, Open, Standard, Optics, Production',
    organizer: { name: 'NOP' },
  };
  const m = normalizeMatch(raw);
  assert.equal(m.discipline, 'Steel'); // one discipline per match — categories are a facet, not separate matches
  assert.deepEqual(m.categories, ['Rimfire Open', 'Rimfire Iron', 'PCC Open', 'PCC Iron', 'Open', 'Standard', 'Optics', 'Production']);
});

test('normalizeMatch defaults categories to an empty array when no division fields are present', () => {
  const m = normalizeMatch({ id: 4, organizer: { name: 'Acme Club' } });
  assert.deepEqual(m.categories, []);
});

// ─── geocodeOrganizer ────────────────────────────────────────────────────────

test('geocodeOrganizer returns manual override coordinates without touching the network', async () => {
  const manual = { 'acme club': { lat: 1, lng: 2 } };
  const result = await geocodeOrganizer('Acme Club', 'NOR', {}, manual);
  assert.deepEqual(result, { lat: 1, lng: 2, source: 'manual' });
});

test('geocodeOrganizer returns null for a manual entry explicitly marking "no location"', async () => {
  const manual = { 'acme club': { lat: null, lng: null } };
  const result = await geocodeOrganizer('Acme Club', 'NOR', {}, manual);
  assert.equal(result, null);
});

test('geocodeOrganizer returns a cached hit without touching the network', async () => {
  const cache = { 'acme club': { lat: 3, lng: 4 } };
  const result = await geocodeOrganizer('Acme Club', 'NOR', cache, {});
  assert.deepEqual(result, { lat: 3, lng: 4, source: 'cache' });
});

test('geocodeOrganizer returns null for a cached known-failure', async () => {
  const cache = { 'acme club': { lat: null } };
  const result = await geocodeOrganizer('Acme Club', 'NOR', cache, {});
  assert.equal(result, null);
});

test('geocodeOrganizer geocodes via Nominatim on a cache/manual miss and caches the result', async () => {
  stubFetch(() => ({
    body: [{ lat: '59.9', lon: '10.7', display_name: 'Somewhere, Norway' }],
  }));
  try {
    const cache = {};
    const result = await geocodeOrganizer('New Club', 'NOR', cache, {});
    assert.equal(result.source, 'nominatim');
    assert.equal(result.lat, 59.9);
    assert.equal(result.lng, 10.7);
    assert.ok('new club' in cache);
  } finally {
    restoreFetch();
  }
});

test('geocodeOrganizer returns null and marks the cache entry rateLimited on HTTP 429', async () => {
  stubFetch(() => ({ status: 429 }));
  try {
    const cache = {};
    const result = await geocodeOrganizer('Rate Limited Club', 'NOR', cache, {});
    assert.equal(result, null);
    assert.equal(cache['rate limited club'].rateLimited, true);
  } finally {
    restoreFetch();
  }
});

test('geocodeOrganizer returns null and caches a permanent failure when Nominatim finds nothing', async () => {
  stubFetch(() => ({ body: [] }));
  try {
    const cache = {};
    const result = await geocodeOrganizer('Unknown Club', 'NOR', cache, {});
    assert.equal(result, null);
    assert.deepEqual(cache['unknown club'], { lat: null, lng: null });
  } finally {
    restoreFetch();
  }
});

test('geocodeOrganizer returns null and caches a failure when the network request throws', async () => {
  globalThis.fetch = async () => { throw new Error('network down'); };
  try {
    const cache = {};
    const result = await geocodeOrganizer('Broken Club', 'NOR', cache, {});
    assert.equal(result, null);
    assert.deepEqual(cache['broken club'], { lat: null, lng: null });
  } finally {
    restoreFetch();
  }
});

// ─── reverseGeocode ──────────────────────────────────────────────────────────

test('reverseGeocode returns a cached value without touching the network', async () => {
  const cache = { '59.90000,10.70000': { country: 'NOR', county: 'Viken' } };
  const result = await reverseGeocode(59.9, 10.7, cache);
  assert.deepEqual(result, { country: 'NOR', county: 'Viken' });
});

test('reverseGeocode migrates a legacy string-format cache entry to the object format', async () => {
  const cache = { '59.90000,10.70000': 'NOR' };
  const result = await reverseGeocode(59.9, 10.7, cache);
  assert.deepEqual(result, { country: 'NOR', county: '' });
  assert.deepEqual(cache['59.90000,10.70000'], { country: 'NOR', county: '' });
});

test('reverseGeocode geocodes via Nominatim on a cache miss and caches the ISO-3 country + county', async () => {
  stubFetch(() => ({
    body: { address: { country_code: 'no', state: 'Viken' } },
  }));
  try {
    const cache = {};
    const result = await reverseGeocode(59.9, 10.7, cache);
    assert.equal(result.country, 'NOR');
    assert.equal(result.county, 'Viken');
    assert.deepEqual(cache['59.90000,10.70000'], { country: 'NOR', county: 'Viken' });
  } finally {
    restoreFetch();
  }
});

test('reverseGeocode does not cache on HTTP 429 (allows retry on a later run)', async () => {
  stubFetch(() => ({ status: 429 }));
  try {
    const cache = {};
    const result = await reverseGeocode(59.9, 10.7, cache);
    assert.deepEqual(result, { country: '', county: '' });
    assert.equal('59.90000,10.70000' in cache, false);
  } finally {
    restoreFetch();
  }
});

test('reverseGeocode caches an empty result when the network request throws', async () => {
  globalThis.fetch = async () => { throw new Error('network down'); };
  try {
    const cache = {};
    const result = await reverseGeocode(59.9, 10.7, cache);
    assert.deepEqual(result, { country: '', county: '' });
    assert.deepEqual(cache['59.90000,10.70000'], { country: '', county: '' });
  } finally {
    restoreFetch();
  }
});

// ─── inheritOrganizerCoords ──────────────────────────────────────────────────

test('inheritOrganizerCoords propagates precise API coords to siblings needing geocoding', () => {
  const matches = [
    { organizer: 'Acme Club', geocodeSource: 'api', lat: 1, lng: 2 },
    { organizer: 'Acme Club', geocodeSource: 'nominatim', lat: 9, lng: 9 },
  ];
  inheritOrganizerCoords(matches);
  assert.equal(matches[1].lat, 1);
  assert.equal(matches[1].lng, 2);
  assert.equal(matches[1].geocodeSource, 'inherited');
});

test('inheritOrganizerCoords does not overwrite a manual-sourced sibling', () => {
  const matches = [
    { organizer: 'Acme Club', geocodeSource: 'api', lat: 1, lng: 2 },
    { organizer: 'Acme Club', geocodeSource: 'manual', lat: 5, lng: 6 },
  ];
  inheritOrganizerCoords(matches);
  assert.equal(matches[1].lat, 5);
  assert.equal(matches[1].lng, 6);
  assert.equal(matches[1].geocodeSource, 'manual');
});

test('inheritOrganizerCoords ignores events with no organizer', () => {
  const matches = [
    { organizer: '', geocodeSource: 'api', lat: 1, lng: 2 },
    { organizer: '', geocodeSource: 'nominatim', lat: null, lng: null },
  ];
  inheritOrganizerCoords(matches);
  assert.equal(matches[1].lat, null);
});

// ─── postGql ─────────────────────────────────────────────────────────────────

test('postGql returns parsed JSON on a successful response', async () => {
  stubFetch(() => ({ body: { data: { ok: true } } }));
  try {
    const result = await postGql('query { ok }', {}, 'JWT abc', 'key');
    assert.deepEqual(result, { data: { ok: true } });
  } finally {
    restoreFetch();
  }
});

test('postGql throws an error including the HTTP status on failure', async () => {
  stubFetch(() => ({ status: 500, statusText: 'Internal Server Error', body: 'boom' }));
  try {
    await assert.rejects(() => postGql('query { ok }', {}, 'JWT abc', 'key'), /HTTP 500/);
  } finally {
    restoreFetch();
  }
});

// ─── fetchAllMatches (integration, fully mocked network) ────────────────────

test('fetchAllMatches paginates across date-window chunks and dedupes events by id', async () => {
  let eventsCalls = 0;
  stubFetch((url, options) => {
    const body = JSON.parse(options.body);
    if (body.query.includes('mutation Refresh')) {
      return { body: { data: { refresh_token: { success: true, token: { token: 'JWT123' } } } } };
    }
    eventsCalls++;
    // Every window returns the same two events - dedup must collapse them.
    return { body: { data: { events: [{ id: 1, name: 'Event One' }, { id: 2, name: 'Event Two' }] } } };
  });
  try {
    const events = await fetchAllMatches();
    assert.equal(events.length, 2);
    assert.deepEqual(events.map(e => e.id).sort(), [1, 2]);
    // Sanity check that real chunking occurred (365 lookahead + 60 lookback days in 3-day windows).
    assert.ok(eventsCalls > 100, `expected many chunked calls, got ${eventsCalls}`);
  } finally {
    restoreFetch();
  }
});

test('fetchAllMatches retries with Bearer auth when the API reports a "not authenticated" GraphQL error', async () => {
  let eventsCalls = 0;
  const authHeadersSeen = [];
  stubFetch((url, options) => {
    const body = JSON.parse(options.body);
    if (body.query.includes('mutation Refresh')) {
      return { body: { data: { refresh_token: { success: true, token: { token: 'JWT123' } } } } };
    }
    eventsCalls++;
    authHeadersSeen.push(options.headers.Authorization);
    if (eventsCalls === 1) {
      return { body: { errors: [{ message: 'You are not authenticated to view this resource.' }] } };
    }
    return { body: { data: { events: [{ id: 1, name: 'Event One' }] } } };
  });
  try {
    const events = await fetchAllMatches();
    assert.equal(events.length, 1);
    assert.equal(authHeadersSeen[0], 'JWT JWT123');
    assert.ok(authHeadersSeen.slice(1).every(h => h === 'Bearer JWT123'));
  } finally {
    restoreFetch();
  }
});

test('fetchAllMatches aborts the run when refresh-token authentication fails', async () => {
  stubFetch(() => ({ body: { errors: [{ message: 'Invalid refresh token' }] } }));
  const originalExit = process.exit;
  process.exit = (code) => { throw new Error(`PROCESS_EXIT_${code}`); };
  try {
    await assert.rejects(() => fetchAllMatches(), /PROCESS_EXIT_1/);
  } finally {
    process.exit = originalExit;
    restoreFetch();
  }
});

test('fetchAllMatches skips a single query window (rather than aborting the whole run) when a non-auth GraphQL error occurs, e.g. a resolver crash', async () => {
  let eventsCalls = 0;
  const originalExit = process.exit;
  process.exit = (code) => { throw new Error(`PROCESS_EXIT_${code}`); };
  stubFetch((url, options) => {
    const body = JSON.parse(options.body);
    if (body.query.includes('mutation Refresh')) {
      return { body: { data: { refresh_token: { success: true, token: { token: 'JWT123' } } } } };
    }
    eventsCalls++;
    // Simulate the known SteelMatchNode.get_division_display naming-mismatch
    // crash on the very first window only; every other window succeeds.
    if (eventsCalls === 1) {
      return { body: { errors: [{ message: "'SteelMatch' object has no attribute 'get_division_display'" }] } };
    }
    return { body: { data: { events: [{ id: 1, name: 'Event One' }] } } };
  });
  try {
    const events = await fetchAllMatches();
    // The crashing window contributed no events, but the run did not abort —
    // events from all other (successful) windows are still collected.
    assert.ok(events.length > 0);
    assert.ok(events.every(e => e.id === 1));
  } finally {
    process.exit = originalExit;
    restoreFetch();
  }
});
