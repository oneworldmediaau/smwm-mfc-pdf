// Paraplanning alerts: morning fee-expiry warnings to each paraplanner, evening summary to the admin.
import { q } from './db.js';
import { ppSchema, alertData } from './pp.js';
import { sendEmail } from './mail.js';
import { getState, setState } from './db.js';
import { sydParts, sydYmd } from './speed.js';

const APP = 'https://smwm-mfc-pdf-five.vercel.app/api/pp';
const SUMMARY_TO = process.env.PP_SUMMARY_TO || 'daniel.harmis@smartmoneygroup.com.au';
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const nice = (ymd) => ymd ? new Date(ymd + 'T00:00:00Z').toLocaleDateString('en-AU', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }) : '';

function shell(title, sub, body) {
  return `<!DOCTYPE html><html><body style="margin:0;background:#FBF8F1"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#FBF8F1"><tr><td align="center" style="padding:24px 10px">
<table role="presentation" width="680" cellpadding="0" cellspacing="0" style="max-width:680px;width:100%;background:#fff;border:1px solid #E4DCC8;border-radius:14px">
<tr><td style="background:#153B24;padding:22px 26px;border-radius:14px 14px 0 0"><div style="font-family:Arial,sans-serif;font-size:11px;letter-spacing:2px;text-transform:uppercase;color:#C8973F;font-weight:bold">Paraplanning tracker</div>
<div style="font-family:Georgia,serif;font-size:24px;color:#FBF8F1;font-weight:bold;margin-top:6px">${title}</div><div style="font-family:Arial,sans-serif;font-size:13px;color:#B9C8BC;margin-top:4px">${sub}</div></td></tr>
<tr><td style="padding:18px 26px 24px;font-family:Arial,sans-serif;font-size:14px;color:#26332A">${body}
<p style="margin-top:18px"><a href="${APP}" style="display:inline-block;background:#153B24;color:#fff;text-decoration:none;font-weight:bold;padding:11px 20px;border-radius:999px">Open the tracker</a></p></td></tr></table></td></tr></table></body></html>`;
}
const cell = 'padding:8px 6px;border-bottom:1px solid #E4DCC8;font-family:Arial,sans-serif;font-size:13px;vertical-align:top';
function table(rows, cols) {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>${cols.map((c) => `<th style="${cell};text-align:left;font-size:11px;letter-spacing:1px;text-transform:uppercase;color:#5E6B60;border-bottom:2px solid #153B24">${c[0]}</th>`).join('')}</tr>
${rows.map((r) => '<tr>' + cols.map((c) => `<td style="${cell}">${c[1](r)}</td>`).join('') + '</tr>').join('')}</table>`;
}
function feeBadge(r) {
  const d = r.days_left;
  const [bg, fg, t] = d < 0 ? ['#F7E3DF', '#9A3B2E', 'Expired ' + (-d) + ' day' + (d === -1 ? '' : 's') + ' ago'] : d === 0 ? ['#F7E3DF', '#9A3B2E', 'Expires today'] : ['#F6EBD3', '#7A5514', d + ' day' + (d === 1 ? '' : 's') + ' left'];
  return `<span style="display:inline-block;padding:3px 9px;border-radius:999px;background:${bg};color:${fg};font-weight:bold;white-space:nowrap">${t}</span><br><span style="color:#5E6B60;font-size:12px">${nice(r.fee_expiry)}</span>`;
}

export async function morningFeeAlerts() {
  await ppSchema();
  const { open } = await alertData();
  const users = await q("select email, name from pp_users where active and role in ('editor','admin')");
  const due = open.filter((r) => r.fee_expiry && r.days_left <= 7);
  let sent = 0;
  for (const u of users) {
    const first = u.name.split(' ')[0];
    const mine = due.filter((r) => r.paraplanner && r.paraplanner.toLowerCase() === first.toLowerCase());
    if (!mine.length) continue;
    const body = `<p>Hi ${esc(first)}, these jobs have fees that have expired or expire in the next 7 days:</p>` +
      table(mine, [['Client', (r) => '<b>' + esc(r.client) + '</b><br><span style="color:#5E6B60">' + esc(r.adviser || '') + '</span>'], ['Job', (r) => esc([r.doc_type, r.stream].filter(Boolean).join(' · '))], ['Status', (r) => esc(r.status)], ['Fees', feeBadge]]);
    await sendEmail(u.email, u.name, `Fees expiring: ${mine.length} job${mine.length === 1 ? '' : 's'} need attention`, shell(`${mine.length} job${mine.length === 1 ? '' : 's'} with fees expiring`, 'Expired or expiring within 7 days', body));
    sent++;
  }
  return { sent, due: due.length };
}

export async function eveningSummary() {
  await ppSchema();
  const { today, open, doneToday } = await alertData();
  const pps = [...new Set(open.map((r) => r.paraplanner || 'Unallocated'))].sort();
  const box = (label, n, red) => `<td style="padding:12px 14px;background:${red && n ? '#F7E3DF' : '#F3EEE2'};border-radius:10px;font-family:Arial,sans-serif"><div style="font-size:11px;letter-spacing:1px;text-transform:uppercase;color:#5E6B60;font-weight:bold">${label}</div><div style="font-family:Georgia,serif;font-size:24px;color:${red && n ? '#9A3B2E' : '#153B24'};font-weight:bold">${n}</div></td>`;
  const expiring = open.filter((r) => r.fee_expiry && r.days_left <= 7);
  let body = `<table role="presentation" width="100%" cellpadding="0" cellspacing="6"><tr>${box('Open jobs', open.length)}${box('Urgent', open.filter((r) => r.priority === 'Urgent').length)}${box('Fees ≤7 days / expired', expiring.length, true)}${box('Completed today', doneToday.length)}</tr></table>`;
  body += '<h3 style="font-family:Georgia,serif;color:#153B24;margin:18px 0 6px">By paraplanner</h3>' + table(pps.map((p) => {
    const m = open.filter((r) => (r.paraplanner || 'Unallocated') === p);
    return { p, n: m.length, ns: m.filter((r) => r.status === 'Not Started').length, ip: m.filter((r) => r.status === 'In Progress').length, oh: m.filter((r) => r.status === 'On Hold').length, ur: m.filter((r) => r.priority === 'Urgent').length, ex: m.filter((r) => r.fee_expiry && r.days_left <= 7).length };
  }), [['Paraplanner', (r) => '<b>' + esc(r.p) + '</b>'], ['Open', (r) => r.n], ['Not started', (r) => r.ns], ['In progress', (r) => r.ip], ['On hold', (r) => r.oh], ['Urgent', (r) => r.ur], ['Fees ≤7d', (r) => r.ex ? '<b style="color:#9A3B2E">' + r.ex + '</b>' : '0']]);
  if (expiring.length) body += '<h3 style="font-family:Georgia,serif;color:#153B24;margin:18px 0 6px">Fees expired or expiring</h3>' + table(expiring, [['Client', (r) => '<b>' + esc(r.client) + '</b>'], ['Paraplanner', (r) => esc(r.paraplanner || 'Unallocated')], ['Status', (r) => esc(r.status)], ['Fees', feeBadge]]);
  if (doneToday.length) body += '<h3 style="font-family:Georgia,serif;color:#153B24;margin:18px 0 6px">Completed today</h3>' + table(doneToday, [['Client', (r) => esc(r.client)], ['Paraplanner', (r) => esc(r.paraplanner || '')]]);
  await sendEmail(SUMMARY_TO, 'Daniel Harmis', `Paraplanning: ${open.length} open · ${expiring.length} fees expiring · ${doneToday.length} done today`, shell('Paraplanning daily summary', nice(today), body));
  return { open: open.length };
}

// "Email snapshot" button: sends the jobs currently on screen (by id, in on-screen order) to an address the user types.
export async function sendSnapshot(u, to, ids, view, note) {
  to = String(to || '').trim().toLowerCase();
  if (!/^[^\s@<>]+@[^\s@<>]+\.[a-z]{2,}$/.test(to)) throw new Error('Enter a valid email address.');
  ids = (Array.isArray(ids) ? ids : []).map(Number).filter(Boolean).slice(0, 500);
  if (!ids.length) throw new Error('There are no jobs in this view to send.');
  const { listJobs } = await import('./pp.js');
  const today = sydYmd(Date.now()), t0 = Date.parse(today + 'T00:00:00Z');
  const byId = new Map((await listJobs(u, true)).map((j) => [j.id, j]));
  const rows = ids.map((id) => byId.get(id)).filter(Boolean).map((j) => ({ ...j, days_left: j.fee_expiry ? Math.round((Date.parse(j.fee_expiry + 'T00:00:00Z') - t0) / 864e5) : null }));
  if (!rows.length) throw new Error('There are no jobs in this view to send.');
  const fee = (r) => r.fee_expiry ? (r.days_left <= 7 ? feeBadge(r) : esc(nice(r.fee_expiry))) : '';
  let body = `<p style="margin:0 0 6px">${esc(u.name)} sent you this snapshot of the paraplanning tracker.</p>` +
    (note ? `<p style="margin:0 0 12px;padding:10px 12px;background:#F3EEE2;border-radius:8px">${esc(String(note).slice(0, 1000)).replace(/\n/g, '<br>')}</p>` : '') +
    table(rows, [['#', (r) => r.priority_no ?? ''], ['Client', (r) => '<b>' + esc(r.client) + '</b><br><span style="color:#5E6B60">' + esc(r.adviser || '') + '</span>'],
      ['Paraplanner', (r) => esc(r.paraplanner || 'Unallocated')], ['Job', (r) => esc([r.doc_type || r.stream, r.strategy].filter(Boolean).join(' · '))],
      ['Status', (r) => esc(r.status || '') + (r.priority === 'Urgent' ? '<br><b style="color:#9A3B2E">Urgent</b>' : '')], ['Fees expire', fee], ['Notes', (r) => esc(r.notes || '')]]);
  await sendEmail(to, '', `Paraplanning snapshot: ${view || 'tracker'} (${rows.length} job${rows.length === 1 ? '' : 's'})`,
    shell('Paraplanning snapshot', esc(view || '') + ' · ' + rows.length + ' job' + (rows.length === 1 ? '' : 's') + ' · ' + nice(today), body));
  await q('insert into pp_history (job_id, user_name, field, new_value) values (null,$1,$2,$3)', [u.name, 'snapshot', to + ' (' + rows.length + ' jobs)']);
  return { sent: rows.length };
}

// Called from the 15-minute sync: sends each alert once a day in its time window (Sydney).
export async function maybeSendPpAlerts() {
  const p = sydParts(Date.now()), day = sydYmd(Date.now()), out = {};
  const wd = new Date(day + 'T00:00:00Z').getUTCDay(); if (wd === 0 || wd === 6) return out; // weekdays only
  if (p.h >= 8 && p.h < 10 && (await getState('pp_morning')) !== day) { await setState('pp_morning', day); out.morning = await morningFeeAlerts(); }
  if (p.h >= 17 && p.h < 19 && (await getState('pp_evening')) !== day) { await setState('pp_evening', day); out.evening = await eveningSummary(); }
  return out;
}
