// GET /api/sync  — run by GitHub Actions every 15 minutes (Authorization: Bearer CRON_SECRET), or manually with ?key=MFC_SECRET
// GET /api/sync?key=...&backfill=YYYY-MM-DD  — loads opportunities created from that date forward, a few weeks per call;
//     returns "next" to call again with until done.
import { runSync, oppsCreatedBetween, upsertOpps } from '../lib/store.js';
import { ensureSchema, getState, setState } from '../lib/db.js';
import { sydMidnight } from '../lib/speed.js';
import { maybeSendPpAlerts } from '../lib/pp-alerts.js';
import { maybeSyncMeta } from '../lib/ads.js';

function authed(req) {
  const auth = req.headers.authorization || '';
  if (process.env.CRON_SECRET && auth === 'Bearer ' + process.env.CRON_SECRET) return true;
  const k = req.query.key; return !!k && (k === process.env.MFC_SECRET || k === process.env.DASH_KEY);
}
function addDays(ymd, n) { const [y, m, d] = ymd.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10); }

export default async function handler(req, res) {
  try {
    if (!authed(req)) return res.status(401).json({ error: 'bad key' });
    res.setHeader('Cache-Control', 'no-store');
    if (req.query.backfill) {
      await ensureSchema();
      let from = req.query.backfill; const until = req.query.until || new Date().toISOString().slice(0, 10);
      const t0 = Date.now(); let loaded = 0;
      while (from <= until && Date.now() - t0 < 40000) {
        const to = addDays(from, 7);
        const ops = await oppsCreatedBetween(sydMidnight(from), sydMidnight(to));
        loaded += await upsertOpps(ops);
        from = to;
      }
      await setState('backfill', { next: from <= until ? from : null, at: Date.now() });
      return res.status(200).json({ ok: true, loaded, next: from <= until ? from : null });
    }
    await ensureSchema();
    const running = await getState('sync_lock');
    if (running && Date.now() - running < 55000) return res.status(200).json({ skipped: 'already running' });
    await setState('sync_lock', Date.now());
    // ?budget=20 keeps the whole request under ~30s for cron services with short timeouts (cron-job.org)
    const budget = Math.min(45, Math.max(10, parseInt(req.query.budget, 10) || 45));
    const log = await runSync({ budgetMs: budget * 1000 });
    try { log.pp = await maybeSendPpAlerts(); } catch (e) { log.ppError = e.message; }
    try { log.meta = await maybeSyncMeta(); } catch (e) { log.metaError = e.message; }
    await setState('sync_lock', 0);
    return res.status(200).json({ ok: true, log });
  } catch (e) {
    console.error(e);
    try { await setState('sync_lock', 0); } catch (x) { /* ignore */ }
    return res.status(e.rateLimited ? 503 : 500).json({ error: e.message });
  }
}
