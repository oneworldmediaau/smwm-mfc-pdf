// GET /api/speed-data?key=...&from=YYYY-MM-DD&to=YYYY-MM-DD   (Sydney dates, inclusive)
// Returns opportunities created in the range and in the previous period of the same length,
// with first outbound call details. Call lookups are cached; "pending" > 0 means call again for the rest.
import { LOCATION_ID, opportunitiesBetween, csrOf, csOutcomeOf, channelOf, users, loadCache, saveCache, fillCalls, sydMidnight, sydYmd, businessMs } from '../lib/speed.js';

function ok(req) {
  const k = req.query.key;
  return k && (k === process.env.DASH_KEY || k === process.env.MFC_SECRET);
}
function addDays(ymd, n) { const [y, m, d] = ymd.split('-').map(Number); const t = new Date(Date.UTC(y, m - 1, d + n)); return t.toISOString().slice(0, 10); }

export default async function handler(req, res) {
  try {
    if (!ok(req)) return res.status(401).json({ error: 'bad key' });
    const today = sydYmd(Date.now());
    const to = /^\d{4}-\d{2}-\d{2}$/.test(req.query.to || '') ? req.query.to : today;
    const from = /^\d{4}-\d{2}-\d{2}$/.test(req.query.from || '') ? req.query.from : addDays(to, -6);
    const days = Math.round((sydMidnight(addDays(to, 1)) - sydMidnight(from)) / 864e5);
    if (days < 1 || days > 120) return res.status(400).json({ error: 'Choose a range of 1 to 120 days.' });
    const pFrom = addDays(from, -days), pTo = addDays(from, -1);

    const start = sydMidnight(from), end = sydMidnight(addDays(to, 1)), pStart = sydMidnight(pFrom);
    const all = await opportunitiesBetween(pStart, end);
    const cache = await loadCache();
    const { changed, pending } = await fillCalls(all, cache, 38000);
    if (changed) await saveCache(cache);
    const U = await users();

    const row = (o) => {
      const created = new Date(o.createdAt).getTime(), e = cache[o.id];
      return {
        id: o.id, contactId: o.contactId, name: (o.contact && o.contact.name) || o.name, phone: (o.contact && o.contact.phone) || '',
        rep: csrOf(o) || 'Unassigned', outcome: csOutcomeOf(o), source: o.source || '—', channel: channelOf(o), status: o.status,
        created, call: e && e.c ? e.c : null, caller: e && e.u ? (U[e.u] || 'Team member') : '', dur: e ? e.d : 0,
        checked: !!e,
        biz: e && e.c ? businessMs(created, e.c) : null,
        wait: e && !e.c ? businessMs(created, Date.now()) : null,
      };
    };
    const cur = [], prev = [];
    // Leads marked DNQ by customer service with no outbound call are excluded (deemed not qualified)
    all.forEach((o) => { const e = cache[o.id]; if (e && !e.c && csOutcomeOf(o) === 'DNQ') return; const t = new Date(o.createdAt).getTime(); (t >= start ? cur : prev).push(row(o)); });
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ app: (process.env.GHL_APP_URL || 'https://crm.smartmoneygroup.com.au').replace(/\/$/, '') + '/v2/location/' + LOCATION_ID + '/contacts/detail/', from, to, prevFrom: pFrom, prevTo: pTo, days, pending, rows: cur, prev, generated: Date.now() });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: e.message });
  }
}
