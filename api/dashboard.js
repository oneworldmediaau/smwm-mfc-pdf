// GET /api/dashboard?key=DASH_KEY  -> the live Speed to Lead dashboard page
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default function handler(req, res) {
  const k = req.query.key;
  if (!k || !(k === process.env.DASH_KEY || k === process.env.MFC_SECRET)) {
    res.status(401).setHeader('Content-Type', 'text/plain'); return res.send('Add your dashboard key to the link (?key=...).');
  }
  const html = fs.readFileSync(path.join(__dirname, '..', 'lib', 'dashboard.html'), 'utf8').replace('@@KEY@@', JSON.stringify(k));
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Robots-Tag', 'noindex');
  return res.status(200).send(html);
}
