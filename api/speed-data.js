// GET /api/speed-data?key=...&from=YYYY-MM-DD&to=YYYY-MM-DD   (Sydney dates, inclusive)
// Reads from the reporting database (kept fresh by /api/sync every 15 minutes) — no GHL calls.
import { LOCATION_ID, sydMidnight, sydYmd } from '../lib/speed.js';
import { speedRows, lastSync } from '../lib/store.js';
import { ensureSchema } from '../lib/db.js';

function ok(req) { const k = req.query.key; return k && (k === process.env.DASH_KEY || k === process.env.MFC_SECRET); }
function addDays(ymd, n) { const [y, m, d] = ymd.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10); }

export default async function handler(req, res) {
  try {
    if (!ok(req)) return res.status(401).json({ error: 'bad key' });
    await ensureSchema();
    const today = sydYmd(Date.now());
    const to = /^\d{4}-\d{2}-\d{2}$/.test(req.query.to || '') ? req.query.to : today;
    const from = /^\d{4}-\d{2}-\d{2}$/.test(req.query.from || '') ? req.query.from : addDays(to, -6);
    const days = Math.round((sydMidnight(addDays(to, 1)) - sydMidnight(from)) / 864e5);
    if (days < 1 || days > 400) return res.status(400).json({ error: 'Choose a range of 1 to 400 days.' });
    const pFrom = addDays(from, -days), pTo = addDays(from, -1);
    const start = sydMidnight(from), end = sydMidnight(addDays(to, 1)), pStart = sydMidnight(pFrom);
    const all = await speedRows(pStart, end);
    const cur = all.filter((r) => r.created >= start), prev = all.filter((r) => r.created < start);
    const pending = all.filter((r) => !r.checked).length;
    const sync = await lastSync();
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({
      app: (process.env.GHL_APP_URL || 'https://crm.smartmoneygroup.com.au').replace(/\/$/, '') + '/v2/location/' + LOCATION_ID + '/contacts/detail/',
      from, to, prevFrom: pFrom, prevTo: pTo, days, pending, rows: cur, prev, generated: sync ? sync.at : Date.now(), fromDb: true,
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: e.message });
  }
}
