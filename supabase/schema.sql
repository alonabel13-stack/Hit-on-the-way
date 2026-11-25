-- Hit on the Way: database schema for Supabase.
-- Run this whole file once in the Supabase SQL editor. It is safe to run again:
-- tables are created only if missing and functions are replaced.
--
-- Security model: every table has row level security on and no policies, so the
-- public (anon) key cannot read or write any table directly. All access goes
-- through the functions below, which check a library passphrase, an admin token
-- or a player token. The correct answer for a round is only ever returned to
-- players after the reveal.

create schema if not exists extensions;
create extension if not exists unaccent with schema extensions;

-- ---------------------------------------------------------------- tables

create table if not exists hotw_settings (
  key text primary key,
  value text not null
);

create table if not exists playlists (
  id uuid primary key default gen_random_uuid(),
  spotify_id text unique not null,
  name text not null,
  imported_at timestamptz not null default now()
);

create table if not exists songs (
  id uuid primary key default gen_random_uuid(),
  spotify_uri text unique not null,
  title text not null,
  artists text[] not null default '{}',
  album text not null default '',
  year int,                       -- the year used for scoring (editable)
  spotify_year int,               -- the album year Spotify reported
  duration_ms int not null default 0,
  title_alts text[] not null default '{}',   -- other accepted spellings
  artist_alts text[] not null default '{}',
  album_alts text[] not null default '{}',
  hidden boolean not null default false,
  year_checked boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists playlist_songs (
  playlist_id uuid not null references playlists(id) on delete cascade,
  song_id uuid not null references songs(id) on delete cascade,
  primary key (playlist_id, song_id)
);

create table if not exists games (
  id uuid primary key default gen_random_uuid(),
  code text unique not null,
  admin_token uuid not null default gen_random_uuid(),
  state text not null default 'lobby'
    check (state in ('lobby', 'guessing', 'driver', 'reveal', 'finished')),
  playlist_ids uuid[] not null,
  total_rounds int not null default 10,
  round_no int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists players (
  id uuid primary key default gen_random_uuid(),
  game_id uuid not null references games(id) on delete cascade,
  name text not null,
  token uuid unique default gen_random_uuid(),  -- null for the driver (no phone)
  is_driver boolean not null default false,
  is_admin boolean not null default false,
  joined_at timestamptz not null default now()
);

create table if not exists rounds (
  id uuid primary key default gen_random_uuid(),
  game_id uuid not null references games(id) on delete cascade,
  round_no int not null,
  song_id uuid not null references songs(id),
  started_at timestamptz not null default now(),
  unique (game_id, round_no)
);

create table if not exists answers (
  id uuid primary key default gen_random_uuid(),
  round_id uuid not null references rounds(id) on delete cascade,
  player_id uuid not null references players(id) on delete cascade,
  year int,
  title text not null default '',
  artist text not null default '',
  album text not null default '',
  submitted boolean not null default false,
  submitted_at timestamptz,
  year_pts int,          -- 0, 1 or 2 after the reveal
  title_ok boolean,
  artist_ok boolean,
  album_ok boolean,
  unique (round_id, player_id)
);

-- Added later: each player's cartoon avatar (see js/avatars.js).
alter table players add column if not exists avatar text;

-- Added later: the bonus guess, whether this song came out before or after the last one.
alter table answers add column if not exists ba text;      -- 'before', 'after' or null
alter table answers add column if not exists ba_ok boolean;

create index if not exists players_game_idx on players(game_id);
create index if not exists rounds_game_idx on rounds(game_id);
create index if not exists answers_round_idx on answers(round_id);

alter table hotw_settings enable row level security;
alter table playlists enable row level security;
alter table songs enable row level security;
alter table playlist_songs enable row level security;
alter table games enable row level security;
alter table players enable row level security;
alter table rounds enable row level security;
alter table answers enable row level security;

do $$
declare r text;
begin
  foreach r in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on hotw_settings, playlists, songs, playlist_songs, games, players, rounds, answers from %I', r);
    end if;
  end loop;
end $$;

-- ---------------------------------------------------------------- matching

-- Clean a song title, artist or album (or a guess) before comparing.
create or replace function hotw_norm(t text) returns text
language plpgsql stable set search_path = public, extensions, pg_temp as $$
declare s text := coalesce(t, '');
begin
  s := lower(s);
  s := extensions.unaccent(s);
  -- Hebrew: drop vowel marks and cantillation, treat final letters as regular ones.
  s := regexp_replace(s, '[֑-ׇ]', '', 'g');
  s := translate(s, 'ךםןףץ', 'כמנפצ');
  -- Spotify extras: "(Remastered 2011)", "[Live]", " - Radio Edit", "feat. X".
  s := regexp_replace(s, '\([^)]*\)', ' ', 'g');
  s := regexp_replace(s, '\[[^]]*\]', ' ', 'g');
  s := regexp_replace(s, '\s[-–—]\s.*$', '');
  s := regexp_replace(s, '\m(feat|ft|featuring)\M\.?.*$', '');
  s := replace(s, '&', ' and ');
  s := regexp_replace(s, '[.,!?;:''"“”‘’`´׳״/\\_*#@$%^+=<>|~{}()-]', '', 'g');
  s := regexp_replace(s, '\s+', ' ', 'g');
  s := btrim(s);
  s := regexp_replace(s, '^(the|a|an) ', '');
  return s;
end $$;

-- Letter edits between two strings, where swapping two neighbouring letters
-- ("Beatels" for "Beatles") counts as one edit, not two.
create or replace function hotw_edits(a text, b text) returns int
language plpgsql immutable as $$
declare
  la int := length(a); lb int := length(b);
  prev2 int[]; prev int[]; cur int[];
  i int; j int; cost int; v int;
begin
  if la = 0 then return lb; end if;
  if lb = 0 then return la; end if;
  prev := array(select generate_series(0, lb));
  prev2 := prev;
  for i in 1..la loop
    cur := array[i] || array_fill(0, array[lb]);
    for j in 1..lb loop
      cost := case when substr(a, i, 1) = substr(b, j, 1) then 0 else 1 end;
      v := least(prev[j + 1] + 1, cur[j] + 1, prev[j] + cost);
      if i > 1 and j > 1 and substr(a, i, 1) = substr(b, j - 1, 1)
         and substr(a, i - 1, 1) = substr(b, j, 1) then
        v := least(v, prev2[j - 1] + 1);
      end if;
      cur[j + 1] := v;
    end loop;
    prev2 := prev; prev := cur;
  end loop;
  return prev[lb + 1];
end $$;

-- 0..1 similarity by letter edits.
create or replace function hotw_similarity(a text, b text) returns real
language sql immutable as $$
  select case
    when a = b then 1::real
    when greatest(length(a), length(b)) = 0 then 0::real
    else 1 - hotw_edits(left(a, 120), left(b, 120))::real
             / greatest(length(left(a, 120)), length(left(b, 120)))
  end
$$;

-- Does a guess match any of the accepted answers?
-- Short answers (4 letters or fewer) must match exactly; longer ones need 80% similarity.
create or replace function hotw_match(guess text, accepted text[]) returns boolean
language plpgsql stable set search_path = public, extensions, pg_temp as $$
declare g text := replace(hotw_norm(guess), ' ', ''); a text; n text;
begin
  if g = '' then return false; end if;
  foreach a in array coalesce(accepted, '{}') loop
    n := replace(hotw_norm(a), ' ', '');
    continue when n = '';
    if length(n) <= 4 then
      if g = n then return true; end if;
    elsif hotw_similarity(g, n) >= 0.8 then
      return true;
    end if;
  end loop;
  return false;
end $$;

create or replace function hotw_year_points(guess int, actual int) returns int
language sql immutable as $$
  select case
    when guess is null or actual is null then 0
    when guess = actual then 2
    when abs(guess - actual) <= 2 then 1
    else 0
  end
$$;

-- ---------------------------------------------------------------- helpers

create or replace function hotw_check_key(p_key text) returns void
language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare h text;
begin
  select value into h from hotw_settings where key = 'library_key_sha256';
  if h is null or p_key is null or encode(sha256(convert_to(p_key, 'UTF8')), 'hex') <> h then
    raise exception 'Wrong library passphrase' using errcode = '28000';
  end if;
end $$;

create or replace function hotw_game_for_admin(p_admin_token uuid) returns games
language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare g games;
begin
  select * into g from games where admin_token = p_admin_token;
  if g.id is null then raise exception 'Game not found' using errcode = '28000'; end if;
  return g;
end $$;

-- Points for one answer. The before/after bonus only counts when everything else was wrong.
create or replace function hotw_points(p_year_pts int, p_title boolean, p_artist boolean, p_album boolean, p_ba boolean)
returns int language sql immutable set search_path = public, extensions, pg_temp as $$
  select coalesce(p_year_pts, 0) + coalesce(p_title, false)::int + coalesce(p_artist, false)::int
       + coalesce(p_album, false)::int
       + case when coalesce(p_ba, false) and coalesce(p_year_pts, 0) = 0 and not coalesce(p_title, false)
                   and not coalesce(p_artist, false) and not coalesce(p_album, false) then 1 else 0 end;
$$;

-- The year of the song played in the round before this one, or null in round 1.
create or replace function hotw_prev_year(p_round_id uuid) returns int
language sql security definer set search_path = public, extensions, pg_temp as $$
  select ps.year
  from rounds r
  join rounds pr on pr.game_id = r.game_id and pr.round_no = r.round_no - 1
  join songs ps on ps.id = pr.song_id
  where r.id = p_round_id;
$$;

create or replace function hotw_score_round(p_round_id uuid) returns void
language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare s songs; prev_year int;
begin
  select songs.* into s from rounds join songs on songs.id = rounds.song_id where rounds.id = p_round_id;
  prev_year := hotw_prev_year(p_round_id);
  update answers a set
    year_pts = hotw_year_points(a.year, s.year),
    title_ok = hotw_match(a.title, array[s.title] || s.title_alts),
    artist_ok = hotw_match(a.artist, s.artists || s.artist_alts || array[array_to_string(s.artists, ' and ')]),
    album_ok = hotw_match(a.album, array[s.album] || s.album_alts),
    -- Before/after the previous song: right or wrong. Same year counts either way.
    -- It only earns a point when everything else is wrong (see hotw_points).
    ba_ok = case
      when a.ba is null or prev_year is null or s.year is null then null
      when s.year = prev_year then true
      when a.ba = 'before' then s.year < prev_year
      when a.ba = 'after' then s.year > prev_year
      end
  where a.round_id = p_round_id;
end $$;

-- ---------------------------------------------------------------- library

-- The first call sets the passphrase. Later calls must match it.
create or replace function hotw_library_login(p_key text) returns boolean
language plpgsql security definer set search_path = public, extensions, pg_temp as $$
begin
  if p_key is null or length(p_key) < 6 then
    raise exception 'Use a passphrase of at least 6 characters';
  end if;
  insert into hotw_settings(key, value)
    values ('library_key_sha256', encode(sha256(convert_to(p_key, 'UTF8')), 'hex'))
    on conflict (key) do nothing;
  perform hotw_check_key(p_key);
  return true;
end $$;

-- songs: [{uri, title, artists:[..], album, spotify_year, duration_ms}]
create or replace function hotw_import_playlist(p_key text, p_spotify_id text, p_name text, p_songs jsonb)
returns jsonb
language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare pl uuid; n int;
begin
  perform hotw_check_key(p_key);
  insert into playlists(spotify_id, name) values (p_spotify_id, p_name)
    on conflict (spotify_id) do update set name = excluded.name, imported_at = now()
    returning id into pl;

  insert into songs(spotify_uri, title, artists, album, year, spotify_year, duration_ms)
  select x->>'uri', x->>'title',
         coalesce(array(select jsonb_array_elements_text(x->'artists')), '{}'),
         coalesce(x->>'album', ''),
         nullif(x->>'spotify_year', '')::int, nullif(x->>'spotify_year', '')::int,
         coalesce(nullif(x->>'duration_ms', '')::int, 0)
  from jsonb_array_elements(p_songs) x
  where coalesce(x->>'uri', '') <> ''
  on conflict (spotify_uri) do nothing;

  delete from playlist_songs where playlist_id = pl;
  insert into playlist_songs(playlist_id, song_id)
    select distinct pl, s.id from jsonb_array_elements(p_songs) x
    join songs s on s.spotify_uri = x->>'uri'
    on conflict do nothing;
  get diagnostics n = row_count;
  return jsonb_build_object('playlist_id', pl, 'songs', n);
end $$;

create or replace function hotw_list_playlists(p_key text) returns jsonb
language plpgsql security definer set search_path = public, extensions, pg_temp as $$
begin
  perform hotw_check_key(p_key);
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', p.id, 'spotify_id', p.spotify_id, 'name', p.name, 'imported_at', p.imported_at,
      'songs', (select count(*) from playlist_songs ps join songs s on s.id = ps.song_id
                where ps.playlist_id = p.id and not s.hidden),
      'years_to_check', (select count(*) from playlist_songs ps join songs s on s.id = ps.song_id
                where ps.playlist_id = p.id and not s.year_checked)
    ) order by p.name)
    from playlists p), '[]'::jsonb);
end $$;

create or replace function hotw_delete_playlist(p_key text, p_id uuid) returns void
language plpgsql security definer set search_path = public, extensions, pg_temp as $$
begin
  perform hotw_check_key(p_key);
  delete from playlists where id = p_id;
end $$;

create or replace function hotw_list_songs(p_key text, p_playlist_id uuid, p_search text default '')
returns jsonb
language plpgsql security definer set search_path = public, extensions, pg_temp as $$
begin
  perform hotw_check_key(p_key);
  return coalesce((
    select jsonb_agg(to_jsonb(s) - 'created_at' order by s.title)
    from songs s
    where (p_playlist_id is null or exists (
             select 1 from playlist_songs ps where ps.song_id = s.id and ps.playlist_id = p_playlist_id))
      and (coalesce(p_search, '') = ''
           or s.title ilike '%' || p_search || '%'
           or array_to_string(s.artists, ' ') ilike '%' || p_search || '%'
           or s.album ilike '%' || p_search || '%')
  ), '[]'::jsonb);
end $$;

create or replace function hotw_update_song(
  p_key text, p_id uuid, p_year int, p_album text,
  p_title_alts text[], p_artist_alts text[], p_album_alts text[], p_hidden boolean)
returns void
language plpgsql security definer set search_path = public, extensions, pg_temp as $$
begin
  perform hotw_check_key(p_key);
  update songs set
    year = p_year, year_checked = true,
    album = coalesce(nullif(btrim(p_album), ''), album),
    title_alts = coalesce(p_title_alts, '{}'),
    artist_alts = coalesce(p_artist_alts, '{}'),
    album_alts = coalesce(p_album_alts, '{}'),
    hidden = coalesce(p_hidden, false)
  where id = p_id;
end $$;

-- Songs whose original year has not been looked up yet.
create or replace function hotw_years_to_check(p_key text, p_limit int default 50) returns jsonb
language plpgsql security definer set search_path = public, extensions, pg_temp as $$
begin
  perform hotw_check_key(p_key);
  return coalesce((
    select jsonb_agg(jsonb_build_object('id', id, 'title', title, 'artists', artists, 'year', year))
    from (select * from songs where not year_checked order by created_at limit p_limit) s
  ), '[]'::jsonb);
end $$;

-- Record a year lookup. Only moves the year earlier (remasters and compilations are later).
create or replace function hotw_set_found_year(p_key text, p_id uuid, p_found int) returns void
language plpgsql security definer set search_path = public, extensions, pg_temp as $$
begin
  perform hotw_check_key(p_key);
  update songs set
    year = case when p_found is not null and p_found > 1900 and (year is null or p_found < year)
                then p_found else year end,
    year_checked = true
  where id = p_id;
end $$;

-- ---------------------------------------------------------------- game setup

drop function if exists hotw_create_game(text, uuid[], int, text);
create or replace function hotw_create_game(p_key text, p_playlist_ids uuid[], p_rounds int, p_admin_name text,
                                            p_admin_avatar text default null)
returns jsonb
language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare g games; p players; c text; tries int := 0;
begin
  perform hotw_check_key(p_key);
  if coalesce(array_length(p_playlist_ids, 1), 0) = 0 then raise exception 'Pick at least one playlist'; end if;
  loop
    -- 4 letters, no look-alikes (no I, O).
    c := (select string_agg(substr('ABCDEFGHJKLMNPQRSTUVWXYZ', 1 + floor(random() * 24)::int, 1), '')
          from generate_series(1, 4));
    exit when not exists (select 1 from games where code = c and state <> 'finished');
    tries := tries + 1;
    if tries > 50 then raise exception 'Could not make a game code'; end if;
  end loop;
  delete from games where code = c;  -- an old finished game with the same code
  insert into games(code, playlist_ids, total_rounds)
    values (c, p_playlist_ids, greatest(1, least(coalesce(p_rounds, 10), 100)))
    returning * into g;
  insert into players(game_id, name, is_admin, avatar)
    values (g.id, coalesce(nullif(btrim(p_admin_name), ''), 'Admin'), true, left(p_admin_avatar, 20))
    returning * into p;
  return jsonb_build_object('code', g.code, 'admin_token', g.admin_token,
                            'player_id', p.id, 'player_token', p.token);
end $$;

drop function if exists hotw_join(text, text);
create or replace function hotw_join(p_code text, p_name text, p_avatar text default null) returns jsonb
language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare g games; p players; nm text := left(btrim(coalesce(p_name, '')), 24);
begin
  -- Lock the game so two people can't grab the same avatar at the same moment.
  select * into g from games where code = upper(btrim(p_code)) for update;
  if g.id is null then raise exception 'No game with that code'; end if;
  if g.state = 'finished' then raise exception 'That game has ended'; end if;
  if nm = '' then raise exception 'Type your name'; end if;
  if p_avatar is not null and exists (select 1 from players where game_id = g.id and avatar = p_avatar) then
    raise exception 'Someone already took that avatar. Pick another one';
  end if;
  if exists (select 1 from players where game_id = g.id and lower(name) = lower(nm)) then
    raise exception 'That name is taken in this game';
  end if;
  insert into players(game_id, name, avatar) values (g.id, nm, left(p_avatar, 20)) returning * into p;
  return jsonb_build_object('code', g.code, 'player_id', p.id, 'player_token', p.token);
end $$;

-- Avatars already used in a game, so the join screen can grey them out.
create or replace function hotw_taken_avatars(p_code text) returns jsonb
language sql security definer set search_path = public, extensions, pg_temp as $$
  select coalesce(jsonb_agg(p.avatar), '[]'::jsonb)
  from players p join games g on g.id = p.game_id
  where g.code = upper(btrim(p_code)) and p.avatar is not null;
$$;

create or replace function hotw_add_driver(p_admin_token uuid, p_name text) returns uuid
language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare g games := hotw_game_for_admin(p_admin_token); pid uuid;
begin
  insert into players(game_id, name, is_driver, token, avatar)
    values (g.id, coalesce(nullif(left(btrim(p_name), 24), ''), 'Driver'), true, null, 'driver')
    returning id into pid;
  return pid;
end $$;

create or replace function hotw_remove_player(p_admin_token uuid, p_player_id uuid) returns void
language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare g games := hotw_game_for_admin(p_admin_token);
begin
  delete from players where id = p_player_id and game_id = g.id and not is_admin;
end $$;

-- ---------------------------------------------------------------- rounds

-- Start the next round. Returns the Spotify URI to play (admin only), or finished.
create or replace function hotw_next_round(p_admin_token uuid) returns jsonb
language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare g games := hotw_game_for_admin(p_admin_token); s songs; rid uuid;
begin
  if g.state not in ('lobby', 'reveal') then
    raise exception 'Finish this round first';
  end if;
  if g.round_no >= g.total_rounds then
    update games set state = 'finished', updated_at = now() where id = g.id;
    return jsonb_build_object('finished', true);
  end if;

  -- Prefer songs not played in this game nor in any game in the last 30 days.
  select songs.* into s from songs
  where not hidden
    and exists (select 1 from playlist_songs ps where ps.song_id = songs.id and ps.playlist_id = any(g.playlist_ids))
    and not exists (select 1 from rounds r join games og on og.id = r.game_id
                    where r.song_id = songs.id and og.created_at > now() - interval '30 days')
  order by random() limit 1;
  if s.id is null then
    select songs.* into s from songs
    where not hidden
      and exists (select 1 from playlist_songs ps where ps.song_id = songs.id and ps.playlist_id = any(g.playlist_ids))
      and not exists (select 1 from rounds r where r.song_id = songs.id and r.game_id = g.id)
    order by random() limit 1;
  end if;
  if s.id is null then raise exception 'No songs left in these playlists'; end if;

  insert into rounds(game_id, round_no, song_id) values (g.id, g.round_no + 1, s.id) returning id into rid;
  update games set round_no = round_no + 1, state = 'guessing', updated_at = now() where id = g.id;
  return jsonb_build_object('finished', false, 'round_no', g.round_no + 1,
                            'spotify_uri', s.spotify_uri, 'duration_ms', s.duration_ms);
end $$;

-- The current song's URI again, for the admin's play button after a reconnect.
create or replace function hotw_current_uri(p_admin_token uuid) returns jsonb
language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare g games := hotw_game_for_admin(p_admin_token);
begin
  return (select jsonb_build_object('spotify_uri', s.spotify_uri, 'duration_ms', s.duration_ms)
          from rounds r join songs s on s.id = r.song_id
          where r.game_id = g.id and r.round_no = g.round_no);
end $$;

create or replace function hotw_reveal_internal(g games) returns void
language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare rid uuid;
begin
  select id into rid from rounds where game_id = g.id and round_no = g.round_no;
  -- Everyone gets an answer row so the reveal lists all players.
  insert into answers(round_id, player_id)
    select rid, p.id from players p where p.game_id = g.id
    on conflict do nothing;
  perform hotw_score_round(rid);
  update games set state = 'reveal', updated_at = now() where id = g.id;
end $$;

-- After the phone players are done: driver's turn if there is a driver, else reveal.
create or replace function hotw_advance_after_guessing(g games) returns void
language plpgsql security definer set search_path = public, extensions, pg_temp as $$
begin
  if exists (select 1 from players where game_id = g.id and is_driver) then
    update games set state = 'driver', updated_at = now() where id = g.id;
  else
    perform hotw_reveal_internal(g);
  end if;
end $$;

-- Save a phone player's answer as they type; p_submit locks it.
drop function if exists hotw_save_answer(uuid, int, text, text, text, boolean);
create or replace function hotw_save_answer(
  p_player_token uuid, p_year int, p_title text, p_artist text, p_album text, p_submit boolean,
  p_ba text default null)
returns jsonb
language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare p players; g games; rid uuid; done boolean;
begin
  select * into p from players where token = p_player_token;
  if p.id is null then raise exception 'You are not in this game' using errcode = '28000'; end if;
  select * into g from games where id = p.game_id;
  if g.state <> 'guessing' then return jsonb_build_object('saved', false, 'reason', 'closed'); end if;
  select id into rid from rounds where game_id = g.id and round_no = g.round_no;

  insert into answers(round_id, player_id, year, title, artist, album, ba, submitted, submitted_at)
    values (rid, p.id, p_year, left(coalesce(p_title, ''), 200), left(coalesce(p_artist, ''), 200),
            left(coalesce(p_album, ''), 200),
            case when p_ba in ('before', 'after') then p_ba end, coalesce(p_submit, false),
            case when p_submit then now() end)
  on conflict (round_id, player_id) do update set
    year = excluded.year, title = excluded.title, artist = excluded.artist, album = excluded.album,
    ba = excluded.ba, submitted = excluded.submitted, submitted_at = excluded.submitted_at
  where not answers.submitted;

  if p_submit then
    select not exists (
      select 1 from players pl
      where pl.game_id = g.id and not pl.is_driver
        and not exists (select 1 from answers a where a.round_id = rid and a.player_id = pl.id and a.submitted)
    ) into done;
    if done then perform hotw_advance_after_guessing(g); end if;
  end if;
  return jsonb_build_object('saved', true);
end $$;

-- Admin closes guessing early (someone is taking too long).
create or replace function hotw_close_guessing(p_admin_token uuid) returns void
language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare g games := hotw_game_for_admin(p_admin_token);
begin
  if g.state = 'guessing' then perform hotw_advance_after_guessing(g); end if;
end $$;

-- Admin types in the driver's spoken answers. Reveals once every driver has answered.
drop function if exists hotw_driver_answer(uuid, uuid, int, text, text, text);
create or replace function hotw_driver_answer(
  p_admin_token uuid, p_player_id uuid, p_year int, p_title text, p_artist text, p_album text,
  p_ba text default null)
returns void
language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare g games := hotw_game_for_admin(p_admin_token); rid uuid;
begin
  if g.state <> 'driver' then raise exception 'It is not the driver''s turn'; end if;
  if not exists (select 1 from players where id = p_player_id and game_id = g.id and is_driver) then
    raise exception 'Not a driver in this game';
  end if;
  select id into rid from rounds where game_id = g.id and round_no = g.round_no;
  insert into answers(round_id, player_id, year, title, artist, album, ba, submitted, submitted_at)
    values (rid, p_player_id, p_year, coalesce(p_title, ''), coalesce(p_artist, ''), coalesce(p_album, ''),
            case when p_ba in ('before', 'after') then p_ba end, true, now())
  on conflict (round_id, player_id) do update set
    year = excluded.year, title = excluded.title, artist = excluded.artist, album = excluded.album,
    ba = excluded.ba, submitted = true, submitted_at = now();
  if not exists (
    select 1 from players pl where pl.game_id = g.id and pl.is_driver
      and not exists (select 1 from answers a where a.round_id = rid and a.player_id = pl.id and a.submitted)
  ) then
    perform hotw_reveal_internal(g);
  end if;
end $$;

create or replace function hotw_reveal(p_admin_token uuid) returns void
language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare g games := hotw_game_for_admin(p_admin_token);
begin
  if g.state in ('guessing', 'driver') then perform hotw_reveal_internal(g); end if;
end $$;

-- Admin fixes a close call on the reveal. p_points: 0/1 for song, artist, album; 0/1/2 for year.
create or replace function hotw_override(p_admin_token uuid, p_player_id uuid, p_field text, p_points int)
returns void
language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare g games := hotw_game_for_admin(p_admin_token); rid uuid;
begin
  if g.state <> 'reveal' then raise exception 'You can only change points on the reveal'; end if;
  select id into rid from rounds where game_id = g.id and round_no = g.round_no;
  update answers set
    year_pts = case when p_field = 'year' then greatest(0, least(2, p_points)) else year_pts end,
    title_ok = case when p_field = 'title' then p_points > 0 else title_ok end,
    artist_ok = case when p_field = 'artist' then p_points > 0 else artist_ok end,
    album_ok = case when p_field = 'album' then p_points > 0 else album_ok end,
    ba_ok = case when p_field = 'ba' then p_points > 0 else ba_ok end
  where round_id = rid and player_id = p_player_id;
end $$;

create or replace function hotw_end_game(p_admin_token uuid) returns void
language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare g games := hotw_game_for_admin(p_admin_token);
begin
  if g.state in ('guessing', 'driver') then perform hotw_reveal_internal(g); end if;
  update games set state = 'finished', updated_at = now() where id = g.id;
end $$;

-- ---------------------------------------------------------------- state for screens

-- Everything a screen needs, polled every second or two. Song details only after the reveal.
create or replace function hotw_state(p_code text, p_player_token uuid, p_admin_token uuid default null)
returns jsonb
language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare g games; me players; rid uuid; is_admin boolean; result jsonb; s songs;
begin
  select * into g from games where code = upper(btrim(p_code));
  if g.id is null then raise exception 'No game with that code'; end if;
  is_admin := p_admin_token is not null and p_admin_token = g.admin_token;
  select * into me from players where token = p_player_token and game_id = g.id;
  if me.id is null and not is_admin then raise exception 'You are not in this game' using errcode = '28000'; end if;
  select id into rid from rounds where game_id = g.id and round_no = g.round_no;

  result := jsonb_build_object(
    'code', g.code, 'state', g.state, 'round_no', g.round_no, 'total_rounds', g.total_rounds,
    'updated_at', g.updated_at, 'is_admin', is_admin,
    'me', case when me.id is null then null
              else jsonb_build_object('id', me.id, 'name', me.name, 'avatar', me.avatar) end,
    'players', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', p.id, 'name', p.name, 'avatar', p.avatar, 'is_driver', p.is_driver, 'is_admin', p.is_admin,
        'submitted', coalesce((select a.submitted from answers a where a.round_id = rid and a.player_id = p.id), false),
        'total', coalesce((
          select sum(hotw_points(a.year_pts, a.title_ok, a.artist_ok, a.album_ok, a.ba_ok))
          from answers a join rounds r on r.id = a.round_id
          where a.player_id = p.id
            and (r.round_no < g.round_no or g.state in ('reveal', 'finished'))), 0),
        'last', case when g.state in ('reveal', 'finished') then (
          select hotw_points(a.year_pts, a.title_ok, a.artist_ok, a.album_ok, a.ba_ok)
          from answers a where a.round_id = rid and a.player_id = p.id) end
      ) order by p.joined_at)
      from players p where p.game_id = g.id), '[]'::jsonb)
  );

  -- The song before this one, shown during the round so players can guess older or newer.
  if rid is not null and g.round_no > 1 then
    result := result || jsonb_build_object('prev_song', (
      select jsonb_build_object('title', ps.title, 'artists', ps.artists, 'album', ps.album, 'year', ps.year)
      from rounds pr join songs ps on ps.id = pr.song_id
      where pr.game_id = g.id and pr.round_no = g.round_no - 1));
  end if;

  if me.id is not null and rid is not null then
    result := result || jsonb_build_object('my_answer', (
      select jsonb_build_object('year', a.year, 'title', a.title, 'artist', a.artist,
                                'album', a.album, 'ba', a.ba, 'submitted', a.submitted)
      from answers a where a.round_id = rid and a.player_id = me.id));
  end if;

  if g.state in ('reveal', 'finished') and rid is not null then
    select songs.* into s from rounds join songs on songs.id = rounds.song_id where rounds.id = rid;
    result := result || jsonb_build_object(
      'song', jsonb_build_object('title', s.title, 'artists', s.artists, 'album', s.album, 'year', s.year),
      'answers', coalesce((
        select jsonb_agg(jsonb_build_object(
          'player_id', a.player_id, 'year', a.year, 'title', a.title, 'artist', a.artist, 'album', a.album,
          'ba', a.ba, 'year_pts', coalesce(a.year_pts, 0), 'title_ok', coalesce(a.title_ok, false),
          'artist_ok', coalesce(a.artist_ok, false), 'album_ok', coalesce(a.album_ok, false),
          'ba_ok', a.ba_ok))
        from answers a where a.round_id = rid), '[]'::jsonb));
  end if;

  if g.state = 'finished' then
    result := result || jsonb_build_object('history', coalesce((
      select jsonb_agg(jsonb_build_object('round_no', r.round_no, 'title', s2.title,
                                          'artists', s2.artists, 'year', s2.year) order by r.round_no)
      from rounds r join songs s2 on s2.id = r.song_id where r.game_id = g.id), '[]'::jsonb));
  end if;
  return result;
end $$;

-- ---------------------------------------------------------------- permissions

do $$
declare r text; f record;
begin
  for f in select p.oid::regprocedure as sig from pg_proc p
           join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname like 'hotw\_%' loop
    execute format('revoke all on function %s from public', f.sig);
    foreach r in array array['anon', 'authenticated'] loop
      if exists (select 1 from pg_roles where rolname = r) then
        execute format('revoke all on function %s from %I', f.sig, r);
      end if;
    end loop;
  end loop;
end $$;

-- Only these functions are callable with the public key.
do $$
declare r text; fn text;
begin
  foreach r in array array['anon', 'authenticated'] loop
    continue when not exists (select 1 from pg_roles where rolname = r);
    foreach fn in array array[
      'hotw_library_login(text)',
      'hotw_import_playlist(text,text,text,jsonb)',
      'hotw_list_playlists(text)',
      'hotw_delete_playlist(text,uuid)',
      'hotw_list_songs(text,uuid,text)',
      'hotw_update_song(text,uuid,int,text,text[],text[],text[],boolean)',
      'hotw_years_to_check(text,int)',
      'hotw_set_found_year(text,uuid,int)',
      'hotw_create_game(text,uuid[],int,text,text)',
      'hotw_join(text,text,text)',
      'hotw_taken_avatars(text)',
      'hotw_add_driver(uuid,text)',
      'hotw_remove_player(uuid,uuid)',
      'hotw_next_round(uuid)',
      'hotw_current_uri(uuid)',
      'hotw_save_answer(uuid,int,text,text,text,boolean,text)',
      'hotw_close_guessing(uuid)',
      'hotw_driver_answer(uuid,uuid,int,text,text,text,text)',
      'hotw_reveal(uuid)',
      'hotw_override(uuid,uuid,text,int)',
      'hotw_end_game(uuid)',
      'hotw_state(text,uuid,uuid)'
    ] loop
      execute format('grant execute on function %s to %I', fn, r);
    end loop;
  end loop;
end $$;
