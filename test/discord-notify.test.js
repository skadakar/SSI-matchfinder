import test from 'node:test';
import assert from 'node:assert/strict';
import {
  chunkArray,
  buildDiscordPayload,
  isMatchIncluded,
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

test('buildDiscordPayload adds a Categories field when a match has multiple equipment categories', () => {
  const payload = buildDiscordPayload([
    { name: 'NM Steel Challenge 2026', categories: ['Rimfire Open', 'PCC Open', 'Optics'] },
  ]);
  const categoriesField = payload.embeds[0].fields.find(f => f.name === 'Categories');
  assert.ok(categoriesField);
  assert.equal(categoriesField.value, 'Rimfire Open, PCC Open, Optics');
});

test('buildDiscordPayload omits the Categories field when a match has none (no duplicate embeds per category)', () => {
  const payload = buildDiscordPayload([{ name: 'Single-category match', categories: [] }]);
  assert.equal(payload.embeds.length, 1); // one embed per match, regardless of category count
  assert.ok(!payload.embeds[0].fields.some(f => f.name === 'Categories'));
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

test('isMatchIncluded matches a rule discipline against a match\'s equipment categories too', () => {
  // "NM Steel Challenge 2026" has discipline "Steel" but offers a "Rimfire
  // Open" category (an IPSC division name) — a rule targeting "Rimfire Open"
  // should still pick it up.
  const rule = { disciplines: ['Rimfire Open'] };
  const steelMatchWithCategory = { discipline: 'Steel', categories: ['Rimfire Open', 'Production'] };
  assert.equal(isMatchIncluded(steelMatchWithCategory, rule), true);
  assert.equal(isMatchIncluded({ discipline: 'Steel', categories: ['Production'] }, rule), false);
  // Still matches by the primary discipline field when no categories are present.
  assert.equal(isMatchIncluded({ discipline: 'Rimfire Open' }, rule), true);
});

test('isMatchIncluded respects rule.from / rule.to date bounds', () => {
  const rule = { from: '2026-01-01', to: '2026-12-31' };
  assert.equal(isMatchIncluded({ date: '2026-06-15' }, rule), true);
  assert.equal(isMatchIncluded({ date: '2025-12-31' }, rule), false);
  assert.equal(isMatchIncluded({ date: '2027-01-01' }, rule), false);
});

test('isMatchIncluded respects cutoffDate (excludes matches before it)', () => {
  const rule = {};
  const cutoff = new Date('2026-06-01T00:00:00Z');
  assert.equal(isMatchIncluded({ date: '2026-06-15' }, rule, cutoff), true);
  assert.equal(isMatchIncluded({ date: '2026-05-01' }, rule, cutoff), false);
});

test('isMatchIncluded with no filters set includes everything', () => {
  assert.equal(isMatchIncluded({ country: 'ANY', date: '2026-01-01' }, {}), true);
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
