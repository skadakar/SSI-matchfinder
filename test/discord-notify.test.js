import test from 'node:test';
import assert from 'node:assert/strict';
import {
  chunkArray,
  buildDiscordPayload,
  isMatchIncluded,
  isPastEvent,
  resolveWebhook,
  resolveCutoffDays,
  normalizeFilterValues,
  loadWebhookMap,
  postToDiscord,
} from '../scripts/discord-notify.js';
import { stubFetch, restoreFetch } from './helpers/mock-fetch.js';

// ─── chunkArray ──────────────────────────────────────────────────────────────

test('chunkArray splits into groups of the given size', () => {
  assert.deepEqual(chunkArray([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
});

test('chunkArray returns a single chunk when array is smaller than size', () => {
  assert.deepEqual(chunkArray([1, 2], 10), [[1, 2]]);
});

test('chunkArray returns no chunks for an empty array', () => {
  assert.deepEqual(chunkArray([], 10), []);
});

test('chunkArray never produces a chunk larger than size (Discord embed limit regression)', () => {
  const matches = Array.from({ length: 27 }, (_, i) => ({ id: String(i) }));
  const chunks = chunkArray(matches, 10);
  assert.equal(chunks.length, 3);
  for (const chunk of chunks) assert.ok(chunk.length <= 10);
  // every match must appear exactly once across all chunks - nothing dropped
  const flattened = chunks.flat().map(m => m.id);
  assert.deepEqual(flattened, matches.map(m => m.id));
});

// ─── buildDiscordPayload ─────────────────────────────────────────────────────

test('buildDiscordPayload builds one embed per match with expected fields', () => {
  const payload = buildDiscordPayload([
    { name: 'Test Match', url: 'https://example.com', organizer: 'Acme Club', discipline: 'IPSC Rifle', level: 'Level II', date: '2026-09-01', country: 'NOR', city: 'Oslo', county: 'Viken' },
  ]);
  assert.equal(payload.embeds.length, 1);
  const embed = payload.embeds[0];
  assert.equal(embed.title, 'Test Match');
  assert.equal(embed.url, 'https://example.com');
  assert.equal(embed.description, 'Acme Club · IPSC Rifle · Level II');
  assert.deepEqual(embed.fields.map(f => f.name), ['Date', 'Country', 'Location']);
});

test('buildDiscordPayload does not truncate - caller is responsible for chunking', () => {
  const matches = Array.from({ length: 15 }, (_, i) => ({ name: `Match ${i}` }));
  const payload = buildDiscordPayload(matches);
  assert.equal(payload.embeds.length, 15);
});

test('buildDiscordPayload omits fields with blank values', () => {
  const payload = buildDiscordPayload([{ name: 'M', date: '', country: '', city: '', county: '' }]);
  // Date always has a fallback ('TBD') so it's kept; Country/Location fall back to em-dash so they're kept too.
  const fieldNames = payload.embeds[0].fields.map(f => f.name);
  assert.deepEqual(fieldNames, ['Date', 'Country', 'Location']);
});

test('buildDiscordPayload adds a Divisions field when a match has multiple equipment divisions', () => {
  const payload = buildDiscordPayload([
    { name: 'NM Steel Challenge 2026', divisions: ['Rimfire Open', 'PCC Open', 'Optics'] },
  ]);
  const divisionsField = payload.embeds[0].fields.find(f => f.name === 'Divisions');
  assert.ok(divisionsField);
  assert.equal(divisionsField.value, 'Rimfire Open, PCC Open, Optics');
});

test('buildDiscordPayload omits the Divisions field when a match has none (no duplicate embeds per division)', () => {
  const payload = buildDiscordPayload([{ name: 'Single-division match', divisions: [] }]);
  assert.equal(payload.embeds.length, 1); // one embed per match, regardless of division count
  assert.ok(!payload.embeds[0].fields.some(f => f.name === 'Divisions'));
});

// ─── isMatchIncluded ─────────────────────────────────────────────────────────

test('isMatchIncluded filters by country', () => {
  const rule = { countries: ['NOR'] };
  assert.equal(isMatchIncluded({ country: 'NOR' }, rule), true);
  assert.equal(isMatchIncluded({ country: 'SWE' }, rule), false);
});

test('isMatchIncluded filters by discipline, level, organizer, region (all must match when set)', () => {
  const rule = {
    disciplines: ['IPSC Rifle'],
    levels: ['Level I'],
    organizers: ['Acme Club'],
    regions: ['Viken'],
  };
  const match = { discipline: 'IPSC Rifle', level: 'Level I', organizer: 'Acme Club', county: 'Viken' };
  assert.equal(isMatchIncluded(match, rule), true);
  assert.equal(isMatchIncluded({ ...match, level: 'Level II' }, rule), false);
  assert.equal(isMatchIncluded({ ...match, organizer: 'Other Club' }, rule), false);
  assert.equal(isMatchIncluded({ ...match, county: 'Oslo' }, rule), false);
});

test('isMatchIncluded filters on the discipline field only, ignoring equipment divisions', () => {
  // rule.disciplines should only match match.discipline, not the
  // (much more crowded) match.divisions list — divisions used to be merged
  // in here so a rule targeting a division name (e.g. an IPSC division
  // reused by Steel Challenge) would also match, but that made the
  // discipline field too broad/noisy.
  const rule = { disciplines: ['Rimfire Open'] };
  const steelMatchWithDivision = { discipline: 'Steel', divisions: ['Rimfire Open', 'Production'] };
  assert.equal(isMatchIncluded(steelMatchWithDivision, rule), false);
  // Still matches by the primary discipline field directly.
  assert.equal(isMatchIncluded({ discipline: 'Rimfire Open' }, rule), true);
});

test('isMatchIncluded supports a separate rule.divisions filter, ANDed with disciplines (e.g. "Steel" + handgun divisions)', () => {
  const rule = {
    disciplines: ['Steel'],
    divisions: ['Open', 'Standard', 'Optics', 'Production', 'Production Optics', 'Classic', 'Revolver'],
  };
  // Steel match offering a handgun division among others — matches.
  const steelWithHandgun = {
    discipline: 'Steel',
    divisions: ['Rimfire Rifle Open', 'PCC Open', 'Open', 'Standard'],
  };
  assert.equal(isMatchIncluded(steelWithHandgun, rule), true);
  // Steel match with only rifle/PCC divisions, no handgun division — excluded.
  const steelRifleOnly = { discipline: 'Steel', divisions: ['Rimfire Rifle Open', 'Rimfire Rifle Iron'] };
  assert.equal(isMatchIncluded(steelRifleOnly, rule), false);
  // Right division but wrong discipline — still excluded (disciplines filter applies too).
  const ipscHandgun = { discipline: 'IPSC Handgun', divisions: ['Open'] };
  assert.equal(isMatchIncluded(ipscHandgun, rule), false);
});

test('isMatchIncluded with rule.divisions set excludes a match with no divisions at all', () => {
  const rule = { divisions: ['Open'] };
  assert.equal(isMatchIncluded({ divisions: [] }, rule), false);
  assert.equal(isMatchIncluded({}, rule), false);
});

test('isMatchIncluded respects rule.from / rule.to date bounds', () => {
  // now is fixed well before every date used here so the past-event check
  // (tested separately below) never interferes with this test.
  const now = new Date('2020-01-01T00:00:00Z');
  const rule = { from: '2026-01-01', to: '2026-12-31' };
  assert.equal(isMatchIncluded({ date: '2026-06-15' }, rule, null, now), true);
  assert.equal(isMatchIncluded({ date: '2025-12-31' }, rule, null, now), false);
  assert.equal(isMatchIncluded({ date: '2027-01-01' }, rule, null, now), false);
});

test('isMatchIncluded respects cutoffDate (excludes matches before it)', () => {
  const now = new Date('2020-01-01T00:00:00Z');
  const rule = {};
  const cutoff = new Date('2026-06-01T00:00:00Z');
  assert.equal(isMatchIncluded({ date: '2026-06-15' }, rule, cutoff, now), true);
  assert.equal(isMatchIncluded({ date: '2026-05-01' }, rule, cutoff, now), false);
});

test('isMatchIncluded with no filters set includes everything', () => {
  const now = new Date('2020-01-01T00:00:00Z');
  assert.equal(isMatchIncluded({ country: 'ANY', date: '2026-01-01' }, {}, null, now), true);
});

test('isMatchIncluded never includes a match whose date has already passed, regardless of other filters', () => {
  const now = new Date('2026-08-01T00:00:00Z');
  assert.equal(isMatchIncluded({ date: '2026-07-31' }, {}, null, now), false);
  assert.equal(isMatchIncluded({ date: '2026-08-01' }, {}, null, now), true); // starting today: not over yet
  assert.equal(isMatchIncluded({ date: '2026-08-02' }, {}, null, now), true);
});

test('isMatchIncluded uses endDate (not just the start date) to decide whether a multi-day match is over', () => {
  const now = new Date('2026-08-02T00:00:00Z');
  // Started before "now" but still running (ends today or later) — not over.
  assert.equal(isMatchIncluded({ date: '2026-08-01', endDate: '2026-08-03' }, {}, null, now), true);
  // Fully finished before "now".
  assert.equal(isMatchIncluded({ date: '2026-07-30', endDate: '2026-07-31' }, {}, null, now), false);
});

test('isMatchIncluded does not exclude a match with no usable date info', () => {
  assert.equal(isMatchIncluded({ country: 'NOR' }, { countries: ['NOR'] }), true);
});

// ─── isPastEvent ─────────────────────────────────────────────────────────────

test('isPastEvent is true once a single-day match\'s date is before now', () => {
  const now = new Date('2026-08-01T00:00:00Z');
  assert.equal(isPastEvent({ date: '2026-07-31' }, now), true);
  assert.equal(isPastEvent({ date: '2026-08-01' }, now), false);
  assert.equal(isPastEvent({ date: '2026-08-02' }, now), false);
});

test('isPastEvent prefers endDate over date for multi-day matches', () => {
  const now = new Date('2026-08-02T00:00:00Z');
  assert.equal(isPastEvent({ date: '2026-08-01', endDate: '2026-08-03' }, now), false);
  assert.equal(isPastEvent({ date: '2026-07-30', endDate: '2026-07-31' }, now), true);
});

test('isPastEvent returns false when there is no usable date', () => {
  assert.equal(isPastEvent({}), false);
  assert.equal(isPastEvent({ date: '' }), false);
});

// ─── resolveCutoffDays ───────────────────────────────────────────────────────

test('resolveCutoffDays prefers rule-level override over config default', () => {
  assert.equal(resolveCutoffDays({ cutoffDays: 14 }, { cutoffDays: 3 }), 3);
});

test('resolveCutoffDays falls back to config default, then to 14', () => {
  assert.equal(resolveCutoffDays({ cutoffDays: 7 }, {}), 7);
  assert.equal(resolveCutoffDays({}, {}), 14);
});

test('resolveCutoffDays falls back to 14 for invalid (negative/non-numeric) values', () => {
  assert.equal(resolveCutoffDays({}, { cutoffDays: -5 }), 14);
  assert.equal(resolveCutoffDays({}, { cutoffDays: 'not-a-number' }), 14);
});

// ─── normalizeFilterValues ───────────────────────────────────────────────────

test('normalizeFilterValues trims strings and drops blanks', () => {
  assert.deepEqual(normalizeFilterValues([' NOR ', '', 'SWE']), ['NOR', 'SWE']);
});

test('normalizeFilterValues returns [] for non-array input', () => {
  assert.deepEqual(normalizeFilterValues('NOR'), []);
  assert.deepEqual(normalizeFilterValues(null), []);
  assert.deepEqual(normalizeFilterValues(undefined), []);
});

// ─── loadWebhookMap ──────────────────────────────────────────────────────────

test('loadWebhookMap parses a valid JSON object', () => {
  assert.deepEqual(loadWebhookMap('{"a": "https://discord.example/a"}'), { a: 'https://discord.example/a' });
});

test('loadWebhookMap returns {} for empty input', () => {
  assert.deepEqual(loadWebhookMap(''), {});
  assert.deepEqual(loadWebhookMap(undefined), {});
});

test('loadWebhookMap returns {} and warns on invalid JSON', () => {
  assert.deepEqual(loadWebhookMap('{not valid json'), {});
});

test('loadWebhookMap returns {} for a JSON array (must be an object)', () => {
  assert.deepEqual(loadWebhookMap('["a", "b"]'), {});
});

// ─── resolveWebhook ──────────────────────────────────────────────────────────

test('resolveWebhook returns null/none when rule has no webhook configured', () => {
  const result = resolveWebhook({ name: 'no-webhook-rule' });
  assert.equal(result.webhook, null);
  assert.equal(result.missing, false);
});

test('resolveWebhook resolves a direct https:// URL as-is', () => {
  const result = resolveWebhook({ webhook: 'https://discord.example/direct' });
  assert.equal(result.webhook, 'https://discord.example/direct');
  assert.equal(result.source, 'direct-url');
});

test('resolveWebhook resolves via a matching environment variable', () => {
  process.env.TEST_WEBHOOK_ENV_VAR = 'https://discord.example/from-env';
  try {
    const result = resolveWebhook({ webhook: 'TEST_WEBHOOK_ENV_VAR' });
    assert.equal(result.webhook, 'https://discord.example/from-env');
    assert.equal(result.source, 'env');
  } finally {
    delete process.env.TEST_WEBHOOK_ENV_VAR;
  }
});

test('resolveWebhook resolves via DISCORD_NOTIFY_WEBHOOKS map by reference name', () => {
  process.env.DISCORD_NOTIFY_WEBHOOKS = JSON.stringify({ myRule: 'https://discord.example/mapped' });
  try {
    const result = resolveWebhook({ webhook: 'myRule' });
    assert.equal(result.webhook, 'https://discord.example/mapped');
    assert.equal(result.source, 'webhook-map');
  } finally {
    delete process.env.DISCORD_NOTIFY_WEBHOOKS;
  }
});

test('resolveWebhook resolves via DISCORD_NOTIFY_WEBHOOKS map by rule name when webhook value does not match', () => {
  process.env.DISCORD_NOTIFY_WEBHOOKS = JSON.stringify({ 'My Named Rule': 'https://discord.example/by-name' });
  try {
    const result = resolveWebhook({ name: 'My Named Rule', webhook: 'SOME_UNRESOLVED_REF' });
    assert.equal(result.webhook, 'https://discord.example/by-name');
    assert.equal(result.source, 'webhook-map');
  } finally {
    delete process.env.DISCORD_NOTIFY_WEBHOOKS;
  }
});

test('resolveWebhook reports missing=true when a webhook reference cannot be resolved', () => {
  const result = resolveWebhook({ name: 'broken-rule', webhook: 'UNRESOLVED_REF' });
  assert.equal(result.webhook, null);
  assert.equal(result.missing, true);
  assert.equal(result.reference, 'UNRESOLVED_REF');
});

// ─── postToDiscord ───────────────────────────────────────────────────────────

test('postToDiscord resolves without throwing on a 2xx response', async () => {
  stubFetch(() => ({ status: 204 }));
  try {
    await assert.doesNotReject(() => postToDiscord('https://discord.example/webhook', [{ name: 'Match' }]));
  } finally {
    restoreFetch();
  }
});

test('postToDiscord throws an error including the HTTP status on failure', async () => {
  stubFetch(() => ({ status: 400, statusText: 'Bad Request', body: 'embeds.0.title: too long' }));
  try {
    await assert.rejects(
      () => postToDiscord('https://discord.example/webhook', [{ name: 'Match' }], 'my-rule'),
      /400/,
    );
  } finally {
    restoreFetch();
  }
});

test('postToDiscord throws a descriptive error when the network request itself fails', async () => {
  globalThis.fetch = async () => { throw new Error('getaddrinfo ENOTFOUND'); };
  try {
    await assert.rejects(
      () => postToDiscord('https://discord.example/webhook', [{ name: 'Match' }], 'my-rule'),
      /ENOTFOUND/,
    );
  } finally {
    restoreFetch();
  }
});
