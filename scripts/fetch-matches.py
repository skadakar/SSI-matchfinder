#!/usr/bin/env python3
"""
Python port of scripts/fetch-matches.js for use when Node.js is not available.
Uses only Python standard library — no pip installs required.

Usage:
    python scripts/fetch-matches.py           # full run
    python scripts/fetch-matches.py --dump    # print raw API response and exit
"""

import json
import os
import re
import sys
import time
from datetime import date, timedelta
from pathlib import Path
from urllib.error import HTTPError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parent.parent

# ─── ENV FILE ────────────────────────────────────────────────────────────────

env_path = ROOT / '.env'
if env_path.exists():
    for line in env_path.read_text(encoding='utf-8').splitlines():
        line = line.strip()
        if not line or line.startswith('#'):
            continue
        eq = line.find('=')
        if eq == -1:
            continue
        key = line[:eq].strip()
        val = line[eq + 1:].strip().strip('"\'')
        if key and key not in os.environ:
            os.environ[key] = val

# ─── CONFIG ──────────────────────────────────────────────────────────────────

REFRESH_TOKEN = os.environ.get('SSI_REFRESH_TOKEN', '')
if not REFRESH_TOKEN:
    print('Error: SSI_REFRESH_TOKEN is not set.', file=sys.stderr)
    print('Run: python scripts/get_refresh_token.py  then paste the value into .env', file=sys.stderr)
    sys.exit(1)

API_KEY = os.environ.get('SSI_API_KEY', '')
if not API_KEY:
    print('Error: SSI_API_KEY is not set (add it to .env or the environment).', file=sys.stderr)
    sys.exit(1)

GQL_ENDPOINT    = 'https://shootnscoreit.com/graphql/'
LOOKBACK_DAYS   = 60
LOOKAHEAD_DAYS  = 365

# Comma-separated ISO-3 country codes, e.g. "NOR,SWE". Empty = all countries.
_countries_env = os.environ.get('SSI_COUNTRIES', '')
COUNTRIES = {c.strip().upper() for c in _countries_env.split(',') if c.strip()}

NOMINATIM_BASE  = 'https://nominatim.openstreetmap.org/search'
NOMINATIM_DELAY = 1.25  # seconds — stay under the 1 req/s limit

GEOCACHE_PATH        = ROOT / 'data' / 'organizer-geocache.json'
MANUAL_COORDS_PATH   = ROOT / 'data' / 'manual-coords.json'
EXTRA_IDS_PATH       = ROOT / 'data' / 'extra-event-ids.json'
REV_GEOCACHE_PATH    = ROOT / 'data' / 'reverse-geocache.json'
OUTPUT_PATH          = ROOT / 'docs' / 'data' / 'matches.json'

# ISO 3166-1 alpha-3 → alpha-2 for Nominatim's countrycodes param
_ISO3_TO_2 = {
    'NOR': 'no', 'SWE': 'se', 'FIN': 'fi', 'DNK': 'dk', 'NLD': 'nl',
    'AUS': 'au', 'ZAF': 'za', 'EST': 'ee', 'DEU': 'de', 'GBR': 'gb',
    'FRA': 'fr', 'ESP': 'es', 'ITA': 'it', 'POL': 'pl', 'USA': 'us',
    'CAN': 'ca', 'NZL': 'nz', 'LTU': 'lt', 'LVA': 'lv', 'SVN': 'si',
    'HRV': 'hr', 'ROU': 'ro', 'AUT': 'at', 'CHE': 'ch', 'BEL': 'be',
}
# Reverse: ISO 2-letter → ISO 3-letter (for reverse geocoding responses)
_ISO2_TO_3 = {v.upper(): k for k, v in _ISO3_TO_2.items()}

# ─── HELPERS ─────────────────────────────────────────────────────────────────

def post_gql(query, variables=None, auth=None, api_key=None):
    body = json.dumps({'query': query, **(({'variables': variables}) if variables else {})})
    headers = {'Content-Type': 'application/json', 'Accept': 'application/json'}
    if auth:
        headers['Authorization'] = auth
    if api_key:
        headers['x-api-key'] = api_key
    req = Request(GQL_ENDPOINT, data=body.encode(), headers=headers)
    with urlopen(req, timeout=20) as resp:
        return json.loads(resp.read().decode('utf-8'))


def load_json(path, fallback):
    try:
        return json.loads(Path(path).read_text(encoding='utf-8'))
    except Exception:
        return fallback


# ─── GRAPHQL AUTH + EVENTS ───────────────────────────────────────────────────

_REFRESH_Q = '''
mutation Refresh($rt: String!) {
  refresh_token(refresh_token: $rt, revoke_refresh_token: false) {
    success
    errors
    token { token }
  }
}
'''

def get_jwt():
    result = post_gql(_REFRESH_Q, {'rt': REFRESH_TOKEN})
    if 'errors' in result:
        msgs = [e['message'] for e in result['errors']]
        print('Auth error:', msgs, file=sys.stderr)
        sys.exit(1)
    d = result['data']['refresh_token']
    if not d.get('success'):
        print('Auth failed:', d.get('errors'), file=sys.stderr)
        sys.exit(1)
    return d['token']['token']


_EVENTS_Q = '''
query GetEvents($after: String!, $before: String!) {
  events(starts_after: $after, starts_before: $before) {
    ... on EventInterface {
      id name starts ends rule sub_rule
      venue lat lng region
      registration registration_starts registration_closes is_registration_possible
      competitors_count max_competitors number_of_mainmatch_competitors_waiting
      get_content_type_key get_full_rule_display get_full_level_display
      organizer { name city country lat lng }
    }
  }
}
'''

_EVENT_Q = '''
query GetEvent($ct: Int!, $id: String!) {
  event(content_type: $ct, id: $id) {
    id name starts ends rule sub_rule
    venue lat lng region
    registration registration_starts registration_closes is_registration_possible
    competitors_count max_competitors number_of_mainmatch_competitors_waiting
    get_content_type_key get_full_rule_display get_full_level_display
    organizer { name city country lat lng }
  }
}
'''

def fetch_all_matches():
    print('Authenticating via refresh token...')
    jwt = get_jwt()
    auth = f'JWT {jwt}'

    today = date.today()
    all_events = {}  # keyed by str(id) to deduplicate across chunks

    def query_window(after, before):
        """Fetch one time window, returning events list. Updates auth via closure."""
        nonlocal auth
        variables = {'after': after, 'before': before}
        result = post_gql(_EVENTS_Q, variables, auth=auth, api_key=API_KEY)
        if 'errors' in result:
            msgs = [e['message'] for e in result['errors']]
            if any('authenticated' in m.lower() for m in msgs):
                auth = f'Bearer {jwt}'
                result = post_gql(_EVENTS_Q, variables, auth=auth, api_key=API_KEY)
            if 'errors' in result:
                print('Events query errors:', [e['message'] for e in result['errors']], file=sys.stderr)
                sys.exit(1)
        return result['data']['events']

    # 1. Upcoming events in 3-day chunks to stay under the API result cap (~100/query)
    print('Fetching events from SSI GraphQL API...')
    look_ahead_end = today + timedelta(days=LOOKAHEAD_DAYS)
    chunk_start = today
    future_chunks = 0
    while chunk_start < look_ahead_end:
        chunk_end = min(chunk_start + timedelta(days=3), look_ahead_end)
        new_evs = query_window(chunk_start.isoformat(), chunk_end.isoformat())
        added = sum(1 for ev in new_evs if str(ev['id']) not in all_events)
        for ev in new_evs:
            all_events.setdefault(str(ev['id']), ev)
        future_chunks += 1
        chunk_start = chunk_end
    print(f'  Future {LOOKAHEAD_DAYS}d ({future_chunks} 3-day chunks): {len(all_events)} events')

    # 2. Past events in 3-day chunks to stay under the API result cap (~100/query)
    look_back_start = today - timedelta(days=LOOKBACK_DAYS)
    chunk_end = today
    past_chunks = 0
    while chunk_end > look_back_start:
        chunk_start = max(chunk_end - timedelta(days=3), look_back_start)
        new_evs = query_window(chunk_start.isoformat(), chunk_end.isoformat())
        added = sum(1 for ev in new_evs if str(ev['id']) not in all_events)
        for ev in new_evs:
            all_events.setdefault(str(ev['id']), ev)
        past_chunks += 1
        print(f'  chunk {past_chunks:3d}: {chunk_start} → {chunk_end}  ({len(new_evs):3d} events, {added} new)', flush=True)
        chunk_end = chunk_start
    print(f'  Past {LOOKBACK_DAYS}d ({past_chunks} 3-day chunks): {len(all_events)} unique events total')

    events = list(all_events.values())
    print(f'Fetched {len(events)} events')

    # Fetch extra events not returned by the list query (e.g. those with organizer=null)
    extra_ids = load_json(EXTRA_IDS_PATH, [])
    if extra_ids:
        existing_ids = {str(e['id']) for e in events}
        print(f'Fetching {len(extra_ids)} extra event(s) by ID...')
        for entry in extra_ids:
            ct  = entry['content_type']
            eid = str(entry['id'])
            if eid in existing_ids:
                continue
            r = post_gql(_EVENT_Q, {'ct': ct, 'id': eid}, auth=auth, api_key=API_KEY)
            if 'errors' in r or not (r.get('data') or {}).get('event'):
                print(f'  Warning: could not fetch extra event {eid}', file=sys.stderr)
                continue
            ev = r['data']['event']
            if ev.get('organizer') is None:
                ev['organizer'] = {}
            events.append(ev)
            print(f'  Added extra event {eid}: {ev.get("name", "")}')

    return events


def normalize_match(raw):
    org = raw.get('organizer') or {}
    lat = raw.get('lat') if raw.get('lat') is not None else org.get('lat')
    lng = raw.get('lng') if raw.get('lng') is not None else org.get('lng')
    return {
        'id':                   str(raw.get('id', '')),
        'name':                 raw.get('name', ''),
        'date':                 (raw.get('starts') or '')[:10],
        'endDate':              (raw.get('ends') or '')[:10],
        'organizer':            org.get('name', ''),
        'discipline':           raw.get('get_full_rule_display') or raw.get('rule', ''),
        'level':                raw.get('get_full_level_display', ''),
        'country':              org.get('country', '') or raw.get('region', ''),
        'city':                 org.get('city', ''),
        'venue':                raw.get('venue', ''),
        'lat':                  float(lat) if lat is not None else None,
        'lng':                  float(lng) if lng is not None else None,
        'registrationOpen':     raw.get('is_registration_possible'),
        'registrationStarts':   (raw.get('registration_starts') or '')[:10],
        'registrationDeadline': (raw.get('registration_closes') or '')[:10],
        'participants':         raw.get('competitors_count'),
        'maxParticipants':      raw.get('max_competitors'),  # 0 = unlimited
        'waitingCount':         raw.get('number_of_mainmatch_competitors_waiting'),
        'url':                  f'https://shootnscoreit.com/event/{raw.get("get_content_type_key", "")}/{raw.get("id", "")}/' if raw.get('get_content_type_key') and raw.get('id') else '',
        'county':               '',
        'geocodeSource':        'api' if lat is not None else 'pending',
    }


# ─── GEOCODING ───────────────────────────────────────────────────────────────

def geocode_organizer(name, country, cache, manual):
    key = name.lower().strip()

    # 1. Manual override (checked first — always wins)
    if key in manual:
        entry = manual[key]
        if entry.get('lat') is not None:
            return {'lat': entry['lat'], 'lng': entry['lng'], 'source': 'manual'}
        return None  # explicitly marked unmappable

    # 2. Geocache (includes cached failures stored as {lat: null})
    if key in cache:
        if cache[key].get('lat') is None:
            return None  # known failure (or rate-limited this run) — skip re-querying
        return {'lat': cache[key]['lat'], 'lng': cache[key]['lng'], 'source': 'cache'}

    # 3. Nominatim — use countrycodes param for better accuracy
    cc = _ISO3_TO_2.get(country.upper(), '')
    if cc:
        params = urlencode({'q': name, 'countrycodes': cc, 'format': 'json', 'limit': 1})
    else:
        params = urlencode({'q': ', '.join(filter(None, [name, country])), 'format': 'json', 'limit': 1})

    url = f'{NOMINATIM_BASE}?{params}'
    print(f'  Geocoding: "{name}" ({country})')
    time.sleep(NOMINATIM_DELAY)

    try:
        req = Request(url, headers={
            'User-Agent': 'SSI-MatchFinder/1.0 (https://github.com/your-username/SSI-matchfinder)',
            'Accept':     'application/json',
        })
        with urlopen(req, timeout=15) as resp:
            results = json.loads(resp.read().decode('utf-8'))
        if results:
            r = results[0]
            entry = {'lat': float(r['lat']), 'lng': float(r['lon']), 'display': r.get('display_name', '')}
            cache[key] = entry
            return {**entry, 'source': 'nominatim'}
    except HTTPError as e:
        if e.code == 429:
            print(f'  Geocoding rate-limited for "{name}", will retry next run', file=sys.stderr)
            cache[key] = {'rate_limited': True}  # mark in-memory to skip retries this run; not persisted
            return None  # do NOT include in disk cache
        print(f'  Geocoding failed for "{name}": {e}', file=sys.stderr)
    except Exception as e:
        print(f'  Geocoding failed for "{name}": {e}', file=sys.stderr)

    # Cache the failure (non-429) so we don't retry on future runs
    cache[key] = {'lat': None, 'lng': None}
    return None


def enrich_with_coordinates(matches, cache):
    manual = load_json(MANUAL_COORDS_PATH, {})
    nominatim_hits = 0
    for m in matches:
        if m['lat'] is not None and m['lng'] is not None:
            m['geocodeSource'] = 'api'
            continue
        query = m['organizer'] or m.get('venue', '')
        if not query:
            m['geocodeSource'] = 'unknown'
            continue
        result = geocode_organizer(query, m['country'], cache, manual)
        if result:
            m['lat'] = result['lat']
            m['lng'] = result['lng']
            m['geocodeSource'] = result['source']
            if result['source'] == 'nominatim':
                nominatim_hits += 1
        else:
            m['geocodeSource'] = 'unknown'
    if nominatim_hits:
        print(f'Geocoded {nominatim_hits} new organizers via Nominatim')


def reverse_geocode(lat, lng, cache):
    """Return {'country': ISO3, 'county': state_name} from cache or Nominatim.
    Migrates old string-only cache entries on first access."""
    key = f'{lat:.5f},{lng:.5f}'
    if key in cache:
        val = cache[key]
        if isinstance(val, str):  # migrate old format
            cache[key] = {'country': val, 'county': ''}
        return cache[key]
    url = (f'https://nominatim.openstreetmap.org/reverse'
           f'?lat={lat}&lon={lng}&format=json&addressdetails=1')
    print(f'  Reverse-geocoding ({lat:.4f}, {lng:.4f})...')
    time.sleep(NOMINATIM_DELAY)
    try:
        req = Request(url, headers={
            'User-Agent': 'SSI-MatchFinder/1.0 (https://github.com/your-username/SSI-matchfinder)',
            'Accept':     'application/json',
        })
        with urlopen(req, timeout=15) as resp:
            result = json.loads(resp.read().decode('utf-8'))
        addr = result.get('address', {})
        cc2  = addr.get('country_code', '').upper()
        cc3  = _ISO2_TO_3.get(cc2, cc2 or '')
        county = addr.get('state', '') or addr.get('county', '') or addr.get('municipality', '')
        cache[key] = {'country': cc3, 'county': county}
        return cache[key]
    except HTTPError as e:
        if e.code == 429:
            print(f'  Reverse-geocode rate-limited for ({lat:.4f}, {lng:.4f}), will retry', file=sys.stderr)
            return {'country': '', 'county': ''}  # do NOT cache — allow retry
        print(f'  Reverse-geocode failed for ({lat:.4f}, {lng:.4f}): {e}', file=sys.stderr)
        cache[key] = {'country': '', 'county': ''}
        return cache[key]
    except Exception as e:
        print(f'  Reverse-geocode failed for ({lat:.4f}, {lng:.4f}): {e}', file=sys.stderr)
        cache[key] = {'country': '', 'county': ''}
        return cache[key]


def inherit_organizer_coords(matches):
    """Where an organizer has at least one event with precise API coordinates
    (the actual range), inherit those coords for their other events that fell
    back to Nominatim / geocache (city-centre approximations)."""
    api_coords = {}
    for m in matches:
        if m['geocodeSource'] == 'api' and m['lat'] is not None and m['lng'] is not None:
            api_coords[m['organizer'].lower()] = (m['lat'], m['lng'])

    inherited = 0
    for m in matches:
        if m['geocodeSource'] == 'api':
            continue
        lat, lng = api_coords.get(m['organizer'].lower(), (None, None))
        if lat is not None:
            m['lat'], m['lng'] = lat, lng
            m['geocodeSource'] = 'inherited'
            inherited += 1
    if inherited:
        print(f'Inherited range coordinates for {inherited} event(s) from same organizer')


def enrich_with_country(matches, cache):
    """Fill in missing country codes via reverse geocoding for events that have
    coordinates but no country (typically events with null organizer in SSI)."""
    hits = 0
    for m in matches:
        if m['country'] or m['lat'] is None or m['lng'] is None:
            continue
        result = reverse_geocode(m['lat'], m['lng'], cache)
        if result['country']:
            m['country'] = result['country']
            hits += 1
    if hits:
        print(f'Reverse-geocoded country for {hits} event(s)')


def enrich_with_county(matches, cache):
    """Fill in county for all events with coordinates (uses cached results)."""
    hits = 0
    for m in matches:
        if m.get('county') or m['lat'] is None or m['lng'] is None:
            continue
        result = reverse_geocode(m['lat'], m['lng'], cache)
        if result['county']:
            m['county'] = result['county']
            hits += 1
    if hits:
        print(f'Reverse-geocoded county for {hits} event(s)')


# ─── MAIN ─────────────────────────────────────────────────────────────────────

def main():
    dump = '--dump' in sys.argv

    raw = fetch_all_matches()

    if dump:
        print('\n--- RAW API RESPONSE (first 3 events) ---')
        print(json.dumps(raw[:3], indent=2, ensure_ascii=False))
        if raw:
            print(f'\nFields in first event: {", ".join(raw[0].keys())}')
        return

    geocache = load_json(GEOCACHE_PATH, {})
    matches  = [normalize_match(r) for r in raw]

    # Pass 1: fill in country for events that already have lat/lng from the API
    rev_cache = load_json(REV_GEOCACHE_PATH, {})
    enrich_with_country(matches, rev_cache)

    # Early filter: skip geocoding events we'll discard anyway.
    # Events with blank country are kept — they may get a country via geocoding.
    if COUNTRIES:
        before  = len(matches)
        matches = [m for m in matches if not m['country'] or m['country'].upper() in COUNTRIES]
        print(f'Early country filter: {len(matches)} of {before} events to geocode')

    # Forward-geocode events missing coordinates (organizer name or venue as query)
    enrich_with_coordinates(matches, geocache)
    # Inherit precise range coords from sibling events by the same organizer
    inherit_organizer_coords(matches)
    # Write geocache, filtering out in-run rate-limited markers (so they retry next run)
    clean_geocache = {k: v for k, v in geocache.items() if not v.get('rate_limited')}
    GEOCACHE_PATH.write_text(
        json.dumps(clean_geocache, indent=2, ensure_ascii=False) + '\n', encoding='utf-8'
    )

    # Pass 2: fill in country for events that just received coordinates above
    enrich_with_country(matches, rev_cache)
    # Pass 3: fill in county for all events with coordinates (mostly cache hits)
    enrich_with_county(matches, rev_cache)
    REV_GEOCACHE_PATH.write_text(
        json.dumps(rev_cache, indent=2, ensure_ascii=False) + '\n', encoding='utf-8'
    )

    if COUNTRIES:
        before  = len(matches)
        matches = [m for m in matches if m['country'].upper() in COUNTRIES]
        print(f'Country filter ({", ".join(sorted(COUNTRIES))}): {len(matches)} of {before} kept')

    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    output = {
        'generated': date.today().isoformat() + 'T' + time.strftime('%H:%M:%S') + 'Z',
        'count':     len(matches),
        'matches':   matches,
    }
    OUTPUT_PATH.write_text(
        json.dumps(output, indent=2, ensure_ascii=False) + '\n', encoding='utf-8'
    )

    located = sum(1 for m in matches if m['lat'] is not None)
    unknown = sum(1 for m in matches if m['geocodeSource'] == 'unknown')
    print(f'Written {len(matches)} matches → {located} with coordinates, {unknown} without')
    missing = sorted({m['organizer'] for m in matches if m['geocodeSource'] == 'unknown' and m['organizer']})
    if missing:
        print(f'\n{len(missing)} clubs still missing coordinates.')
        print('Add entries to data/manual-coords.json to fix them:')
        for org in missing:
            print(f'  "{org.lower()}": {{"lat": 0, "lng": 0}},')

if __name__ == '__main__':
    main()
