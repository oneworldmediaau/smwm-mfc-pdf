// Ad spend: Meta (pulled from the Marketing API every hour by /api/sync) and Google (pushed by a Google Ads Script).
import { q, getState, setState } from './db.js';
import { sydYmd } from './speed.js';

export const META_ACCOUNT = process.env.META_AD_ACCOUNT || '164092151051498';
const META_VER = process.env.META_API_VERSION || 'v23.0';
export const DATA_FROM = '2025-11-01'; // same start as the opportunity backfill

let ready = false;
export async function adsSchema() {
  if (ready) return;
  for (const s of [
    `create table if not exists ad_campaigns (platform text, id text, name text, account text, status text, updated_at timestamptz default now(), primary key (platform, id))`,
    `create table if not exists ad_spend (platform text, campaign_id text, day date, spend numeric default 0, impressions bigint default 0, clicks bigint default 0,
      platform_leads numeric default 0, primary key (platform, campaign_id, day))`,
    `create index if not exists ad_spend_day on ad_spend (day)`,
    `create table if not exists campaign_links (platform text, campaign_id text, source text, created_by text, created_at timestamptz default now(),
      primary key (platform, campaign_id, source))`,
  ]) await q(s);
  ready = true;
}

function addDays(ymd, n) { const [y, m, d] = ymd.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10); }

async function upsertSpend(platform, rows, account) {
  if (!rows.length) return 0;
  const camps = new Map(); rows.forEach((r) => camps.set(r.campaign_id, r));
  const c = [...camps.values()];
  await q(`insert into ad_campaigns (platform, id, name, account, status, updated_at)
    select $1, x.id, x.name, $4, x.status, now() from unnest($2::text[], $3::text[], $5::text[]) as x(id, name, status)
    on conflict (platform, id) do update set name=excluded.name, account=coalesce(excluded.account, ad_campaigns.account),
      status=coalesce(excluded.status, ad_campaigns.status), updated_at=now()`,
  [platform, c.map((r) => String(r.campaign_id)), c.map((r) => r.campaign_name || String(r.campaign_id)), account || null, c.map((r) => r.status || null)]);
  for (let i = 0; i < rows.length; i += 500) {
    const b = rows.slice(i, i + 500);
    await q(`insert into ad_spend (platform, campaign_id, day, spend, impressions, clicks, platform_leads)
      select $1, x.c, x.d::date, x.s, x.i, x.k, x.l from unnest($2::text[], $3::text[], $4::numeric[], $5::bigint[], $6::bigint[], $7::numeric[]) as x(c, d, s, i, k, l)
      on conflict (platform, campaign_id, day) do update set spend=excluded.spend, impressions=excluded.impressions, clicks=excluded.clicks, platform_leads=excluded.platform_leads`,
    [platform, b.map((r) => String(r.campaign_id)), b.map((r) => r.day), b.map((r) => +r.spend || 0), b.map((r) => Math.round(+r.impressions || 0)),
      b.map((r) => Math.round(+r.clicks || 0)), b.map((r) => +r.leads || 0)]);
  }
  return rows.length;
}

// ---- Meta
function metaLeads(actions) {
  const a = {}; (actions || []).forEach((x) => { a[x.action_type] = +x.value || 0; });
  if (a.lead != null) return a.lead;
  return (a['offsite_conversion.fb_pixel_lead'] || 0) + (a['onsite_conversion.lead_grouped'] || 0);
}
async function metaGet(url) {
  const r = await fetch(url); const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) throw new Error('Meta: ' + ((j.error && j.error.message) || r.status));
  return j;
}
export async function syncMeta(since, until, onSaved) {
  const token = process.env.META_TOKEN; if (!token) return { skipped: 'META_TOKEN not set' };
  const rows = []; let n = 0;
  // a month per request keeps responses small
  for (let s = since; s <= until; s = addDays(s, 31)) {
    const e = addDays(s, 30) < until ? addDays(s, 30) : until;
    let url = `https://graph.facebook.com/${META_VER}/act_${META_ACCOUNT}/insights?` + new URLSearchParams({
      level: 'campaign', time_increment: '1', time_range: JSON.stringify({ since: s, until: e }), limit: '500',
      fields: 'campaign_id,campaign_name,spend,impressions,clicks,actions', access_token: token,
    });
    while (url) {
      const j = await metaGet(url);
      (j.data || []).forEach((d) => rows.push({ campaign_id: d.campaign_id, campaign_name: d.campaign_name, day: d.date_start, spend: d.spend, impressions: d.impressions, clicks: d.clicks, leads: metaLeads(d.actions) }));
      url = j.paging && j.paging.next; if (++n > 60) break;
    }
  }
  const saved = await upsertSpend('meta', rows, 'act_' + META_ACCOUNT);
  if (onSaved) await onSaved(saved); // record success before the (slower, optional) status refresh
  // campaign statuses (for the "active" filter on the board)
  try {
    let url = `https://graph.facebook.com/${META_VER}/act_${META_ACCOUNT}/campaigns?` + new URLSearchParams({ fields: 'id,effective_status', limit: '500', access_token: token });
    let k = 0;
    const all = [];
    while (url && k++ < 10) { const j = await metaGet(url); all.push(...(j.data || [])); url = j.paging && j.paging.next; }
    if (all.length) await q(`update ad_campaigns c set status = x.s from unnest($1::text[], $2::text[]) as x(id, s) where c.platform = 'meta' and c.id = x.id`, [all.map((c) => c.id), all.map((c) => c.effective_status)]);
  } catch (e) { /* statuses are nice-to-have */ }
  return { saved, since, until };
}
// Hourly from /api/sync: first run loads everything since DATA_FROM, then re-reads the last 3 days (Meta revises recent numbers).
export async function maybeSyncMeta(force) {
  if (!process.env.META_TOKEN) return { skipped: 'META_TOKEN not set' };
  await adsSchema();
  const st = (await getState('meta_sync')) || {};
  if (!force && !st.backfilled) return { skipped: 'first load runs from the board page (Refresh) to stay inside the sync time limit' };
  if (!force && st.at && Date.now() - st.at < 55 * 60000) return { skipped: 'recent' };
  const today = sydYmd(Date.now());
  const since = st.backfilled ? addDays(today, -3) : DATA_FROM;
  const r = await syncMeta(since, today, (saved) => setState('meta_sync', { at: Date.now(), backfilled: true, last: { saved, since, until: today } }));
  await setState('meta_sync', { at: Date.now(), backfilled: true, last: r });
  return r;
}

// ---- Google (Ads Script pushes rows here)
export async function ingestGoogle(body) {
  await adsSchema();
  const acct = body.account || {};
  const rows = (body.rows || []).filter((r) => r.campaign_id && /^\d{4}-\d{2}-\d{2}$/.test(r.day || '')).map((r) => ({
    campaign_id: String(r.campaign_id), campaign_name: (acct.name ? acct.name + ' · ' : '') + (r.campaign_name || r.campaign_id), status: r.status || null,
    day: r.day, spend: +r.spend || 0, impressions: +r.impressions || 0, clicks: +r.clicks || 0, leads: +r.conversions || 0,
  }));
  const n = await upsertSpend('google', rows, acct.id ? String(acct.id) : null);
  await setState('google_sync', { at: Date.now(), account: acct, rows: n });
  return { saved: n };
}
export async function googleSince(account) {
  await adsSchema();
  const r = await q("select count(*)::int n from ad_spend s join ad_campaigns c on c.platform='google' and c.id=s.campaign_id where s.platform='google' and ($1::text is null or c.account=$1)", [account || null]);
  return r[0].n ? addDays(sydYmd(Date.now()), -30) : DATA_FROM;
}
