// Database layer: Neon Postgres in production (DATABASE_URL), plain Postgres for local tests (LOCAL_PG).
import { neon } from '@neondatabase/serverless';

let _q = null;
export async function q(text, params = []) {
  if (!_q) {
    if (process.env.LOCAL_PG) {
      const pg = await import('pg'); const pool = new pg.default.Pool({ connectionString: process.env.LOCAL_PG });
      _q = async (t, p) => (await pool.query(t, p)).rows;
    } else {
      const url = process.env.DATABASE_URL || process.env.POSTGRES_URL;
      if (!url) throw new Error('DATABASE_URL is not set');
      const sql = neon(url);
      _q = (t, p) => sql.query(t, p);
    }
  }
  return _q(text, params);
}

let ready = false;
export async function ensureSchema() {
  if (ready) return;
  const stmts = [
    `create table if not exists opportunities (
      id text primary key, contact_id text, pipeline_id text, stage_id text, status text,
      name text, phone text, email text, source text, channel text, campaign text, ad text,
      csr text, cs_outcome text, cm text, cm_outcome text, fp text, fp_outcome text,
      value numeric default 0, created_at timestamptz, updated_at timestamptz,
      last_stage_change_at timestamptz, last_status_change_at timestamptz, synced_at timestamptz default now())`,
    `create index if not exists opp_created on opportunities (created_at)`,
    `create index if not exists opp_pipe_stage on opportunities (pipeline_id, stage_id)`,
    `create index if not exists opp_stage_change on opportunities (last_stage_change_at)`,
    `create table if not exists first_calls (
      opp_id text primary key, call_at timestamptz, caller_id text, duration int default 0, checked_at timestamptz default now())`,
    `create table if not exists stage_events (
      id bigserial primary key, opp_id text, pipeline_id text, from_stage text, to_stage text,
      from_status text, to_status text, at timestamptz default now())`,
    `create index if not exists stage_events_at on stage_events (at)`,
    `create table if not exists stage_snapshots (
      day date, pipeline_id text, stage_id text, total int, open int, won int, lost int, abandoned int,
      primary key (day, pipeline_id, stage_id))`,
    `create table if not exists users (id text primary key, name text)`,
    `create table if not exists sync_state (key text primary key, value jsonb, updated_at timestamptz default now())`,
  ];
  for (const s of stmts) await q(s);
  ready = true;
}

export async function getState(key) { const r = await q('select value from sync_state where key=$1', [key]); return r[0] ? r[0].value : null; }
export async function setState(key, value) {
  await q('insert into sync_state(key,value,updated_at) values($1,$2::jsonb,now()) on conflict(key) do update set value=excluded.value, updated_at=now()', [key, JSON.stringify(value)]);
}
