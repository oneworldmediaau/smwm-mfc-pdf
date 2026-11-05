// Sync GHL → Postgres, and read helpers for the dashboards.
import { q, ensureSchema, getState, setState } from './db.js';
import { ghl, LOCATION_ID, firstOutboundCall, sydYmd, businessMs } from './speed.js';

export const PIPES = {
  MAIN: 'renAM7VKvSlgni3Ag0D4',
  FSS: 'jepwJPorwBPDjGwWXGiK',
};
// Later MAIN stages are small enough to re-read every run (Contacting / New Lead are huge and come via "recent").
const MAIN_LATE_STAGES = ['016eb050-1f60-42d5-93b0-ffedb523c9f2', 'b7a97f76-ab2f-49bb-82fb-78d8d2a8e1fe', '6c9f3851-d35d-4dc6-9965-f147d28e8256', 'a5dc2abc-e842-4194-85b0-5047feccdeea'];
const F = {
  csr: 'sSTk9wqOdy13laKJ6JWK', cs_outcome: 'cjUKFO9YUNYmIZexnK2b', cm: 'c3HKTdLNeh23CLdK2UEj', cm_outcome: 'EXf7rLWWl1LBv2qK4t4a',
  fp: '3zsTzcoBu5RBajDRxxwP', fp_outcome: 'dXfRikowgUlcQ1dGMUhN', campaign: 'u1hQYqRcmxtuVIH35B4H', ad: 'ANckCclAr98RCW4P52Zi',
};
const COLS = ['id', 'contact_id', 'pipeline_id', 'stage_id', 'status', 'name', 'phone', 'email', 'source', 'channel', 'campaign', 'ad',
  'csr', 'cs_outcome', 'cm', 'cm_outcome', 'fp', 'fp_outcome', 'value', 'created_at', 'updated_at', 'last_stage_change_at', 'last_status_change_at'];
const TYPES = { value: 'numeric', created_at: 'timestamptz', updated_at: 'timestamptz', last_stage_change_at: 'timestamptz', last_status_change_at: 'timestamptz' };

function cf(o, id) { const f = (o.customFields || []).find((c) => c.id === id); return f ? String(f.fieldValueString || f.fieldValue || f.value || '') || null : null; }
function toRow(o) {
  const a = (o.attributions || []).find((x) => x.isFirst) || (o.attributions || [])[0] || {};
  const r = {
    id: o.id, contact_id: o.contactId, pipeline_id: o.pipelineId, stage_id: o.pipelineStageId, status: o.status,
    name: (o.contact && o.contact.name) || o.name, phone: (o.contact && o.contact.phone) || null, email: (o.contact && o.contact.email) || null,
    source: o.source || null, channel: a.utmSource || a.utmSessionSource || null,
    campaign: cf(o, F.campaign) || a.utmCampaign || null, ad: cf(o, F.ad) || a.utmTerm || null,
    value: +o.monetaryValue || 0, created_at: o.createdAt, updated_at: o.updatedAt || null,
    last_stage_change_at: o.lastStageChangeAt || null, last_status_change_at: o.lastStatusChangeAt || null,
  };
  ['csr', 'cs_outcome', 'cm', 'cm_outcome', 'fp', 'fp_outcome'].forEach((k) => { r[k] = cf(o, F[k]); });
  return r;
}

export async function upsertOpps(ops) {
  if (!ops.length) return 0;
  const seen = new Map(); ops.forEach((o) => seen.set(o.id, toRow(o)));
  const rows = [...seen.values()];
  const def = COLS.map((c) => c + ' ' + (TYPES[c] || 'text')).join(', ');
  const upd = COLS.filter((c) => c !== 'id').map((c) => c + '=excluded.' + c).join(', ');
  for (let i = 0; i < rows.length; i += 200) {
    const chunk = rows.slice(i, i + 200);
    await q(`with incoming as (select * from jsonb_to_recordset($1::jsonb) as x(${def})),
      old as (select o.id, o.stage_id, o.status from opportunities o join incoming i using (id)),
      ev as (insert into stage_events (opp_id, pipeline_id, from_stage, to_stage, from_status, to_status, at)
        select i.id, i.pipeline_id, old.stage_id, i.stage_id, old.status, i.status,
          coalesce(case when old.id is null or old.stage_id is distinct from i.stage_id then i.last_stage_change_at else i.last_status_change_at end, now())
        from incoming i left join old using (id)
        where old.id is null or old.stage_id is distinct from i.stage_id or old.status is distinct from i.status)
      insert into opportunities (${COLS.join(', ')}, synced_at) select ${COLS.join(', ')}, now() from incoming
      on conflict (id) do update set ${upd}, synced_at = now()`, [JSON.stringify(chunk)]);
  }
  return rows.length;
}

function mdy(ms) { const s = sydYmd(ms); return s.slice(5, 7) + '-' + s.slice(8, 10) + '-' + s.slice(0, 4); }
export async function searchAll(params, maxPages = 40) {
  const out = []; let sa = null, sid = null;
  for (let i = 0; i < maxPages; i++) {
    const qs = new URLSearchParams(Object.assign({ location_id: LOCATION_ID, limit: '100', status: 'all' }, params));
    if (sa) { qs.set('startAfter', sa); qs.set('startAfterId', sid); }
    const d = await ghl('GET', '/opportunities/search?' + qs);
    const ops = d.opportunities || []; out.push(...ops);
    if (ops.length < 100 || !d.meta || !d.meta.startAfterId) break;
    sa = d.meta.startAfter; sid = d.meta.startAfterId;
  }
  return out;
}
export async function oppsCreatedBetween(startMs, endMs) {
  const ops = await searchAll({ date: mdy(startMs - 864e5), endDate: mdy(endMs + 864e5) }, 60);
  return ops.filter((o) => { const t = Date.parse(o.createdAt); return t >= startMs && t < endMs; });
}

// ---- first calls
export async function checkCalls(budgetMs, concurrency = 3) {
  const todo = await q(`select o.id, o.contact_id, o.created_at from opportunities o left join first_calls f on f.opp_id = o.id
    where o.created_at > now() - interval '400 days' and (f.opp_id is null or
      (f.call_at is null and o.created_at > now() - interval '14 days' and f.checked_at < now() - interval '14 minutes'))
    -- recent leads first (new or due a re-check), then the old backfill backlog
    order by (o.created_at > now() - interval '14 days') desc, (f.opp_id is null) desc, o.created_at desc limit 400`);
  const stopAt = Date.now() + budgetMs; let i = 0, done = 0, limited = false;
  async function worker() {
    while (i < todo.length && Date.now() < stopAt && !limited) {
      const r = todo[i++];
      try {
        const c = await firstOutboundCall(r.contact_id, new Date(r.created_at).getTime());
        await q(`insert into first_calls (opp_id, call_at, caller_id, duration, checked_at) values ($1,$2,$3,$4,now())
          on conflict (opp_id) do update set call_at=excluded.call_at, caller_id=excluded.caller_id, duration=excluded.duration, checked_at=now()`,
        [r.id, c ? new Date(c.t).toISOString() : null, c ? c.u : null, c ? c.d : 0]);
        done++;
      } catch (e) { if (e.rateLimited) limited = true; }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  const left = await q(`select count(*)::int n from opportunities o left join first_calls f on f.opp_id = o.id where f.opp_id is null and o.created_at > now() - interval '400 days'`);
  return { checked: done, unchecked: left[0].n, limited };
}

// ---- daily housekeeping: users + stage snapshot
export async function refreshUsers() {
  const d = await ghl('GET', '/users/?locationId=' + LOCATION_ID);
  const rows = (d.users || []).map((u) => ({ id: u.id, name: ((u.firstName || '') + ' ' + (u.lastName || '')).trim() }));
  if (rows.length) await q(`insert into users (id, name) select id, name from jsonb_to_recordset($1::jsonb) as x(id text, name text)
    on conflict (id) do update set name = excluded.name`, [JSON.stringify(rows)]);
  return rows.length;
}
export async function snapshotStages(pipelines) {
  const day = sydYmd(Date.now()); let n = 0;
  for (const p of pipelines) {
    for (const st of p.stages) {
      const counts = {};
      for (const status of ['all', 'open', 'won', 'lost', 'abandoned']) {
        const d = await ghl('GET', '/opportunities/search?' + new URLSearchParams({ location_id: LOCATION_ID, pipeline_id: p.id, pipeline_stage_id: st.id, status, limit: '1' }));
        counts[status] = (d.meta && d.meta.total) || 0;
      }
      await q(`insert into stage_snapshots (day, pipeline_id, stage_id, total, open, won, lost, abandoned) values ($1,$2,$3,$4,$5,$6,$7,$8)
        on conflict (day, pipeline_id, stage_id) do update set total=excluded.total, open=excluded.open, won=excluded.won, lost=excluded.lost, abandoned=excluded.abandoned`,
      [day, p.id, st.id, counts.all, counts.open, counts.won, counts.lost, counts.abandoned]);
      n++;
    }
  }
  return n;
}
export async function pipelineDefs() {
  const d = await ghl('GET', '/opportunities/pipelines?locationId=' + LOCATION_ID);
  return (d.pipelines || []).filter((p) => Object.values(PIPES).includes(p.id))
    .map((p) => ({ id: p.id, name: p.name, stages: (p.stages || []).slice().sort((a, b) => (a.position || 0) - (b.position || 0)).map((s) => ({ id: s.id, name: s.name })) }));
}

// ---- one sync run (every 15 minutes)
export async function runSync({ budgetMs = 50000 } = {}) {
  const t0 = Date.now(); await ensureSchema();
  const log = {};
  const now = Date.now();
  // 1. new and recently changed opportunities
  const last = (await getState('wide_scan')) || 0;
  const wide = now - last > 60 * 60000; // every hour, look back 21 days to catch status changes on slightly older leads
  const recent = await oppsCreatedBetween(now - (wide ? 21 : 3) * 864e5, now + 60000);
  log.recent = await upsertOpps(recent);
  if (wide) await setState('wide_scan', now);
  // 2. later pipeline stages (catches moves on older opportunities)
  let late = [];
  for (const sid of MAIN_LATE_STAGES) late = late.concat(await searchAll({ pipeline_id: PIPES.MAIN, pipeline_stage_id: sid }, 15));
  late = late.concat(await searchAll({ pipeline_id: PIPES.FSS }, 10));
  log.late = await upsertOpps(late);
  // 3. once a day: users + stage snapshot
  const today = sydYmd(now);
  if ((await getState('daily')) !== today) {
    log.users = await refreshUsers();
    const defs = await pipelineDefs(); await setState('pipelines', defs);
    log.snap = await snapshotStages(defs);
    await setState('daily', today);
  }
  // 4. call logs with whatever time is left
  const left = budgetMs - (Date.now() - t0);
  if (left > 5000) log.calls = await checkCalls(left - 3000);
  await setState('last_sync', { at: Date.now(), ms: Date.now() - t0, log });
  return log;
}

// ---- readers
export async function speedRows(startMs, endMs) {
  const rows = await q(`select o.*, f.opp_id is not null as checked, f.call_at, f.caller_id, f.duration, u.name as caller
    from opportunities o left join first_calls f on f.opp_id = o.id left join users u on u.id = f.caller_id
    where o.created_at >= $1 and o.created_at < $2`, [new Date(startMs).toISOString(), new Date(endMs).toISOString()]);
  const now = Date.now();
  return rows
    .filter((r) => !(r.checked && !r.call_at && r.cs_outcome === 'DNQ'))
    .map((r) => {
      const created = new Date(r.created_at).getTime(), call = r.call_at ? new Date(r.call_at).getTime() : null;
      return {
        id: r.id, contactId: r.contact_id, name: r.name, phone: r.phone || '', rep: r.csr || 'Unassigned', outcome: r.cs_outcome || '',
        source: r.source || '—', channel: r.channel || '', status: r.status, created, call,
        caller: call ? (r.caller || 'Team member') : '', dur: r.duration || 0, checked: !!r.checked,
        biz: call ? businessMs(created, call) : null, wait: r.checked && !call ? businessMs(created, now) : null,
      };
    });
}
export async function lastSync() { return getState('last_sync'); }
