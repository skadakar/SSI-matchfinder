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
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
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

function isMatchIncluded(match, rule, cutoffDate = null) {
  const country = (match.country || '').toUpperCase();
  const discipline = (match.discipline || '').trim();
  const level = (match.level || '').trim();
  const organizer = (match.organizer || '').trim();
  const region = (match.county || '').trim();
  const date = match.date || '';
  const matchDate = parseDate(date);

  if (rule.countries?.length) {
    if (!rule.countries.includes(country)) return false;
  }
  if (rule.disciplines?.length) {
    if (!rule.disciplines.includes(discipline)) return false;
  }
  if (rule.levels?.length) {
    if (!rule.levels.includes(level)) return false;
  }
  if (rule.organizers?.length) {
    if (!rule.organizers.includes(organizer)) return false;
  }
  if (rule.regions?.length) {
    if (!rule.regions.includes(region)) return false;
  }
  if (rule.from && date < rule.from) return false;
  if (rule.to && date > rule.to) return false;
  if (cutoffDate && matchDate && matchDate < cutoffDate) return false;

  return true;
}

function resolveWebhook(rule) {
  const raw = rule.webhook || '';
  if (!raw) return null;
  if (/^https?:\/\//i.test(raw)) return raw;
  if (process.env[raw]) return process.env[raw];
  if (WEBHOOKS_MAP[raw]) return WEBHOOKS_MAP[raw];
  if (WEBHOOKS_MAP[rule.name]) return WEBHOOKS_MAP[rule.name];
  return null;
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

  const response = await fetch(webhook, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Discord webhook failed: ${response.status} ${response.statusText} ${text}`);
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
    const webhook = resolveWebhook(rule);
    if (!webhook) continue;
    const cutoffDays = resolveCutoffDays(config, rule);
    const cutoffDate = new Date(firstRunAt);
    cutoffDate.setDate(cutoffDate.getDate() - cutoffDays);
    const filtered = matches.filter(match => isMatchIncluded(match, rule, cutoffDate));
    const newMatches = filtered.filter(match => !seenIds.has(`${rule.name || 'rule'}:${match.id}`));
    if (newMatches.length) {
      const summary = `New matches for ${rule.name || 'alert'} (${newMatches.length})`;
      await postToDiscord(webhook, summary, newMatches);
      results.push({ rule: rule.name || 'alert', count: newMatches.length });
    }
  }

  const nextSeen = [];
  for (const rule of config.rules || []) {
    const webhook = resolveWebhook(rule);
    if (!webhook) continue;
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
  console.error(err);
  process.exit(1);
});
