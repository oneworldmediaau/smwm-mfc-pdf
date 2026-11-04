// Paraplanning tracker — one function for the page and its API (keeps Vercel's function count low).
//   GET  /api/pp                      -> the app
//   GET  /api/pp?a=me | jobs | job&id= | users
//   POST /api/pp?a=setup | login | logout | password | job | update&id= | comment&id= | user | reset&id= | import
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { ensureSchema } from '../lib/db.js';
import {
  ppSchema, LISTS, currentUser, publicUser, sessionCookie, clearCookie, login, pwProblem, setPassword,
  listUsers, saveUser, resetUser, userCount, createAdmin, listJobs, getJob, createJob, updateJob, addComment, importJobs, renumber, deleteJob,
} from '../lib/pp.js';
import { sendSnapshot } from '../lib/pp-alerts.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const json = (res, code, body) => { res.setHeader('Cache-Control', 'no-store'); return res.status(code).json(body); };

export default async function handler(req, res) {
  try {
    const a = req.query.a;
    if (!a) {
      res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Robots-Tag', 'noindex');
      res.setHeader('X-Frame-Options', 'DENY');
      return res.status(200).send(fs.readFileSync(path.join(__dirname, '..', 'lib', 'pp.html'), 'utf8'));
    }
    await ensureSchema(); await ppSchema();
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    if (req.method === 'POST' && req.headers.origin && new URL(req.headers.origin).host !== (req.headers['x-forwarded-host'] || req.headers.host)) return json(res, 403, { error: 'Bad origin' }); // same-site only

    // ---- unauthenticated
    if (a === 'setup' && req.method === 'POST') {
      if ((await userCount()) > 0) return json(res, 400, { error: 'Setup is already done.' });
      if (!body.key || body.key !== process.env.MFC_SECRET) return json(res, 401, { error: 'Setup key is wrong.' });
      const prob = pwProblem(body.password); if (prob) return json(res, 400, { error: prob });
      const u = await createAdmin(body.email, body.name, body.password);
      res.setHeader('Set-Cookie', sessionCookie(u)); return json(res, 200, { user: publicUser(u) });
    }
    if (a === 'seed' && req.method === 'POST') { // one-off import of the spreadsheet, using the setup key
      if (!body.key || body.key !== process.env.MFC_SECRET) return json(res, 401, { error: 'Setup key is wrong.' });
      return json(res, 200, { imported: await importJobs({ name: 'Spreadsheet import', role: 'admin' }, body.jobs || [], !!body.replace) });
    }
    if (a === 'renumber' && req.method === 'POST') { // one-off tidy of priority numbers, using the setup key
      if (!body.key || body.key !== process.env.MFC_SECRET) return json(res, 401, { error: 'Setup key is wrong.' });
      return json(res, 200, await renumber({ name: 'Priority tidy-up' }));
    }
    if (a === 'login' && req.method === 'POST') {
      const r = await login(body.email, body.password); if (r.error) return json(res, 401, { error: r.error });
      res.setHeader('Set-Cookie', sessionCookie(r.user)); return json(res, 200, { user: publicUser(r.user) });
    }
    if (a === 'logout') { res.setHeader('Set-Cookie', clearCookie); return json(res, 200, { ok: true }); }

    const u = await currentUser(req);
    if (a === 'me') return json(res, 200, { user: publicUser(u), lists: LISTS, needsSetup: !u && (await userCount()) === 0 });
    if (!u) return json(res, 401, { error: 'Please sign in.' });

    if (a === 'password' && req.method === 'POST') {
      const { login: chk } = { login }; const ok = await chk(u.email, body.current);
      if (ok.error) return json(res, 400, { error: 'Your current password is incorrect.' });
      const prob = pwProblem(body.next); if (prob) return json(res, 400, { error: prob });
      const nu = await setPassword(u.id, body.next, false); res.setHeader('Set-Cookie', sessionCookie(nu));
      return json(res, 200, { user: publicUser(nu) });
    }
    if (u.must_change) return json(res, 403, { error: 'Set a new password first.', mustChange: true });

    if (a === 'jobs') return json(res, 200, { jobs: await listJobs(u, req.query.archived === '1') });
    if (a === 'job' && req.method === 'GET') { const d = await getJob(u, +req.query.id); return d ? json(res, 200, d) : json(res, 404, { error: 'Job not found.' }); }
    if (a === 'job' && req.method === 'POST') return json(res, 200, { id: await createJob(u, body) });
    if (a === 'update' && req.method === 'POST') return json(res, 200, { changed: await updateJob(u, +req.query.id, body || {}) });
    if (a === 'comment' && req.method === 'POST') { await addComment(u, +req.query.id, body.body); return json(res, 200, { ok: true }); }
    if (a === 'delete' && req.method === 'POST') return json(res, 200, await deleteJob(u, +req.query.id));
    if (a === 'snapshot' && req.method === 'POST') return json(res, 200, await sendSnapshot(u, body.to, body.ids, body.view, body.note));

    if (u.role !== 'admin') return json(res, 403, { error: 'Only admins can do that.' });
    if (a === 'users') return json(res, 200, { users: await listUsers() });
    if (a === 'user' && req.method === 'POST') return json(res, 200, await saveUser(body));
    if (a === 'reset' && req.method === 'POST') return json(res, 200, await resetUser(+req.query.id));
    if (a === 'import' && req.method === 'POST') return json(res, 200, { imported: await importJobs(u, body.jobs || [], !!body.replace) });
    return json(res, 404, { error: 'Unknown action' });
  } catch (e) {
    console.error(e);
    return json(res, 400, { error: e.message });
  }
}
