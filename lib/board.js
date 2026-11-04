// Board report: ad spend (Meta + Google) cross-referenced with GHL opportunities by source, through the funnel
// New lead → Client Manager meeting → Financial Planner meeting → Client, for the MAIN and SMWM Free Strategy Session pipelines.
import { q } from './db.js';
import { sydMidnight } from './speed.js';
import { adsSchema } from './ads.js';

// Pipeline stages in order, and which position counts as each funnel step ("reached" = got to that stage or further).
export const PIPELINES = [
  {
    key: 'main', id: 'renAM7VKvSlgni3Ag0D4', name: 'MAIN Pipeline',
    stages: ['485f1789-b3bc-4ca9-993a-193e11d29baf', '4b785f12-b799-4747-9e55-321345718574', '016eb050-1f60-42d5-93b0-ffedb523c9f2',
      'b7a97f76-ab2f-49bb-82fb-78d8d2a8e1fe', '6c9f3851-d35d-4dc6-9965-f147d28e8256', 'a5dc2abc-e842-4194-85b0-5047feccdeea'],
    stageNames: ['0.1 New Lead - To Call', '02. Contacting', '03. Booked CM Meeting', '04. Booked FP/WA Meeting', '04A. PROPERTY', '05. FP/WA Client'],
    steps: { cm: 2, fp: 3, client: 5 },
    labels: { cm: '03. Booked CM Meeting', fp: '04. Booked FP/WA Meeting (incl. 04A Property)', client: 'FP outcome Proceeding or Property Plan' },
  },
  {
    key: 'fss', id: 'jepwJPorwBPDjGwWXGiK', name: 'SMWM Free Strategy Session',
    stages: ['022c5e66-737e-4aba-aa5e-0c5111c4a978', 'b1ef79fc-3fa5-4b56-8e70-58c63425e893', '176c1a5e-33a3-47b9-9939-1c9c78597fce',
      '0f9195cd-1a8e-4a55-8f44-cc344f788845', '87358bd3-990b-4198-af21-a7c7bc0eba3b', '17db448b-00ed-4310-b8c4-0a3628320e8a',
      '76573f7c-fc36-40a4-9a1a-22e9b2a159fc', 'f74c6b3d-4aec-4737-b3fb-ad6a69797950'],
    stageNames: ['Application – Qualified', 'Application – Priority Review', 'CS Call Booked', 'Strategy Session Booked', 'Strategy Session Held',
      'FP Discovery Booked – $330 Paid', 'FP Discovery Held', 'SOA Paid – Client'],
    steps: { cm: 3, cmHeld: 4, fp: 5, fpHeld: 6, client: 7 },
    labels: { cm: 'Strategy Session Booked', cmHeld: 'Strategy Session Held', fp: 'FP Discovery Booked', fpHeld: 'FP Discovery Held', client: 'SOA Paid, or FP outcome Proceeding / Property Plan' },
  },
];
const NO_SOURCE = '(no source)';
// A client = Financial Planner outcome of Proceeding or Property Plan (or, in the Free Strategy Session pipeline, reaching SOA Paid).
export const CLIENT_OUTCOMES = ['proceeding', 'property plan'];
function isClient(p, r) {
  if (CLIENT_OUTCOMES.includes(String(r.fp_outcome || '').trim().toLowerCase())) return true;
  return p.key === 'fss' && r.stage_id === p.stages[p.steps.client];
}
const CLIENT_SQL = `(lower(trim(coalesce(o.fp_outcome, ''))) in ('proceeding', 'property plan') or o.stage_id = 'f74c6b3d-4aec-4737-b3fb-ad6a69797950')`;

function addDays(ymd, n) { const [y, m, d] = ymd.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10); }

// Opportunities created in [from, to] grouped by pipeline, source and furthest stage reached.
async function oppGroups(from, to) {
  const vals = []; const params = [];
  PIPELINES.forEach((p) => p.stages.forEach((s, i) => { params.push(s, i); vals.push(`($${params.length - 1}::text, $${params.length}::int)`); }));
  params.push(PIPELINES.map((p) => p.id), new Date(sydMidnight(from)).toISOString(), new Date(sydMidnight(addDays(to, 1))).toISOString());
  const n = params.length;
  return q(`with st(stage_id, idx) as (values ${vals.join(',')}),
    o as (select o.id, o.pipeline_id, coalesce(nullif(trim(o.source), ''), '${NO_SOURCE}') source, o.status, coalesce(o.value, 0) value, ${CLIENT_SQL} is_client,
      greatest(coalesce((select idx from st where st.stage_id = o.stage_id), 0),
               coalesce((select max(st.idx) from stage_events e join st on st.stage_id = e.to_stage where e.opp_id = o.id and e.pipeline_id = o.pipeline_id), 0)) lvl
      from opportunities o where o.pipeline_id = any($${n - 2}) and o.created_at >= $${n - 1} and o.created_at < $${n})
    select pipeline_id, source, lvl, status, is_client, count(*)::int n, sum(value)::float value from o group by 1, 2, 3, 4, 5`, params);
}

function funnelFrom(groups) {
  // -> { [pipelineKey]: { [source]: {leads, cm, cmHeld, fp, fpHeld, client, value, lost} } }
  const out = {};
  for (const p of PIPELINES) out[p.key] = {};
  for (const g of groups) {
    const p = PIPELINES.find((x) => x.id === g.pipeline_id); if (!p) continue;
    const b = out[p.key][g.source] || (out[p.key][g.source] = { leads: 0, cm: 0, cmHeld: 0, fp: 0, fpHeld: 0, client: 0, value: 0, lost: 0 });
    b.leads += g.n;
    for (const k of Object.keys(p.steps)) if (k !== 'client' && g.lvl >= p.steps[k]) b[k] += g.n;
    if (g.is_client) { b.client += g.n; b.value += g.value || 0; }
    if (g.status === 'lost') b.lost += g.n;
  }
  return out;
}

async function spendRows(from, to) {
  return q(`select s.platform, s.campaign_id, max(c.name) name, max(c.status) status, sum(s.spend)::float spend, sum(s.impressions)::float impressions,
      sum(s.clicks)::float clicks, sum(s.platform_leads)::float platform_leads
    from ad_spend s left join ad_campaigns c on c.platform = s.platform and c.id = s.campaign_id
    where s.day between $1::date and $2::date group by 1, 2`, [from, to]);
}
export async function links() { return q('select platform, campaign_id, source from campaign_links order by source'); }

// Spend for a campaign linked to several sources is shared out by how many leads each (source, pipeline) brought in that period.
function allocate(spend, linkRows, funnel) {
  const bySrc = {}; // `${pipe}|${source}` -> {spend, meta, google}
  const campLeads = {}; let linked = 0, unlinked = 0;
  const linkMap = {}; linkRows.forEach((l) => { (linkMap[l.platform + '|' + l.campaign_id] = linkMap[l.platform + '|' + l.campaign_id] || []).push(l.source); });
  for (const c of spend) {
    const ck = c.platform + '|' + c.campaign_id, srcs = linkMap[ck] || [];
    if (!srcs.length) { unlinked += c.spend; campLeads[ck] = null; continue; }
    linked += c.spend;
    const units = []; srcs.forEach((s) => PIPELINES.forEach((p) => { const f = funnel[p.key][s]; units.push({ k: p.key + '|' + s, w: f ? f.leads : 0 }); }));
    const tot = units.reduce((a, u) => a + u.w, 0);
    campLeads[ck] = tot;
    units.forEach((u) => {
      const share = tot ? u.w / tot : (u.k.startsWith('main|') ? 1 / srcs.length : 0); // no leads yet: park it on MAIN so the cost still shows
      const b = bySrc[u.k] || (bySrc[u.k] = { spend: 0, meta: 0, google: 0 });
      b.spend += c.spend * share; b[c.platform] = (b[c.platform] || 0) + c.spend * share;
    });
  }
  return { bySrc, campLeads, linked, unlinked };
}

// "When it happened" mode: each step is counted in the period the opportunity reached it, whenever the lead came in.
// The time a step was reached comes from recorded stage moves (stage_events, since the sync started) or, for an
// opportunity still sitting in that step, its last stage change. Leads = created in the period.
async function activityFunnel(from, to, collect) {
  const s = new Date(sydMidnight(from)).toISOString(), e = new Date(sydMidnight(addDays(to, 1))).toISOString();
  const ids = PIPELINES.map((p) => p.id);
  const ops = await q(`select o.id, o.pipeline_id, coalesce(nullif(trim(o.source), ''), '${NO_SOURCE}') source, o.stage_id, o.status, coalesce(o.value, 0)::float value,
      o.created_at, o.last_stage_change_at, o.fp_outcome
    from opportunities o where o.pipeline_id = any($1) and (
      (o.created_at >= $2 and o.created_at < $3) or (o.last_stage_change_at >= $2 and o.last_stage_change_at < $3)
      or exists (select 1 from stage_events x where x.opp_id = o.id and x.at >= $2 and x.at < $3))`, [ids, s, e]);
  const evs = ops.length ? await q(`select opp_id, from_stage, to_stage, at from stage_events where opp_id = any($1) order by at`, [ops.map((o) => o.id)]) : [];
  const byOpp = {}; evs.forEach((x) => { (byOpp[x.opp_id] = byOpp[x.opp_id] || []).push(x); });
  const t0 = Date.parse(s), t1 = Date.parse(e), inR = (t) => t != null && t >= t0 && t < t1;
  const out = {}; PIPELINES.forEach((p) => { out[p.key] = {}; });
  for (const o of ops) {
    const p = PIPELINES.find((x) => x.id === o.pipeline_id); if (!p) continue;
    const idx = (sid) => { const i = p.stages.indexOf(sid); return i < 0 ? -1 : i; };
    const b = out[p.key][o.source] || (out[p.key][o.source] = { leads: 0, cm: 0, cmHeld: 0, fp: 0, fpHeld: 0, client: 0, value: 0, lost: 0 });
    const want = collect && collect.pipes.includes(p.key) && (!collect.source || collect.source === o.source);
    if (inR(Date.parse(o.created_at))) { b.leads++; if (want && collect.step === 'leads') collect.out.push({ id: o.id, at: o.created_at }); }
    const keys = Object.keys(p.steps).sort((a, c) => p.steps[a] - p.steps[c]);
    const cur = idx(o.stage_id);
    for (const k of keys) {
      const lv = p.steps[k];
      if (k === 'client' && !isClient(p, o)) continue;
      // first recorded move that crossed into this step
      let t = null;
      for (const x of byOpp[o.id] || []) { if (idx(x.to_stage) >= lv && idx(x.from_stage) < lv) { t = Date.parse(x.at); break; } }
      if (t == null) {
        const nextLv = Math.min(...keys.map((k2) => p.steps[k2]).filter((v) => v > lv), Infinity);
        if (cur >= lv && cur < nextLv && o.last_stage_change_at) t = Date.parse(o.last_stage_change_at);
        // a client by FP outcome who isn't in the client stage: date them by their last stage move
        if (t == null && k === 'client' && o.last_stage_change_at) t = Date.parse(o.last_stage_change_at);
      }
      if (inR(t)) { b[k]++; if (k === 'client') b.value += o.value || 0; if (want && collect.step === k) collect.out.push({ id: o.id, at: new Date(t).toISOString() }); }
    }
  }
  return out;
}

async function period(from, to, linkRows, mode) {
  const [funnel, spend] = await Promise.all([mode === 'cohort' ? oppGroups(from, to).then(funnelFrom) : activityFunnel(from, to), spendRows(from, to)]);
  const alloc = allocate(spend, linkRows, funnel);
  return { funnel, spend, alloc };
}

export async function boardData(from, to, compare, mode) {
  mode = mode === 'cohort' ? 'cohort' : 'activity';
  await adsSchema();
  const days = Math.round((sydMidnight(addDays(to, 1)) - sydMidnight(from)) / 864e5);
  const pFrom = addDays(from, -days), pTo = addDays(from, -1);
  const linkRows = await links();
  const [cur, prev] = await Promise.all([period(from, to, linkRows, mode), compare ? period(pFrom, pTo, linkRows, mode) : null]);
  // every source ever seen in these pipelines (for the link picker), with lead counts over the last 180 days
  const sources = await q(`select coalesce(nullif(trim(source), ''), '${NO_SOURCE}') source, count(*)::int n from opportunities
    where pipeline_id = any($1) and created_at > now() - interval '180 days' group by 1 order by 2 desc`, [PIPELINES.map((p) => p.id)]);
  const campaigns = await q(`select c.platform, c.id, c.name, c.status, c.account, (select max(day) from ad_spend s where s.platform = c.platform and s.campaign_id = c.id and s.spend > 0) last_spend
    from ad_campaigns c order by last_spend desc nulls last, c.name`);
  const sync = await q("select key, value from sync_state where key in ('meta_sync','google_sync','last_sync')");
  return {
    from, to, prevFrom: pFrom, prevTo: pTo, days, mode,
    pipelines: PIPELINES.map((p) => ({ key: p.key, name: p.name, labels: p.labels, steps: Object.keys(p.steps) })),
    cur, prev, links: linkRows, sources, campaigns,
    sync: Object.fromEntries(sync.map((r) => [r.key, r.value])),
  };
}

// The people behind a number: opportunities for one funnel step (leads, cm, cmHeld, fp, fpHeld, client) in the period.
export async function people(from, to, mode, step, pipes, source) {
  pipes = (pipes || []).filter((k) => PIPELINES.some((p) => p.key === k)); if (!pipes.length) pipes = PIPELINES.map((p) => p.key);
  if (!['leads', 'cm', 'cmHeld', 'fp', 'fpHeld', 'client'].includes(step)) throw new Error('Unknown step');
  let hits = [];
  if (mode === 'cohort') {
    const s = new Date(sydMidnight(from)).toISOString(), e = new Date(sydMidnight(addDays(to, 1))).toISOString();
    const rows = await q(`select o.id, o.pipeline_id, o.stage_id, o.created_at, coalesce(nullif(trim(o.source), ''), '${NO_SOURCE}') source,
        o.fp_outcome, (select array_agg(to_stage) from stage_events e where e.opp_id = o.id) seen
      from opportunities o where o.pipeline_id = any($1) and o.created_at >= $2 and o.created_at < $3`, [PIPELINES.filter((p) => pipes.includes(p.key)).map((p) => p.id), s, e]);
    for (const r of rows) {
      if (source && r.source !== source) continue;
      const p = PIPELINES.find((x) => x.id === r.pipeline_id);
      const lvl = Math.max(p.stages.indexOf(r.stage_id), ...((r.seen || []).map((x) => p.stages.indexOf(x))), 0);
      const ok = step === 'leads' || (step === 'client' ? isClient(p, r) : (p.steps[step] != null && lvl >= p.steps[step]));
      if (ok) hits.push({ id: r.id, at: r.created_at });
    }
  } else {
    const collect = { step, pipes, source, out: [] }; await activityFunnel(from, to, collect); hits = collect.out;
  }
  if (!hits.length) return { rows: [] };
  const at = Object.fromEntries(hits.map((h) => [h.id, h.at]));
  const rows = await q(`select o.id, o.contact_id, o.name, o.pipeline_id, o.stage_id, o.status, coalesce(o.value, 0)::float value, o.created_at, o.last_stage_change_at,
      coalesce(nullif(trim(o.source), ''), '${NO_SOURCE}') source, o.campaign, o.csr, o.cs_outcome, o.cm, o.cm_outcome, o.fp, o.fp_outcome
    from opportunities o where o.id = any($1)`, [hits.map((h) => h.id)]);
  return {
    rows: rows.map((r) => {
      const p = PIPELINES.find((x) => x.id === r.pipeline_id);
      return { ...r, pipeline: p.name, pipeKey: p.key, stage: p.stageNames[p.stages.indexOf(r.stage_id)] || 'Other stage', reached_at: at[r.id] };
    }).sort((a, b) => String(b.reached_at).localeCompare(String(a.reached_at))),
  };
}

export async function setLinks(platform, campaignId, sources, by) {
  await adsSchema();
  if (!['meta', 'google'].includes(platform) || !campaignId) throw new Error('Bad campaign');
  await q('delete from campaign_links where platform=$1 and campaign_id=$2', [platform, String(campaignId)]);
  const list = [...new Set((sources || []).map((s) => String(s).trim()).filter(Boolean))].slice(0, 50);
  for (const s of list) await q('insert into campaign_links (platform, campaign_id, source, created_by) values ($1,$2,$3,$4) on conflict do nothing', [platform, String(campaignId), s, by || null]);
  return { saved: list.length };
}

// Suggest sources for a campaign from leads whose Campaign field / UTM campaign matches the ad campaign's name or id.
export async function suggestions() {
  await adsSchema();
  return q(`select c.platform, c.id, coalesce(nullif(trim(o.source), ''), '${NO_SOURCE}') source, count(*)::int n
    from ad_campaigns c join opportunities o on (lower(o.campaign) = lower(c.name) or o.campaign = c.id)
    where o.pipeline_id = any($1) and o.created_at > now() - interval '365 days'
    group by 1, 2, 3 having count(*) >= 2 order by 4 desc`, [PIPELINES.map((p) => p.id)]);
}
