// Daily speed-to-lead report.
// GET /api/daily-report?key=MFC_SECRET            -> builds and emails the report
// GET /api/daily-report?key=MFC_SECRET&dry=1      -> returns the report HTML, sends nothing
// Called by Vercel Cron (see vercel.json); it only sends when it's 6pm in Sydney.
//
// Report: every opportunity created in the last 24 hours (6pm yesterday → 6pm today, Sydney time)
// whose "Customer Service Representative" is Matt Horne or Jarrod Bray, and how long it took
// for the first outbound call to that lead after the opportunity was created.

import { businessMs } from '../lib/speed.js';
const API = 'https://services.leadconnectorhq.com';
const LOCATION_ID = 'BOPw9TAczSRgLZCpM1Ur';
const CSR_FIELD = 'sSTk9wqOdy13laKJ6JWK';
const REPS = ['Matt Horne', 'Jarrod Bray'];
const TO_EMAIL = process.env.REPORT_TO || 'daniel.harmis@smartmoneygroup.com.au';
const TZ = 'Australia/Sydney';

const H = () => ({ Authorization: 'Bearer ' + process.env.GHL_TOKEN, Version: '2021-07-28', Accept: 'application/json' });
async function ghl(method, path, body) {
  const res = await fetch(API + path, { method, headers: Object.assign(H(), body ? { 'Content-Type': 'application/json' } : {}), body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch (e) { data = text; }
  if (!res.ok) throw new Error(method + ' ' + path + ' -> ' + res.status + ' ' + String(text).slice(0, 300));
  return data;
}

// ---- time helpers (Sydney)
function sydParts(d) {
  const p = {}; new Intl.DateTimeFormat('en-AU', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })
    .formatToParts(d).forEach((x) => { p[x.type] = x.value; });
  return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour % 24, min: +p.minute };
}
function sydTime(d) { return new Date(d).toLocaleString('en-AU', { timeZone: TZ, weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }); }
function mdy(d) { const p = sydParts(d); return String(p.m).padStart(2, '0') + '-' + String(p.d).padStart(2, '0') + '-' + p.y; }
function dur(ms) {
  if (ms < 0) ms = 0; const m = Math.round(ms / 60000);
  if (m < 60) return m + ' min'; const h = Math.floor(m / 60), r = m % 60;
  if (h < 24) return h + 'h ' + r + 'm'; const d = Math.floor(h / 24); return d + 'd ' + (h % 24) + 'h';
}

// ---- data
async function opportunitiesSince(start, end) {
  const out = []; let startAfter = null, startAfterId = null;
  for (let i = 0; i < 20; i++) {
    const q = new URLSearchParams({ location_id: LOCATION_ID, date: mdy(new Date(start.getTime() - 864e5)), endDate: mdy(new Date(end.getTime() + 864e5)), limit: '100', status: 'all' });
    if (startAfter) { q.set('startAfter', startAfter); q.set('startAfterId', startAfterId); }
    const d = await ghl('GET', '/opportunities/search?' + q);
    const ops = d.opportunities || [];
    out.push(...ops);
    if (ops.length < 100 || !d.meta || !d.meta.startAfterId) break;
    startAfter = d.meta.startAfter; startAfterId = d.meta.startAfterId;
  }
  return out.filter((o) => { const t = new Date(o.createdAt).getTime(); return t >= start.getTime() && t < end.getTime(); });
}
function csrOf(o) {
  const f = (o.customFields || []).find((c) => c.id === CSR_FIELD);
  if (!f) return '';
  return String(f.fieldValueString || f.fieldValue || f.value || '');
}
async function firstOutboundCall(contactId, after) {
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
        if (m.direction === 'outbound' && t >= after && (!best || t < best.t)) best = { t, userId: m.userId, status: (m.meta && m.meta.call && m.meta.call.status) || m.status, duration: m.meta && m.meta.call && m.meta.call.duration };
      }
      if (!box.nextPage || !box.lastMessageId) break; last = box.lastMessageId;
    }
  }
  return best;
}
let USERS = null;
async function userName(id) {
  if (!id) return '';
  if (!USERS) { USERS = {}; try { const d = await ghl('GET', '/users/?locationId=' + LOCATION_ID); (d.users || []).forEach((u) => { USERS[u.id] = (u.firstName || '') + ' ' + (u.lastName || ''); }); } catch (e) { /* users scope missing */ } }
  return (USERS[id] || '').trim() || 'Team member';
}

// ---- report
function badge(ms) {
  if (ms == null) return ['Not called yet', '#9A3B2E', '#F7E3DF'];
  const m = ms / 60000;
  if (m <= 5) return [dur(ms), '#1F6B3F', '#E2F1E7'];
  if (m <= 60) return [dur(ms), '#2E5A40', '#EAF0EA'];
  if (m <= 240) return [dur(ms), '#7A5514', '#F6EBD3'];
  return [dur(ms), '#9A3B2E', '#F7E3DF'];
}
function html(rows, start, end) {
  const byRep = {}; REPS.forEach((r) => { byRep[r] = { n: 0, called: 0, total: 0 }; });
  rows.forEach((r) => { const b = byRep[r.rep]; b.n++; if (r.ms != null) { b.called++; b.total += r.ms; } });
  const cell = 'padding:10px 8px;border-bottom:1px solid #E4DCC8;font-family:Arial,sans-serif;font-size:13px;color:#26332A;vertical-align:top;';
  const head = 'padding:8px;font-family:Arial,sans-serif;font-size:11px;letter-spacing:1px;text-transform:uppercase;color:#5E6B60;text-align:left;border-bottom:2px solid #153B24;';
  const summary = REPS.map((r) => { const b = byRep[r]; return `<td style="padding:14px 16px;background:#F3EEE2;border-radius:10px;font-family:Arial,sans-serif;width:50%"><div style="font-size:11px;letter-spacing:1px;text-transform:uppercase;color:#5E6B60;font-weight:bold">${r}</div><div style="font-family:Georgia,serif;font-size:24px;color:#153B24;font-weight:bold;margin:4px 0">${b.n} new</div><div style="font-size:13px;color:#26332A">${b.called} called · avg first call ${b.called ? dur(b.total / b.called) : '–'}${b.n - b.called ? ` · <b style="color:#9A3B2E">${b.n - b.called} not called</b>` : ''}</div></td>`; }).join('<td style="width:12px"></td>');
  const body = rows.length ? rows.map((r) => { const [t, fg, bg] = badge(r.ms); return `<tr>
<td style="${cell}"><b style="color:#153B24">${r.name}</b><br><span style="color:#5E6B60">${r.phone || ''}</span></td>
<td style="${cell}">${r.rep}<br><span style="color:#5E6B60">${r.source}</span></td><td style="${cell}">${sydTime(r.created)}</td>
<td style="${cell}">${r.call ? sydTime(r.call.t) + '<br><span style="color:#5E6B60">' + (r.caller || '') + (r.call.duration ? ' · ' + (r.call.duration < 60 ? r.call.duration + ' sec call' : Math.round(r.call.duration / 60) + ' min call') : '') + '</span>' : '<span style="color:#9A3B2E">–</span>'}</td>
<td style="${cell}"><span style="display:inline-block;padding:4px 10px;border-radius:999px;background:${bg};color:${fg};font-weight:bold;white-space:nowrap">${t}</span><br><span style="color:#5E6B60;font-size:11px">${r.clock != null ? dur(r.clock) + ' clock' : 'waiting ' + dur(r.wait) + ' (business)'}</span></td></tr>`; }).join('')
    : `<tr><td colspan="5" style="${cell}text-align:center;color:#5E6B60">No new opportunities for Matt or Jarrod in this period.</td></tr>`;
  return `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#FBF8F1">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#FBF8F1"><tr><td align="center" style="padding:24px 10px">
<table role="presentation" width="680" cellpadding="0" cellspacing="0" style="max-width:680px;width:100%;background:#fff;border:1px solid #E4DCC8;border-radius:14px">
<tr><td style="background:#153B24;padding:24px 28px;border-radius:14px 14px 0 0"><div style="font-family:Arial,sans-serif;font-size:11px;letter-spacing:2px;text-transform:uppercase;color:#C8973F;font-weight:bold">Daily speed-to-lead report</div>
<div style="font-family:Georgia,serif;font-size:26px;color:#FBF8F1;font-weight:bold;margin-top:6px">${rows.length} new lead${rows.length === 1 ? '' : 's'} for Matt and Jarrod</div>
<div style="font-family:Arial,sans-serif;font-size:13px;color:#B9C8BC;margin-top:4px">${sydTime(start)} → ${sydTime(end)}</div></td></tr>
<tr><td style="padding:20px 28px 6px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>${summary}</tr></table></td></tr>
<tr><td style="padding:14px 28px 24px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0">
<tr><th style="${head}">Lead</th><th style="${head}">Rep / Source</th><th style="${head}">Created</th><th style="${head}">First outbound call</th><th style="${head}">Time to call (business hrs)</th></tr>${body}</table>
<p style="font-family:Arial,sans-serif;font-size:11px;color:#5E6B60;margin-top:14px">Leads marked DNQ by customer service with no call are left out. Time to call counts business hours only (Mon–Fri 10am–6pm Sydney, excluding NSW public holidays): a lead that arrives after hours starts the clock at 10am the next working day. Clock time is shown underneath.</p></td></tr>
</table></td></tr></table></body></html>`;
}
async function reportContactId() {
  const d = await ghl('GET', '/contacts/search/duplicate?' + new URLSearchParams({ locationId: LOCATION_ID, email: TO_EMAIL }));
  if (d.contact && d.contact.id) return d.contact.id;
  const c = await ghl('POST', '/contacts/upsert', { locationId: LOCATION_ID, email: TO_EMAIL, firstName: 'Daily', lastName: 'Report', tags: ['internal-report'] });
  return (c.contact && c.contact.id) || c.id;
}

export default async function handler(req, res) {
  try {
    if (!process.env.MFC_SECRET || req.query.key !== process.env.MFC_SECRET) {
      // Vercel Cron sends "Authorization: Bearer <CRON_SECRET>" when CRON_SECRET is set
      const auth = req.headers.authorization || '';
      if (!(process.env.CRON_SECRET && auth === 'Bearer ' + process.env.CRON_SECRET)) return res.status(401).json({ error: 'bad key' });
    }
    const dry = req.query.dry === '1', force = req.query.force === '1';
    const now = new Date(), p = sydParts(now);
    if (!dry && !force && p.h !== 18) return res.status(200).json({ skipped: 'not 6pm in Sydney', sydneyHour: p.h });

    // window: 24 hours ending now (6pm → 6pm when run on schedule)
    const end = now, start = new Date(now.getTime() - 24 * 3600e3);
    const ops = (await opportunitiesSince(start, end)).filter((o) => REPS.includes(csrOf(o)));
    const rows = [];
    for (const o of ops) {
      const created = new Date(o.createdAt).getTime();
      const call = await firstOutboundCall(o.contactId, created);
      const outcome = ((o.customFields || []).find((c) => c.id === 'cjUKFO9YUNYmIZexnK2b') || {});
      if (!call && String(outcome.fieldValueString || outcome.fieldValue || outcome.value || '') === 'DNQ') continue; // not qualified, no call needed
      rows.push({ source: o.source || '—', name: (o.contact && o.contact.name) || o.name, phone: o.contact && o.contact.phone, rep: csrOf(o), created, call, ms: call ? businessMs(created, call.t) : null, clock: call ? call.t - created : null, wait: call ? null : businessMs(created, Date.now()), caller: call ? await userName(call.userId) : '' });
    }
    rows.sort((a, b) => a.created - b.created);
    const out = html(rows, start, end);
    if (dry) { res.setHeader('Content-Type', 'text/html; charset=utf-8'); return res.status(200).send(out); }

    const contactId = await reportContactId();
    const subject = 'Speed-to-lead: ' + rows.length + ' new for Matt & Jarrod · ' + new Date().toLocaleDateString('en-AU', { timeZone: TZ, weekday: 'short', day: 'numeric', month: 'short' });
    await ghl('POST', '/conversations/messages', { type: 'Email', contactId, subject, html: out, emailTo: TO_EMAIL });
    return res.status(200).json({ ok: true, sent: TO_EMAIL, leads: rows.length });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: e.message });
  }
}
