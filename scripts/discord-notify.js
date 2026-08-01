#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

const envPath = resolve(ROOT, '.env');
if (existsSync(envPath)) {
  readFileSync(envPath, 'utf8').split('\n').forEach(line => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return;
    const eq = trimmed.indexOf('=');
    if (eq === -1) return;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim().replace(/^['\"]|['\"]$/g, '');
    if (key && !(key in process.env)) process.env[key] = val;
  });
}

const DATA_PATH = resolve(ROOT, 'docs', 'data', 'matches.json');
const STATE_PATH = resolve(ROOT, 'data', 'discord-notify-state.json');
const CONFIG_PATH = resolve(ROOT, 'data', 'discord-notify-config.json');

export function loadWebhookMap(raw) {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('DISCORD_NOTIFY_WEBHOOKS must be a JSON object mapping webhook names to URLs.');
    }
    return parsed;
  } catch (error) {
    console.warn(`Ignoring invalid DISCORD_NOTIFY_WEBHOOKS JSON: ${error.message}`);
    return {};
  }
}

// Not cached: this is cheap (parsing a small env var) and re-reading it fresh
// each call keeps behavior predictable in tests that vary the env var.
function getWebhookMap() {
  return loadWebhookMap(process.env.DISCORD_NOTIFY_WEBHOOKS || '');
}

function loadJson(path, fallback) {
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch { return fallback; }
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
}

function normalizeList(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.filter(Boolean);
  return String(value).split(',').map(v => v.trim()).filter(Boolean);
}

function parseDate(str) {
  if (!str) return null;
  const d = new Date(`${str}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function normalizeFilterValues(values) {
  if (!values) return [];
  if (!Array.isArray(values)) return [];
  return values.map(value => String(value).trim()).filter(Boolean);
}

export function isMatchIncluded(match, rule, cutoffDate = null) {
  const country = (match.country || '').toUpperCase();
  const discipline = (match.discipline || '').trim();
  const level = (match.level || '').trim();
  const organizer = (match.organizer || '').trim();
  const region = (match.county || '').trim();
  const date = match.date || '';
  const matchDate = parseDate(date);
  const countries = normalizeFilterValues(rule.countries);
  const disciplines = normalizeFilterValues(rule.disciplines);
  const levels = normalizeFilterValues(rule.levels);
  const organizers = normalizeFilterValues(rule.organizers);
  const regions = normalizeFilterValues(rule.regions);

  if (countries.length) {
    if (!countries.includes(country)) return false;
  }
  if (disciplines.length) {
    if (!disciplines.includes(discipline)) return false;
  }
  if (levels.length) {
    if (!levels.includes(level)) return false;
  }
  if (organizers.length) {
    if (!organizers.includes(organizer)) return false;
  }
  if (regions.length) {
    if (!regions.includes(region)) return false;
  }
  if (rule.from && date < rule.from) return false;
  if (rule.to && date > rule.to) return false;
  if (cutoffDate && matchDate && matchDate < cutoffDate) return false;

  return true;
}

export function resolveWebhook(rule) {
  const webhookMap = getWebhookMap();
  const raw = rule.webhook || '';
  if (!raw) return { webhook: null, source: 'none', reference: null, missing: false };
  if (/^https?:\/\//i.test(raw)) return { webhook: raw, source: 'direct-url', reference: '<direct-url>', missing: false };
  if (process.env[raw]) return { webhook: process.env[raw], source: 'env', reference: raw, missing: false };
  if (webhookMap[raw]) return { webhook: webhookMap[raw], source: 'webhook-map', reference: raw, missing: false };
  if (webhookMap[rule.name]) return { webhook: webhookMap[rule.name], source: 'webhook-map', reference: rule.name, missing: false };
  return { webhook: null, source: 'env', reference: raw, missing: true };
}

export function resolveCutoffDays(config, rule) {
  const raw = rule.cutoffDays ?? config.cutoffDays ?? 14;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 14;
}

// Discord allows at most 10 embeds per webhook message, so rules with more
// than 10 new matches must be sent as multiple messages instead of silently
// truncating the rest.
const DISCORD_EMBED_LIMIT = 10;
// Small delay between messages for the same rule to stay well under Discord's
// per-webhook rate limit when a run has to send several chunks back to back.
const DISCORD_CHUNK_DELAY_MS = 350;

function sleep(ms) {
  return new Promise(res => setTimeout(res, ms));
}

export function chunkArray(array, size) {
  const chunks = [];
  for (let i = 0; i < array.length; i += size) {
    chunks.push(array.slice(i, i + size));
  }
  return chunks;
}

export function buildDiscordPayload(matches) {
  return {
    embeds: matches.map(match => ({
      title: match.name,
      url: match.url,
      description: [match.organizer, match.discipline, match.level].filter(Boolean).join(' · '),
      fields: [
        { name: 'Date', value: match.date || 'TBD', inline: true },
        { name: 'Country', value: match.country || '—', inline: true },
        { name: 'Location', value: [match.city, match.county].filter(Boolean).join(', ') || '—', inline: true },
      ].filter(field => field.value),
      color: 0x2b6cb0,
    })),
  };
}

export async function postToDiscord(webhook, matches, context = 'alert') {
  // `matches` must already be <= DISCORD_EMBED_LIMIT entries; callers are
  // expected to chunk before calling this.
  const payload = buildDiscordPayload(matches);

  let response;
  try {
    response = await fetch(webhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch (error) {
    console.error(`Notifier rule "${context}": Discord webhook request failed: ${error.message}`);
    throw new Error(`Discord webhook request failed for rule "${context}": ${error.message}`);
  }

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    console.error(`Notifier rule "${context}": Discord webhook returned ${response.status} ${response.statusText}${text ? ` — ${text.slice(0, 300)}` : ''}`);
    throw new Error(`Discord webhook failed with status ${response.status} for rule "${context}"`);
  }
}

async function main() {
  const data = loadJson(DATA_PATH, { matches: [] });
  const matches = Array.isArray(data.matches) ? data.matches : [];
  const config = loadJson(CONFIG_PATH, { rules: [] });
  const previousState = loadJson(STATE_PATH, { seen: [], firstRunAt: null });

  const seenIds = new Set(previousState.seen || []);
  const firstRunAt = previousState.firstRunAt ? new Date(previousState.firstRunAt) : new Date();
  const results = [];
  const failures = [];
  // Keys successfully posted to Discord this run. Used so a mid-run failure
  // on one rule (or one batch within a rule) doesn't cause matches that were
  // already sent to be lost from state and re-sent again next run.
  const sentThisRun = new Set();

  for (const rule of config.rules || []) {
    const webhookInfo = resolveWebhook(rule);
    if (!webhookInfo.webhook) {
      if (webhookInfo.missing) {
        console.warn(`Notifier rule "${rule.name || 'alert'}" is missing a webhook configuration. Expected env var or webhook map entry for "${webhookInfo.reference}".`);
      }
      continue;
    }

    const cutoffDays = resolveCutoffDays(config, rule);
    const cutoffDate = new Date(firstRunAt);
    cutoffDate.setDate(cutoffDate.getDate() - cutoffDays);
    const filtered = matches.filter(match => isMatchIncluded(match, rule, cutoffDate));
    const newMatches = filtered.filter(match => !seenIds.has(`${rule.name || 'rule'}:${match.id}`));
    const previewTitles = newMatches.slice(0, 10).map(match => match.name).join(', ') || 'none';

    console.log(`Notifier rule "${rule.name || 'alert'}": resolved webhook from ${webhookInfo.source}${webhookInfo.reference ? ` (${webhookInfo.reference})` : ''}`);
    console.log(`Notifier rule "${rule.name || 'alert'}": payload preview -> embeds: ${previewTitles}${newMatches.length > 10 ? ' …' : ''}`);

    if (!newMatches.length) {
      console.log(`Notifier rule "${rule.name || 'alert'}": no new matches to send.`);
      continue;
    }

    const batches = chunkArray(newMatches, DISCORD_EMBED_LIMIT);
    let sentCount = 0;
    try {
      for (let i = 0; i < batches.length; i++) {
        await postToDiscord(webhookInfo.webhook, batches[i], rule.name || 'alert');
        for (const match of batches[i]) {
          sentThisRun.add(`${rule.name || 'rule'}:${match.id}`);
        }
        sentCount += batches[i].length;
        if (i < batches.length - 1) await sleep(DISCORD_CHUNK_DELAY_MS);
      }
      results.push({ rule: rule.name || 'alert', count: newMatches.length, messages: batches.length });
    } catch (error) {
      // Don't let one rule's webhook failure abort the whole run - earlier
      // batches (and other rules) that already succeeded must still be
      // persisted as seen so they aren't re-sent next run.
      console.error(`Notifier rule "${rule.name || 'alert'}": failed after sending ${sentCount}/${newMatches.length} match(es): ${error.message}`);
      failures.push({ rule: rule.name || 'alert', error: error.message, sent: sentCount, total: newMatches.length });
    }
  }

  const nextSeen = [];
  for (const rule of config.rules || []) {
    const webhookInfo = resolveWebhook(rule);
    if (!webhookInfo.webhook) continue;
    const cutoffDays = resolveCutoffDays(config, rule);
    const cutoffDate = new Date(firstRunAt);
    cutoffDate.setDate(cutoffDate.getDate() - cutoffDays);
    const filtered = matches.filter(match => isMatchIncluded(match, rule, cutoffDate));
    for (const match of filtered) {
      const key = `${rule.name || 'rule'}:${match.id}`;
      // Only carry a match forward as "seen" if it was already seen before
      // this run, or was actually sent successfully this run. Anything that
      // failed to send stays unseen so it gets retried on the next run.
      if (seenIds.has(key) || sentThisRun.has(key)) {
        nextSeen.push(key);
      }
    }
  }

  writeJson(STATE_PATH, {
    seen: nextSeen,
    firstRunAt: previousState.firstRunAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });

  console.log(JSON.stringify({ ok: failures.length === 0, results, failures }, null, 2));

  if (failures.length) {
    process.exitCode = 1;
  }
}

// Only run the CLI entry point when this file is executed directly (e.g.
// `node scripts/discord-notify.js`), not when it's imported by tests.
const isMainModule = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  main().catch(err => {
    console.error(err.message || err);
    process.exit(1);
  });
}
