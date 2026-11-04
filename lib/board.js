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
    steps: { cm: 2, fp: 3, client: 5 },
    labels: { cm: '03. Booked CM Meeting', fp: '04. Booked FP/WA Meeting (incl. 04A Property)', client: '05. FP/WA Client' },
  },
  {
    key: 'fss', id: 'jepwJPorwBPDjGwWXGiK', name: 'SMWM Free Strategy Session',
    stages: ['022c5e66-737e-4aba-aa5e-0c5111c4a978', 'b1ef79fc-3fa5-4b56-8e70-58c63425e893', '176c1a5e-33a3-47b9-9939-1c9c78597fce',
      '0f9195cd-1a8e-4a55-8f44-cc344f788845', '87358bd3-990b-4198-af21-a7c7bc0eba3b', '17db448b-00ed-4310-b8c4-0a3628320e8a',
      '76573f7c-fc36-40a4-9a1a-22e9b2a159fc', 'f74c6b3d-4aec-4737-b3fb-ad6a69797950'],
    steps: { cm: 3, cmHeld: 4, fp: 5, fpHeld: 6, client: 7 },
    labels: { cm: 'Strategy Session Booked', cmHeld: 'Strategy Session Held', fp: 'FP Discovery Booked', fpHeld: 'FP Discovery Held', client: 'SOA Paid – Client' },
  },
];
const NO_SOURCE = '(no source)';

function addDays(ymd, n) { const [y, m, d] = ymd.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10); }

// Opportunities created in [from, to] grouped by pipeline, source and furthest stage reached.
async function oppGroups(from, to) {
  const vals = []; const params = [];
  PIPELINES.forEach((p) => p.stages.forEach((s, i) => { params.push(s, i); vals.push(`($${params.length - 1}::text, $${params.length}::int)`); }));
  params.push(PIPELINES.map((p) => p.id), new Date(sydMidnight(from)).toISOString(), new Date(sydMidnight(addDays(to, 1))).toISOString());
  const n = params.length;
  return q(`with st(stage_id, idx) as (values ${vals.join(',')}),
    o as (select o.id, o.pipeline_id, coalesce(nullif(trim(o.source), ''), '${NO_SOURCE}') source, o.status, coalesce(o.value, 0) value,
      greatest(coalesce((select idx from st where st.stage_id = o.stage_id), 0),
               coalesce((select max(st.idx) from stage_events e join st on st.stage_id = e.to_stage where e.opp_id = o.id and e.pipeline_id = o.pipeline_id), 0)) lvl
      from opportunities o where o.pipeline_id = any($${n - 2}) and o.created_at >= $${n - 1} and o.created_at < $${n})
    select pipeline_id, source, lvl, status, count(*)::int n, sum(value)::float value from o group by 1, 2, 3, 4`, params);
}

function funnelFrom(groups) {
  // -> { [pipelineKey]: { [source]: {leads, cm, cmHeld, fp, fpHeld, client, value, lost} } }
  const out = {};
  for (const p of PIPELINES) out[p.key] = {};
  for (const g of groups) {
    const p = PIPELINES.find((x) => x.id === g.pipeline_id); if (!p) continue;
    const b = out[p.key][g.source] || (out[p.key][g.source] = { leads: 0, cm: 0, cmHeld: 0, fp: 0, fpHeld: 0, client: 0, value: 0, lost: 0 });
    b.leads += g.n;
    for (const k of Object.keys(p.steps)) if (g.lvl >= p.steps[k]) b[k] += g.n;
    if (g.lvl >= p.steps.client) b.value += g.value || 0;
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

async function period(from, to, linkRows) {
  const [groups, spend] = await Promise.all([oppGroups(from, to), spendRows(from, to)]);
  const funnel = funnelFrom(groups);
  const alloc = allocate(spend, linkRows, funnel);
  return { funnel, spend, alloc };
}

export async function boardData(from, to, compare) {
  await adsSchema();
  const days = Math.round((sydMidnight(addDays(to, 1)) - sydMidnight(from)) / 864e5);
  const pFrom = addDays(from, -days), pTo = addDays(from, -1);
  const linkRows = await links();
  const [cur, prev] = await Promise.all([period(from, to, linkRows), compare ? period(pFrom, pTo, linkRows) : null]);
  // every source ever seen in these pipelines (for the link picker), with lead counts over the last 180 days
  const sources = await q(`select coalesce(nullif(trim(source), ''), '${NO_SOURCE}') source, count(*)::int n from opportunities
    where pipeline_id = any($1) and created_at > now() - interval '180 days' group by 1 order by 2 desc`, [PIPELINES.map((p) => p.id)]);
  const campaigns = await q(`select c.platform, c.id, c.name, c.status, c.account, (select max(day) from ad_spend s where s.platform = c.platform and s.campaign_id = c.id and s.spend > 0) last_spend
    from ad_campaigns c order by last_spend desc nulls last, c.name`);
  const sync = await q("select key, value from sync_state where key in ('meta_sync','google_sync','last_sync')");
  return {
    from, to, prevFrom: pFrom, prevTo: pTo, days,
    pipelines: PIPELINES.map((p) => ({ key: p.key, name: p.name, labels: p.labels, steps: Object.keys(p.steps) })),
    cur, prev, links: linkRows, sources, campaigns,
    sync: Object.fromEntries(sync.map((r) => [r.key, r.value])),
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
