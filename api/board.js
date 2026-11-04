// Board report — one function for the page, its data, campaign→source links and the Google Ads Script feed.
//   GET  /api/board?key=DASH_KEY                       -> the page
//   GET  /api/board?a=data&key=..&from=&to=&compare=1  -> report data
//   GET  /api/board?a=suggest&key=..                   -> suggested campaign→source links
//   POST /api/board?a=links&key=..  {platform, campaign_id, sources[]}
//   POST /api/board?a=refresh&key=..                   -> pull Meta spend now
//   GET  /api/board?a=since&account=ID   (Bearer CRON_SECRET)  -> where the Google script should start from
//   POST /api/board?a=ingest             (Bearer CRON_SECRET)  -> Google Ads rows
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { ensureSchema } from '../lib/db.js';
import { sydYmd } from '../lib/speed.js';
import { boardData, setLinks, suggestions } from '../lib/board.js';
import { maybeSyncMeta, ingestGoogle, googleSince } from '../lib/ads.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const keyOk = (req) => { const k = req.query.key; return !!k && (k === process.env.DASH_KEY || k === process.env.MFC_SECRET); };
const feedOk = (req) => !!process.env.CRON_SECRET && (req.headers.authorization || '') === 'Bearer ' + process.env.CRON_SECRET;
const ymd = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || '');
function addDays(d, n) { const [y, m, x] = d.split('-').map(Number); return new Date(Date.UTC(y, m - 1, x + n)).toISOString().slice(0, 10); }

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const a = req.query.a;
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    if (a === 'since' || a === 'ingest') {
      if (!feedOk(req)) return res.status(401).json({ error: 'bad key' });
      await ensureSchema();
      if (a === 'since') return res.status(200).json({ since: await googleSince(req.query.account), until: sydYmd(Date.now()) });
      return res.status(200).json(await ingestGoogle(body));
    }
    if (!keyOk(req)) {
      if (!a) { res.setHeader('Content-Type', 'text/plain'); return res.status(401).send('Add your dashboard key to the link (?key=...).'); }
      return res.status(401).json({ error: 'bad key' });
    }
    if (!a) {
      const html = fs.readFileSync(path.join(__dirname, '..', 'lib', 'board.html'), 'utf8').replace('@@KEY@@', JSON.stringify(req.query.key));
      res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.setHeader('X-Robots-Tag', 'noindex'); res.setHeader('X-Frame-Options', 'DENY');
      return res.status(200).send(html);
    }
    await ensureSchema();
    if (a === 'data') {
      const today = sydYmd(Date.now());
      const to = ymd(req.query.to) ? req.query.to : today;
      const from = ymd(req.query.from) ? req.query.from : addDays(to, -29);
      if (from > to) return res.status(400).json({ error: 'Start date is after end date.' });
      return res.status(200).json(await boardData(from, to, req.query.compare !== '0'));
    }
    if (a === 'suggest') return res.status(200).json({ suggestions: await suggestions() });
    if (a === 'links' && req.method === 'POST') return res.status(200).json(await setLinks(body.platform, body.campaign_id, body.sources, 'dashboard'));
    if (a === 'refresh' && req.method === 'POST') return res.status(200).json({ meta: await maybeSyncMeta(true) });
    return res.status(404).json({ error: 'Unknown action' });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: e.message });
  }
}
