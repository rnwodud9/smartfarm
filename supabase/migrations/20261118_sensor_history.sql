-- One transaction, for the existing smurffarm database. Retains every legacy row
-- and its original table in a non-API schema. Public reads keep their old names.
set local lock_timeout = '5s';

create schema smartfarm_internal;
revoke all on schema smartfarm_internal from public, anon, authenticated;

alter table public.sensor_data add column if not exists "초음파" real;
create index if not exists sensor_data_created_at_id_idx on public.sensor_data (created_at, id);

create table public.sensor_history (
  period text not null check (period in ('5min', 'hour', 'day')),
  bucket timestamptz not null,
  ph numeric, ec numeric, temp numeric, humidity numeric,
  samples integer, distance_cm real,
  primary key (period, bucket)
);
alter table public.sensor_history enable row level security;
revoke all on public.sensor_history from public, anon, authenticated;
grant select on public.sensor_history to anon;
create policy "Dashboard reads averages" on public.sensor_history for select to anon using (true);
comment on table public.sensor_history is '스마트팜 5분·시간·한국 날짜별 센서 평균. 초음파는 cm.';
comment on column public.sensor_data."초음파" is '센서에서 수면까지의 거리(cm). 측정 실패 시 NULL.';

-- Freeze only the old summaries while the snapshot is verified and switched.
lock table public.sensor_5min, public.sensor_hourly, public.sensor_daily in access exclusive mode;
alter table public.sensor_5min set schema smartfarm_internal;
alter table public.sensor_hourly set schema smartfarm_internal;
alter table public.sensor_daily set schema smartfarm_internal;

create temporary view sensor_history_before as
select '5min'::text as period, bucket, ph, ec, temp, humidity, samples from smartfarm_internal.sensor_5min
union all
select 'hour', hour, ph, ec, temp, humidity, samples from smartfarm_internal.sensor_hourly
union all
select 'day', day::timestamp at time zone 'Asia/Seoul', ph, ec, temp, humidity, samples
from smartfarm_internal.sensor_daily;
insert into public.sensor_history (period, bucket, ph, ec, temp, humidity, samples)
select period, bucket, ph, ec, temp, humidity, samples from pg_temp.sensor_history_before;
do $$
begin
  if exists (
    select * from pg_temp.sensor_history_before
    except all
    select period, bucket, ph, ec, temp, humidity, samples from public.sensor_history
  ) or (select count(*) from public.sensor_history) <> (select count(*) from pg_temp.sensor_history_before)
  then raise exception 'Sensor history verification failed'; end if;
end $$;
drop view pg_temp.sensor_history_before;

-- Compatibility for deployed dashboards that still read the old endpoints.
create view public.sensor_5min with (security_invoker = true) as
select bucket, ph, ec, temp, humidity, samples from public.sensor_history where period = '5min';
create view public.sensor_hourly with (security_invoker = true) as
select bucket as hour, ph, ec, temp, humidity, samples from public.sensor_history where period = 'hour';
create view public.sensor_daily with (security_invoker = true) as
select (bucket at time zone 'Asia/Seoul')::date as day, ph, ec, temp, humidity, samples
from public.sensor_history where period = 'day';
revoke all on public.sensor_5min, public.sensor_hourly, public.sensor_daily from public, anon, authenticated;
grant select on public.sensor_5min, public.sensor_hourly, public.sensor_daily to anon;

create function smartfarm_internal.refresh_history()
returns void language plpgsql security invoker set search_path = '' as $$
declare
  replay_from timestamptz;
begin
  -- Include yesterday for late samples. Resume further back after downtime, but
  -- never replace an existing complete daily average with a partially pruned day.
  select greatest(
    date_trunc('day', now() - interval '29 days', 'Asia/Seoul'),
    date_trunc('day', least(now() - interval '1 day', min(latest)), 'Asia/Seoul')
  ) into replay_from
  from (select max(bucket) as latest from public.sensor_history group by period) checkpoints;

  insert into public.sensor_history as h (period, bucket, ph, ec, temp, humidity, samples, distance_cm)
  select b.period, b.bucket, round(avg(s."PH")::numeric, 2), round(avg(s."EC")::numeric, 2),
         round(avg(s."온도")::numeric, 1), round(avg(s."습도")::numeric, 1),
         count(*)::integer,
         avg(s."초음파") filter (where s."초음파" between 2 and 52)
  from public.sensor_data s
  cross join lateral (values
    ('5min', date_bin('5 minutes', s.created_at, timestamptz '2000-01-01 00:00:00+00')),
    ('hour', date_trunc('hour', s.created_at, 'UTC')),
    ('day', date_trunc('day', s.created_at, 'Asia/Seoul'))
  ) b(period, bucket)
  where s.created_at >= replay_from and s.created_at <= now()
    and (b.period <> '5min' or b.bucket >= now() - interval '14 days')
  group by b.period, b.bucket
  on conflict (period, bucket) do update set
    ph = excluded.ph, ec = excluded.ec, temp = excluded.temp, humidity = excluded.humidity,
    samples = excluded.samples, distance_cm = excluded.distance_cm
  where (h.ph, h.ec, h.temp, h.humidity, h.samples, h.distance_cm)
    is distinct from (excluded.ph, excluded.ec, excluded.temp, excluded.humidity, excluded.samples, excluded.distance_cm);
end $$;

create function smartfarm_internal.prune_history()
returns void language plpgsql security invoker set search_path = '' as $$
begin
  -- Keep the original retention periods and leave unarchived measurements alone.
  delete from public.sensor_data s where s.created_at < now() - interval '30 days'
    and exists (select 1 from public.sensor_history h where h.period = 'day'
                and h.bucket = date_trunc('day', s.created_at, 'Asia/Seoul'));
  delete from public.sensor_history h where
    ((period = '5min' and bucket < now() - interval '14 days')
      or (period = 'hour' and bucket < now() - interval '60 days'))
    and exists (select 1 from public.sensor_history d where d.period = 'day'
                and d.bucket = date_trunc('day', h.bucket, 'Asia/Seoul'));
end $$;
revoke all on function smartfarm_internal.refresh_history(), smartfarm_internal.prune_history()
  from public, anon, authenticated;

select cron.unschedule(jobid) from cron.job
 where jobname in ('sensor-5min-refresh', 'sensor-hourly-refresh', 'sensor-daily-refresh');
select cron.schedule('sensor-history-refresh', '*/5 * * * *', 'select smartfarm_internal.refresh_history()');
select cron.schedule('sensor-data-prune', '0 18 * * *', 'select smartfarm_internal.prune_history()');

-- The former functions served only the replaced sensor cron jobs.
drop function public.prune_sensor_data();
drop function public.refresh_sensor_5min();
drop function public.refresh_sensor_hourly();
drop function public.refresh_sensor_daily();
select smartfarm_internal.refresh_history();
notify pgrst, 'reload schema';
