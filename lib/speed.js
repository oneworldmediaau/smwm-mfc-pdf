// Shared speed-to-lead helpers: GHL reads, first-call lookup, Sydney dates, and a call-time cache in Vercel Blob.
import { put, list } from '@vercel/blob';

export const API = 'https://services.leadconnectorhq.com';
export const LOCATION_ID = 'BOPw9TAczSRgLZCpM1Ur';
export const CSR_FIELD = 'sSTk9wqOdy13laKJ6JWK';
export const TZ = 'Australia/Sydney';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function ghl(method, path, body) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(API + path, {
      method,
      headers: Object.assign({ Authorization: 'Bearer ' + process.env.GHL_TOKEN, Version: '2021-07-28', Accept: 'application/json' }, body ? { 'Content-Type': 'application/json' } : {}),
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 429) { await sleep(1500 * (attempt + 1)); continue; }
    const text = await res.text();
    let data; try { data = JSON.parse(text); } catch (e) { data = text; }
    if (!res.ok) throw new Error(method + ' ' + path + ' -> ' + res.status + ' ' + String(text).slice(0, 300));
    return data;
  }
  throw new Error('GHL rate limit: ' + path);
}

// ---- Sydney time
export function sydParts(d) {
  const p = {}; new Intl.DateTimeFormat('en-AU', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })
    .formatToParts(new Date(d)).forEach((x) => { p[x.type] = x.value; });
  return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour % 24, min: +p.minute };
}
export function sydOffsetMin(utcMs) {
  const s = new Intl.DateTimeFormat('en-US', { timeZone: TZ, timeZoneName: 'shortOffset' }).formatToParts(new Date(utcMs)).find((x) => x.type === 'timeZoneName').value; // GMT+11
  const m = s.match(/GMT([+-])(\d+)(?::(\d+))?/); if (!m) return 600;
  return (m[1] === '-' ? -1 : 1) * (+m[2] * 60 + (+m[3] || 0));
}
// 'YYYY-MM-DD' (Sydney) -> UTC ms at 00:00 Sydney
export function sydMidnight(ymd) {
  const [y, m, d] = ymd.split('-').map(Number);
  let t = Date.UTC(y, m - 1, d) - 600 * 60000;
  t = Date.UTC(y, m - 1, d) - sydOffsetMin(t) * 60000;
  return Date.UTC(y, m - 1, d) - sydOffsetMin(t) * 60000;
}
export function sydYmd(utcMs) { const p = sydParts(utcMs); return p.y + '-' + String(p.m).padStart(2, '0') + '-' + String(p.d).padStart(2, '0'); }
function mdy(utcMs) { const p = sydParts(utcMs); return String(p.m).padStart(2, '0') + '-' + String(p.d).padStart(2, '0') + '-' + p.y; }

// ---- opportunities
export async function opportunitiesBetween(start, end) {
  const out = []; let startAfter = null, startAfterId = null;
  for (let i = 0; i < 40; i++) {
    const q = new URLSearchParams({ location_id: LOCATION_ID, date: mdy(start - 864e5), endDate: mdy(end + 864e5), limit: '100', status: 'all' });
    if (startAfter) { q.set('startAfter', startAfter); q.set('startAfterId', startAfterId); }
    const d = await ghl('GET', '/opportunities/search?' + q);
    const ops = d.opportunities || [];
    out.push(...ops);
    if (ops.length < 100 || !d.meta || !d.meta.startAfterId) break;
    startAfter = d.meta.startAfter; startAfterId = d.meta.startAfterId;
  }
  const seen = new Set();
  return out.filter((o) => { const t = new Date(o.createdAt).getTime(); if (seen.has(o.id)) return false; seen.add(o.id); return t >= start && t < end; });
}
export function csrOf(o) {
  const f = (o.customFields || []).find((c) => c.id === CSR_FIELD);
  return f ? String(f.fieldValueString || f.fieldValue || f.value || '') : '';
}
export function channelOf(o) {
  const a = (o.attributions || []).find((x) => x.isFirst) || (o.attributions || [])[0] || {};
  return a.utmSource || a.utmSessionSource || '';
}

// ---- first outbound call
export async function firstOutboundCall(contactId, after) {
  const conv = await ghl('GET', '/conversations/search?' + new URLSearchParams({ locationId: LOCATION_ID, contactId }));
  let best = null;
  for (const c of conv.conversations || []) {
    let last = null;
    for (let i = 0; i < 10; i++) {
      const q = new URLSearchParams({ type: 'TYPE_CALL', limit: '100' }); if (last) q.set('lastMessageId', last);
      const d = await ghl('GET', '/conversations/' + c.id + '/messages?' + q);
      const box = d.messages || {}; const msgs = box.messages || [];
      for (const m of msgs) {
        const t = new Date(m.dateAdded).getTime();
        if (m.direction === 'outbound' && t >= after && (!best || t < best.t)) best = { t, u: m.userId || '', d: (m.meta && m.meta.call && m.meta.call.duration) || 0 };
      }
      if (!box.nextPage || !box.lastMessageId) break; last = box.lastMessageId;
    }
  }
  return best;
}

let USERS = null;
export async function users() {
  if (USERS) return USERS;
  USERS = {};
  try { const d = await ghl('GET', '/users/?locationId=' + LOCATION_ID); (d.users || []).forEach((u) => { USERS[u.id] = ((u.firstName || '') + ' ' + (u.lastName || '')).trim(); }); } catch (e) { /* ignore */ }
  return USERS;
}

// ---- cache: { [opportunityId]: { c: callMs|null, u: userId, d: seconds, k: checkedMs } }  (no personal details stored)
const CACHE_PATH = 'speed/first-calls.json';
export async function loadCache() {
  if (!process.env.BLOB_READ_WRITE_TOKEN) return {};
  try {
    const { blobs } = await list({ prefix: CACHE_PATH });
    const b = blobs.find((x) => x.pathname === CACHE_PATH); if (!b) return {};
    const r = await fetch(b.url + '?v=' + Date.now(), { cache: 'no-store' }); return r.ok ? await r.json() : {};
  } catch (e) { return {}; }
}
export async function saveCache(cache) {
  if (!process.env.BLOB_READ_WRITE_TOKEN) return;
  await put(CACHE_PATH, JSON.stringify(cache), { access: 'public', addRandomSuffix: false, allowOverwrite: true, contentType: 'application/json', cacheControlMaxAge: 0 });
}
// Does this opportunity need (re)checking?
export function needsCheck(entry, createdMs, now) {
  if (!entry) return true;
  if (entry.c) return false;                                   // call found: final
  if (now - createdMs > 14 * 864e5) return false;              // older than 14 days: treat "not called" as final
  return now - entry.k > 15 * 60000;                           // recheck uncalled leads every 15 minutes
}

// Fill missing first-call data within a time budget. Returns number still pending.
export async function fillCalls(ops, cache, budgetMs, concurrency = 6) {
  const now = Date.now(), stopAt = now + budgetMs;
  const todo = ops.filter((o) => needsCheck(cache[o.id], new Date(o.createdAt).getTime(), now));
  let i = 0, changed = false;
  async function worker() {
    while (i < todo.length && Date.now() < stopAt) {
      const o = todo[i++]; const created = new Date(o.createdAt).getTime();
      try { const c = await firstOutboundCall(o.contactId, created); cache[o.id] = { c: c ? c.t : null, u: c ? c.u : '', d: c ? c.d : 0, k: Date.now() }; changed = true; } catch (e) { /* retry next time */ }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  const pending = ops.filter((o) => !cache[o.id]).length;
  return { changed, pending };
}

// ---- business hours: Mon–Fri 10:00–18:00 Sydney, excluding NSW public holidays
export const OPEN_H = 10, CLOSE_H = 18;
export const HOLIDAYS = new Set([
  '2026-01-01', '2026-01-26', '2026-04-03', '2026-04-06', '2026-06-08', '2026-10-05', '2026-12-25', '2026-12-28',
  '2027-01-01', '2027-01-26', '2027-03-26', '2027-03-29', '2027-06-14', '2027-10-04', '2027-12-27', '2027-12-28',
]);
function addDay(ymd, n) { const [y, m, d] = ymd.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10); }
export function wallToUtc(ymd, h) { const [y, m, d] = ymd.split('-').map(Number); const guess = Date.UTC(y, m - 1, d, h) - 600 * 60000; return Date.UTC(y, m - 1, d, h) - sydOffsetMin(guess) * 60000; }
export function isWorkday(ymd) { const [y, m, d] = ymd.split('-').map(Number); const w = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); return w >= 1 && w <= 5 && !HOLIDAYS.has(ymd); }
// milliseconds of business time between a and b
export function businessMs(a, b) {
  if (!(b > a)) return 0;
  let total = 0, ymd = sydYmd(a); const last = sydYmd(b);
  for (let i = 0; i < 800; i++) {
    if (isWorkday(ymd)) { const s = wallToUtc(ymd, OPEN_H), e = wallToUtc(ymd, CLOSE_H); total += Math.max(0, Math.min(b, e) - Math.max(a, s)); }
    if (ymd === last) break; ymd = addDay(ymd, 1);
  }
  return total;
}
