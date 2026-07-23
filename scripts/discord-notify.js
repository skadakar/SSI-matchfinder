#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

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

function parseWebhookMap(raw) {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('DISCORD_NOTIFY_WEBHOOKS must be a JSON object mapping webhook names to URLs.');
    }
    return parsed;
  } catch (error) {
    throw new Error(`Invalid DISCORD_NOTIFY_WEBHOOKS JSON: ${error.message}`);
  }
}

const WEBHOOKS_MAP = parseWebhookMap(process.env.DISCORD_NOTIFY_WEBHOOKS || '');

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

function normalizeFilterValues(values) {
  if (!values) return [];
  if (!Array.isArray(values)) return [];
  return values.map(value => String(value).trim()).filter(Boolean);
}

function isMatchIncluded(match, rule, cutoffDate = null) {
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

function resolveWebhook(rule) {
  const raw = rule.webhook || '';
  if (!raw) return { webhook: null, source: 'none', reference: null, missing: false };
  if (/^https?:\/\//i.test(raw)) return { webhook: raw, source: 'direct-url', reference: '<direct-url>', missing: false };
  if (process.env[raw]) return { webhook: process.env[raw], source: 'env', reference: raw, missing: false };
  if (WEBHOOKS_MAP[raw]) return { webhook: WEBHOOKS_MAP[raw], source: 'webhook-map', reference: raw, missing: false };
  if (WEBHOOKS_MAP[rule.name]) return { webhook: WEBHOOKS_MAP[rule.name], source: 'webhook-map', reference: rule.name, missing: false };
  return { webhook: null, source: 'env', reference: raw, missing: true };
}

function resolveCutoffDays(config, rule) {
  const raw = rule.cutoffDays ?? config.cutoffDays ?? 14;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 14;
}

async function postToDiscord(webhook, content, matches) {
  const payload = {
    content,
    embeds: matches.slice(0, 10).map(match => ({
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

  try {
    const response = await fetch(webhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`Discord webhook failed with status ${response.status}`);
    }
  } catch (error) {
    throw new Error('Discord webhook request failed. Check the webhook configuration.');
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
    const summary = `New matches for ${rule.name || 'alert'} (${newMatches.length})`;

    console.log(`Notifier rule "${rule.name || 'alert'}": resolved webhook from ${webhookInfo.source}${webhookInfo.reference ? ` (${webhookInfo.reference})` : ''}`);
    console.log(`Notifier rule "${rule.name || 'alert'}": payload preview -> content: ${summary}; matches: ${newMatches.slice(0, 5).map(match => match.name || match.id).join(', ') || 'none'}${newMatches.length > 5 ? ' …' : ''}`);

    if (newMatches.length) {
      await postToDiscord(webhookInfo.webhook, summary, newMatches);
      results.push({ rule: rule.name || 'alert', count: newMatches.length });
    } else {
      console.log(`Notifier rule "${rule.name || 'alert'}": no new matches to send.`);
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
      nextSeen.push(`${rule.name || 'rule'}:${match.id}`);
    }
  }

  writeJson(STATE_PATH, {
    seen: nextSeen,
    firstRunAt: previousState.firstRunAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });

  console.log(JSON.stringify({ ok: true, results }, null, 2));
}

main().catch(err => {
  console.error(err.message || err);
  process.exit(1);
});
