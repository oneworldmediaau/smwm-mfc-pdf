// Paraplanning tracker: schema, auth, jobs, history, alerts.
import crypto from 'crypto';
import { q } from './db.js';

export const LISTS = {
  stream: ['SOA / ROA', 'Onboarding', 'Review', 'Implementation request'],
  paraplanner: ['Alexa', 'Angela', 'Joseph', 'Unallocated'],
  adviser: ['Charlie Abd', 'Peter Kaleski'],
  strategy: ['SMSF', 'Non-SMSF'],
  doc_type: ['SOA', 'ROA', 'SOA/ROA', 'Rework SOA', 'Rework ROA', 'Retirement Modelling', 'Rework Retirement Modelling', 'Strategy Check'],
  priority: ['Urgent', 'Non-urgent'],
  status: ['Not Started', 'In Progress', 'On Hold', 'Completed', 'Cancelled'],
  strategy_done: ['Pending', 'Yes'],
};
const FIELDS = ['stream', 'client', 'paraplanner', 'adviser', 'strategy', 'doc_type', 'priority', 'priority_no', 'status',
  'date_requested', 'date_completed', 'fee_expiry', 'seen_date', 'strategy_done', 'notes'];
const DATE_FIELDS = ['date_requested', 'date_completed', 'fee_expiry', 'seen_date'];

let ready = false;
export async function ppSchema() {
  if (ready) return;
  const stmts = [
    `create table if not exists pp_users (id serial primary key, email text unique not null, name text not null,
      role text not null default 'editor', adviser_name text, pass_hash text, must_change boolean default true,
      active boolean default true, failed int default 0, locked_until timestamptz, created_at timestamptz default now())`,
    `create table if not exists pp_jobs (id serial primary key, stream text, client text not null, paraplanner text, adviser text,
      strategy text, doc_type text, priority text, priority_no int, status text default 'Not Started',
      date_requested date, date_completed date, fee_expiry date, seen_date date, strategy_done text, notes text,
      archived boolean default false, created_by text, created_at timestamptz default now(), updated_by text, updated_at timestamptz default now())`,
    `create table if not exists pp_history (id bigserial primary key, job_id int, user_name text, at timestamptz default now(),
      field text, old_value text, new_value text)`,
    `create index if not exists pp_history_job on pp_history (job_id)`,
    `create table if not exists pp_comments (id bigserial primary key, job_id int, user_name text, at timestamptz default now(), body text)`,
    `create index if not exists pp_comments_job on pp_comments (job_id)`,
  ];
  for (const s of stmts) await q(s);
  ready = true;
}

// ---- passwords + sessions
function hashPw(pw) { const salt = crypto.randomBytes(16).toString('hex'); const h = crypto.scryptSync(pw, salt, 64).toString('hex'); return salt + ':' + h; }
function checkPw(pw, stored) {
  if (!stored) return false; const [salt, h] = stored.split(':');
  const a = Buffer.from(h, 'hex'), b = crypto.scryptSync(pw, salt, 64); return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function secret() { const s = process.env.PP_SECRET || process.env.MFC_SECRET; if (!s) throw new Error('PP_SECRET not set'); return s; }
function sign(payload) { const body = Buffer.from(JSON.stringify(payload)).toString('base64url'); return body + '.' + crypto.createHmac('sha256', secret()).update(body).digest('base64url'); }
function unsign(tok) {
  if (!tok || tok.indexOf('.') < 0) return null; const [body, sig] = tok.split('.');
  const good = crypto.createHmac('sha256', secret()).update(body).digest('base64url');
  if (sig.length !== good.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good))) return null;
  const p = JSON.parse(Buffer.from(body, 'base64url').toString()); return p.exp > Date.now() ? p : null;
}
export function sessionCookie(user) {
  const tok = sign({ uid: user.id, v: (user.pass_hash || '').slice(-12), exp: Date.now() + 30 * 864e5 });
  return 'pp_session=' + tok + '; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=' + 30 * 86400;
}
export const clearCookie = 'pp_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0';
export async function currentUser(req) {
  const m = (req.headers.cookie || '').match(/(?:^|;\s*)pp_session=([^;]+)/); const p = m && unsign(m[1]);
  if (!p) return null;
  const r = await q('select * from pp_users where id=$1 and active', [p.uid]);
  const u = r[0]; if (!u || (u.pass_hash || '').slice(-12) !== p.v) return null; // password change logs out old sessions
  return u;
}
export function publicUser(u) { return u && { id: u.id, email: u.email, name: u.name, role: u.role, adviser_name: u.adviser_name, must_change: u.must_change }; }

export async function login(email, pw) {
  const r = await q('select * from pp_users where lower(email)=lower($1)', [String(email || '').trim()]);
  const u = r[0];
  if (!u || !u.active) { await new Promise((z) => setTimeout(z, 600)); return { error: 'Email or password is incorrect.' }; }
  if (u.locked_until && new Date(u.locked_until) > new Date()) return { error: 'Too many attempts. Try again in 15 minutes.' };
  if (!checkPw(String(pw || ''), u.pass_hash)) {
    const failed = (u.failed || 0) + 1;
    await q('update pp_users set failed=$2, locked_until=$3 where id=$1', [u.id, failed >= 5 ? 0 : failed, failed >= 5 ? new Date(Date.now() + 15 * 60000).toISOString() : null]);
    await new Promise((z) => setTimeout(z, 600)); return { error: 'Email or password is incorrect.' };
  }
  await q('update pp_users set failed=0, locked_until=null where id=$1', [u.id]);
  return { user: u };
}
export function pwProblem(pw) { pw = String(pw || ''); if (pw.length < 10) return 'Use at least 10 characters.'; return null; }
export async function setPassword(uid, pw, mustChange) {
  await q('update pp_users set pass_hash=$2, must_change=$3, failed=0, locked_until=null where id=$1', [uid, hashPw(pw), !!mustChange]);
  return (await q('select * from pp_users where id=$1', [uid]))[0];
}
export function tempPassword() { return crypto.randomBytes(9).toString('base64url'); }

// ---- users (admin)
export async function listUsers() { return q('select id, email, name, role, adviser_name, active, must_change, created_at from pp_users order by role, name'); }
export async function saveUser(d) {
  const role = ['admin', 'editor', 'adviser'].includes(d.role) ? d.role : 'editor';
  if (d.id) {
    const cur = (await q('select role, active from pp_users where id=$1', [d.id]))[0]; if (!cur) throw new Error('User not found.');
    if (role === 'adviser' && !d.adviser_name) throw new Error('Choose which adviser this login is for.');
    if (cur.role === 'admin' && cur.active && (role !== 'admin' || d.active === false)) {
      const n = (await q("select count(*)::int n from pp_users where role='admin' and active and id<>$1", [d.id]))[0].n;
      if (!n) throw new Error('There must always be at least one active admin. Make someone else an admin first.');
    }
    await q('update pp_users set name=$2, role=$3, adviser_name=$4, active=$5, email=$6 where id=$1', [d.id, d.name, role, d.adviser_name || null, d.active !== false, d.email]);
    return { id: d.id };
  }
  const temp = tempPassword();
  const r = await q('insert into pp_users (email, name, role, adviser_name, pass_hash, must_change) values ($1,$2,$3,$4,$5,true) returning id', [String(d.email).trim().toLowerCase(), d.name, role, d.adviser_name || null, hashPw(temp)]);
  return { id: r[0].id, tempPassword: temp };
}
export async function resetUser(id) { const temp = tempPassword(); await setPassword(id, temp, true); return { tempPassword: temp }; }
export async function userCount() { return (await q('select count(*)::int n from pp_users'))[0].n; }
export async function createAdmin(email, name, pw) {
  const r = await q("insert into pp_users (email, name, role, pass_hash, must_change) values ($1,$2,'admin',$3,false) returning *", [String(email).trim().toLowerCase(), name, hashPw(pw)]);
  return r[0];
}

// ---- jobs
function clean(field, v) {
  if (v === '' || v == null) return null;
  if (DATE_FIELDS.includes(field)) return /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null;
  if (field === 'priority_no') { const n = parseInt(v, 10); return isNaN(n) ? null : n; }
  return String(v).slice(0, 4000);
}
function canSee(u, j) { return u.role !== 'adviser' || (u.adviser_name && j.adviser === u.adviser_name); }
export async function listJobs(u, includeArchived) {
  const rows = await q(`select j.*, to_char(date_requested,'YYYY-MM-DD') date_requested, to_char(date_completed,'YYYY-MM-DD') date_completed,
      to_char(fee_expiry,'YYYY-MM-DD') fee_expiry, to_char(seen_date,'YYYY-MM-DD') seen_date,
      (select count(*)::int from pp_comments c where c.job_id=j.id) comments
    from pp_jobs j where ${includeArchived ? 'true' : 'not archived'} order by id`);
  return rows.filter((j) => canSee(u, j));
}
export async function getJob(u, id) {
  const j = (await listJobs(u, true)).find((x) => x.id === +id); if (!j) return null;
  const history = await q('select user_name, at, field, old_value, new_value from pp_history where job_id=$1 order by at desc limit 200', [id]);
  const comments = await q('select user_name, at, body from pp_comments where job_id=$1 order by at', [id]);
  return { job: j, history, comments };
}
// Priority numbers are a queue per paraplanner (open jobs only). Putting a job at N when another open job
// already has N slides the others along: inserting pushes N and below down one; moving a job up or down the
// queue shifts only the jobs in between, so there are no gaps or duplicates created.
const OPEN = "not archived and coalesce(status,'') not in ('Completed','Cancelled')";
async function reslot(u, id, pp, newNo, oldNo) {
  if (newNo == null) return;
  const clash = await q(`select 1 from pp_jobs where ${OPEN} and id<>$1 and coalesce(paraplanner,'')=coalesce($2,'') and priority_no=$3 limit 1`, [id, pp, newNo]);
  if (!clash.length) return;
  let rows;
  const base = `update pp_jobs p set priority_no = p.priority_no %s, updated_at=now(), updated_by=$4 from pp_jobs o
    where o.id=p.id and not p.archived and coalesce(p.status,'') not in ('Completed','Cancelled') and p.id<>$1 and coalesce(p.paraplanner,'')=coalesce($2,'') and %w
    returning p.id, o.priority_no old, p.priority_no new`;
  const run = (op, where, a, b) => q(base.replace('%s', op).replace('%w', where), b === undefined ? [id, pp, a, u.name] : [id, pp, a, u.name, b]);
  if (oldNo == null) rows = await run('+ 1', 'p.priority_no >= $3', newNo);
  else if (newNo < oldNo) rows = await run('+ 1', 'p.priority_no >= $3 and p.priority_no < $5', newNo, oldNo);
  else rows = await run('- 1', 'p.priority_no <= $3 and p.priority_no > $5', newNo, oldNo);
  for (const r of rows) await q('insert into pp_history (job_id, user_name, field, old_value, new_value) values ($1,$2,$3,$4,$5)', [r.id, u.name + ' (auto)', 'priority_no', String(r.old), String(r.new)]);
}
// A job leaving a queue (completed, cancelled, archived or moved to another paraplanner): everyone behind it moves up one.
async function closeGap(u, id, pp, no) {
  if (no == null) return;
  const rows = await q(`update pp_jobs p set priority_no = p.priority_no - 1, updated_at=now(), updated_by=$4 from pp_jobs o
    where o.id=p.id and not p.archived and coalesce(p.status,'') not in ('Completed','Cancelled') and p.id<>$1
      and coalesce(p.paraplanner,'')=coalesce($2,'') and p.priority_no > $3
    returning p.id, o.priority_no old, p.priority_no new`, [id, pp, no, u.name]);
  for (const r of rows) await q('insert into pp_history (job_id, user_name, field, old_value, new_value) values ($1,$2,$3,$4,$5)', [r.id, u.name + ' (auto)', 'priority_no', String(r.old), String(r.new)]);
}
const isOpen = (j) => !j.archived && !['Completed', 'Cancelled'].includes(j.status || '');

export async function createJob(u, d, opts = {}) {
  if (u.role === 'adviser') throw new Error('Advisers can add notes but not create jobs.');
  if (!d.client || !String(d.client).trim()) throw new Error('Client name is required.');
  const vals = FIELDS.map((f) => clean(f, d[f]));
  const no = clean('priority_no', d.priority_no), pp = clean('paraplanner', d.paraplanner);
  if (!opts.noReslot && no != null && isOpen({ status: clean('status', d.status) || 'Not Started' })) await reslot(u, 0, pp, no, null);
  const r = await q(`insert into pp_jobs (${FIELDS.join(',')}, created_by, updated_by) values (${FIELDS.map((_, i) => '$' + (i + 1)).join(',')}, $${FIELDS.length + 1}, $${FIELDS.length + 1}) returning id`, [...vals, u.name]);
  await q('insert into pp_history (job_id, user_name, field, new_value) values ($1,$2,$3,$4)', [r[0].id, u.name, 'created', d.client]);
  return r[0].id;
}
export async function updateJob(u, id, changes) {
  if (u.role === 'adviser') throw new Error('Advisers can add notes but not edit jobs.');
  const cur = (await q('select * from pp_jobs where id=$1', [id]))[0]; if (!cur) throw new Error('Job not found.');
  const sets = [], params = [id], hist = [];
  for (const f of FIELDS.concat(['archived'])) {
    if (!(f in changes)) continue;
    const v = f === 'archived' ? !!changes[f] : clean(f, changes[f]);
    let old = cur[f]; if (old instanceof Date) old = old.toISOString().slice(0, 10);
    if (String(old ?? '') === String(v ?? '')) continue;
    params.push(v); sets.push(f + '=$' + params.length); hist.push([f, old == null ? null : String(old), v == null ? null : String(v)]);
  }
  // auto-complete date
  if ('status' in changes && changes.status === 'Completed' && !cur.date_completed && !('date_completed' in changes)) {
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Australia/Sydney' });
    params.push(today); sets.push('date_completed=$' + params.length); hist.push(['date_completed', null, today]);
  }
  if (!sets.length) return 0;
  // slide other jobs along if this one now takes a priority number that's already used in that paraplanner's queue
  const after = { ...cur, ...Object.fromEntries(hist.map((h, i) => [h[0], params[i + 1]])) };
  const ppChanged = 'paraplanner' in changes && (cur.paraplanner ?? '') !== (after.paraplanner ?? '');
  const noChanged = 'priority_no' in changes && cur.priority_no !== after.priority_no;
  const reopened = !isOpen(cur) && isOpen(after);
  // leaving the open queue: take its number off and move the rest up
  if (isOpen(cur) && cur.priority_no != null && (!isOpen(after) || ppChanged)) {
    await closeGap(u, id, cur.paraplanner, cur.priority_no);
    if (!isOpen(after) && after.priority_no != null) {
      const i = hist.findIndex((h) => h[0] === 'priority_no');
      if (i >= 0) params[i + 1] = null, hist[i][2] = null;
      else { params.push(null); sets.push('priority_no=$' + params.length); hist.push(['priority_no', String(cur.priority_no), null]); }
      after.priority_no = null;
    }
  }
  if (after.priority_no != null && isOpen(after) && (ppChanged || noChanged || reopened)) {
    await reslot(u, id, after.paraplanner, after.priority_no, ppChanged || reopened ? null : cur.priority_no);
  }
  params.push(u.name); sets.push('updated_by=$' + params.length, 'updated_at=now()');
  await q('update pp_jobs set ' + sets.join(', ') + ' where id=$1', params);
  for (const h of hist) await q('insert into pp_history (job_id, user_name, field, old_value, new_value) values ($1,$2,$3,$4,$5)', [id, u.name, ...h]);
  return hist.length;
}
export async function deleteJob(u, id) {
  if (u.role === 'adviser') throw new Error('Advisers can’t delete jobs.');
  const cur = (await q('select * from pp_jobs where id=$1', [id]))[0]; if (!cur) throw new Error('Job not found.');
  if (isOpen(cur)) await closeGap(u, id, cur.paraplanner, cur.priority_no);
  await q('delete from pp_comments where job_id=$1', [id]);
  await q('delete from pp_history where job_id=$1', [id]);
  await q('delete from pp_jobs where id=$1', [id]);
  await q('insert into pp_history (job_id, user_name, field, old_value) values (null,$1,$2,$3)', [u.name, 'deleted job', cur.client + (cur.paraplanner ? ' (' + cur.paraplanner + ')' : '')]);
  return { deleted: true };
}
export async function addComment(u, id, body) {
  const j = (await q('select * from pp_jobs where id=$1', [id]))[0]; if (!j || !canSee(u, j)) throw new Error('Job not found.');
  if (!String(body || '').trim()) throw new Error('Write a note first.');
  await q('insert into pp_comments (job_id, user_name, body) values ($1,$2,$3)', [id, u.name, String(body).slice(0, 4000)]);
  await q('update pp_jobs set updated_at=now(), updated_by=$2 where id=$1', [id, u.name]);
}
// One-off tidy: completed/cancelled/archived jobs lose their number; each paraplanner's open queue becomes 1..n
// in its current order (ties broken by the order the jobs were added).
export async function renumber(u) {
  const a = await q(`update pp_jobs set priority_no=null where priority_no is not null and (archived or coalesce(status,'') in ('Completed','Cancelled')) returning id`);
  const b = await q(`with r as (select id, priority_no old, row_number() over (partition by coalesce(paraplanner,'') order by priority_no, id)::int n
      from pp_jobs where priority_no is not null and not archived and coalesce(status,'') not in ('Completed','Cancelled'))
    update pp_jobs p set priority_no=r.n from r where r.id=p.id and r.old<>r.n returning p.id, r.old, r.n`);
  for (const x of b) await q('insert into pp_history (job_id, user_name, field, old_value, new_value) values ($1,$2,$3,$4,$5)', [x.id, u.name, 'priority_no', String(x.old), String(x.n)]);
  return { cleared: a.length, renumbered: b.length };
}
export async function importJobs(u, list, replace) {
  if (replace) { await q('delete from pp_jobs'); await q('delete from pp_history'); await q('delete from pp_comments'); }
  let n = 0;
  for (const d of list) { const id = await createJob(u, d, { noReslot: true });if (d.notes_history) await addComment(u, id, d.notes_history); n++; }
  return n;
}

// ---- alerts
export async function alertData() {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Australia/Sydney' });
  const open = await q(`select id, client, paraplanner, adviser, stream, doc_type, priority, priority_no, status, notes,
      to_char(fee_expiry,'YYYY-MM-DD') fee_expiry, (fee_expiry - $1::date) days_left
    from pp_jobs where not archived and status not in ('Completed','Cancelled') order by paraplanner, priority_no nulls last, id`, [today]);
  const doneToday = await q(`select distinct j.id, j.client, j.paraplanner from pp_jobs j join pp_history h on h.job_id=j.id
    where h.field='status' and h.new_value='Completed' and (h.at at time zone 'Australia/Sydney')::date = $1::date`, [today]);
  return { today, open, doneToday };
}
