-- E-VOTE TARUNA — skema Supabase
-- Jalankan di Supabase SQL Editor, atau: npm run db:setup

create extension if not exists pgcrypto;

-- =========================================================
-- TABEL
-- =========================================================

create table if not exists public.settings (
    id integer primary key default 1 check (id = 1),
    is_voting_open boolean not null default true,
    allow_public_results boolean not null default true,
    allow_self_registration boolean not null default true,
    updated_at timestamptz not null default now()
);

-- Untuk database yang dibuat sebelum pendaftaran mandiri ada.
alter table public.settings
    add column if not exists allow_self_registration boolean not null default true;

insert into public.settings (id)
values (1)
on conflict (id) do nothing;

create table if not exists public.candidates (
    id uuid primary key default gen_random_uuid(),
    number integer not null unique check (number > 0),
    name text not null check (length(btrim(name)) > 0),
    photo_url text,
    vision text not null default '',
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create table if not exists public.candidate_missions (
    id bigserial primary key,
    candidate_id uuid not null references public.candidates(id) on delete cascade,
    position integer not null,
    text text not null,
    unique (candidate_id, position)
);

create table if not exists public.voters (
    id uuid primary key default gen_random_uuid(),
    name text not null check (length(btrim(name)) > 0),
    class_name text not null check (length(btrim(class_name)) > 0),
    nit text not null unique,
    voted_at timestamptz,
    created_at timestamptz not null default now()
);

-- NIT dipakai sebagai kunci identitas; nama dan kelas hanya dicocokkan.
create index if not exists voters_name_idx
    on public.voters (name);

create index if not exists voters_class_name_idx
    on public.voters (class_name);

-- Suara disimpan sebagai agregat per kandidat, bukan baris per pemilih.
-- Dengan begitu tidak ada voter_id, timestamp, maupun urutan baris suara yang
-- bisa dicocokkan dengan voters.voted_at untuk menelusuri pilihan seseorang.
create table if not exists public.vote_tallies (
    candidate_id uuid primary key references public.candidates(id) on delete cascade,
    votes integer not null default 0 check (votes >= 0)
);

create table if not exists public.audit_logs (
    id bigserial primary key,
    actor text not null default 'admin',
    action text not null,
    detail jsonb,
    created_at timestamptz not null default now()
);

create table if not exists public.admin_login_attempts (
    id bigserial primary key,
    ip_hash text not null,
    attempted_at timestamptz not null default now()
);

create index if not exists admin_login_attempts_ip_idx
    on public.admin_login_attempts (ip_hash, attempted_at desc);

create index if not exists voters_voted_at_idx
    on public.voters (voted_at);

-- =========================================================
-- VIEW
-- =========================================================

create or replace view public.candidate_results
with (security_invoker = true) as
select
    c.id as candidate_id,
    coalesce(t.votes, 0)::integer as votes
from public.candidates c
left join public.vote_tallies t on t.candidate_id = c.id;

create or replace view public.election_stats
with (security_invoker = true) as
select
    (select count(*) from public.voters)::integer as total_voters,
    (select count(*) from public.voters where voted_at is not null)::integer as voted_voters,
    (select coalesce(sum(votes), 0) from public.vote_tallies)::integer as total_votes,
    (select count(*) from public.candidates)::integer as total_candidates;

-- =========================================================
-- FUNGSI PEMILU
-- =========================================================

create or replace function public.cast_vote(p_voter_id uuid, p_candidate_id uuid)
returns table (
    vote_id uuid,
    voted_at timestamptz,
    candidate_name text,
    candidate_number integer
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_vote_id uuid;
    v_existing_voted_at timestamptz;
    v_voted_at timestamptz;
begin
    -- Kunci baris settings: admin yang menutup TPS akan menunggu vote yang sedang berjalan.
    perform 1
    from public.settings
    where id = 1 and is_voting_open
    for share;

    if not found then
        raise exception 'VOTING_CLOSED';
    end if;

    select voter.voted_at into v_existing_voted_at
    from public.voters as voter
    where voter.id = p_voter_id
    for update;

    if not found then
        raise exception 'VOTER_NOT_FOUND';
    end if;

    if v_existing_voted_at is not null then
        raise exception 'ALREADY_VOTED';
    end if;

    if not exists (select 1 from public.candidates where id = p_candidate_id) then
        raise exception 'CANDIDATE_NOT_FOUND';
    end if;

    v_vote_id := gen_random_uuid();
    v_voted_at := now();

    insert into public.vote_tallies (candidate_id, votes)
    values (p_candidate_id, 1)
    on conflict (candidate_id) do update
    set votes = vote_tallies.votes + 1;

    update public.voters
    set voted_at = v_voted_at
    where id = p_voter_id;

    return query
        select v_vote_id, v_voted_at, c.name, c.number
        from public.candidates c
        where c.id = p_candidate_id;
end;
$$;

create or replace function public.reset_votes()
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
    -- Tunggu vote yang sedang berjalan dan tahan vote baru sampai reset selesai.
    perform 1 from public.settings where id = 1 for update;

    -- Supabase mengaktifkan safeupdate: DELETE/UPDATE tanpa WHERE ditolak.
    delete from public.vote_tallies where true;
    update public.voters set voted_at = null where voted_at is not null;
end;
$$;

create or replace function public.save_candidate(
    p_id uuid,
    p_number integer,
    p_name text,
    p_photo_url text,
    p_vision text,
    p_missions text[]
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_id uuid;
begin
    if p_number is null or p_number < 1 then
        raise exception 'INVALID_NUMBER';
    end if;
    if p_name is null or length(btrim(p_name)) = 0 then
        raise exception 'INVALID_NAME';
    end if;
    if p_missions is null or not exists (
        select 1 from unnest(p_missions) as mission
        where length(btrim(mission)) > 0
    ) then
        raise exception 'INVALID_MISSIONS';
    end if;

    if p_id is null then
        insert into public.candidates (number, name, photo_url, vision)
        values (
            p_number,
            btrim(p_name),
            nullif(btrim(coalesce(p_photo_url, '')), ''),
            coalesce(p_vision, '')
        )
        returning id into v_id;
    else
        update public.candidates
        set number = p_number,
            name = btrim(p_name),
            photo_url = nullif(btrim(coalesce(p_photo_url, '')), ''),
            vision = coalesce(p_vision, ''),
            updated_at = now()
        where id = p_id
        returning id into v_id;

        if v_id is null then
            raise exception 'CANDIDATE_NOT_FOUND';
        end if;

        delete from public.candidate_missions where candidate_id = v_id;
    end if;

    insert into public.candidate_missions (candidate_id, position, text)
    select v_id, ordinality::integer, btrim(mission)
    from unnest(p_missions) with ordinality as t(mission, ordinality)
    where length(btrim(mission)) > 0;

    return v_id;
exception
    when unique_violation then
        raise exception 'DUPLICATE_NUMBER';
end;
$$;

create or replace function public.delete_candidate(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_votes integer;
begin
    select coalesce(sum(votes), 0) into v_votes
    from public.vote_tallies
    where candidate_id = p_id;

    if v_votes > 0 then
        raise exception 'CANDIDATE_HAS_VOTES';
    end if;

    delete from public.candidates where id = p_id;

    if not found then
        raise exception 'CANDIDATE_NOT_FOUND';
    end if;
end;
$$;

create or replace function public.resolve_voter(p_name text, p_class text, p_nit text)
returns table (
    id uuid,
    name text,
    class_name text,
    nit text,
    voted_at timestamptz,
    created_at timestamptz,
    is_new boolean
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_name text := upper(regexp_replace(btrim(coalesce(p_name, '')), '\s+', ' ', 'g'));
    v_class text := upper(regexp_replace(btrim(coalesce(p_class, '')), '\s+', ' ', 'g'));
    v_nit text := upper(btrim(coalesce(p_nit, '')));
    v_voter public.voters%rowtype;
    v_open boolean;
begin
    if v_name = '' or length(v_name) > 120 then
        raise exception 'INVALID_NAME';
    end if;
    if v_class = '' or length(v_class) > 40 then
        raise exception 'INVALID_CLASS';
    end if;
    if v_nit !~ '^[A-Z0-9._-]{4,20}$' then
        raise exception 'INVALID_NIT';
    end if;

    select voter.* into v_voter
    from public.voters as voter
    where voter.nit = v_nit;

    if found then
        if v_voter.name <> v_name or v_voter.class_name <> v_class then
            raise exception 'IDENTITY_MISMATCH';
        end if;
        if v_voter.voted_at is not null then
            raise exception 'ALREADY_VOTED';
        end if;

        return query
            select v_voter.id, v_voter.name, v_voter.class_name, v_voter.nit,
                   v_voter.voted_at, v_voter.created_at, false;
        return;
    end if;

    select settings.allow_self_registration into v_open
    from public.settings as settings
    where settings.id = 1;

    if not coalesce(v_open, false) then
        raise exception 'REGISTRATION_CLOSED';
    end if;

    begin
        insert into public.voters (name, class_name, nit)
        values (v_name, v_class, v_nit)
        returning * into v_voter;
    exception
        when unique_violation then
            -- Dua login dengan NIT baru bisa berjalan bersamaan.
            select voter.* into v_voter
            from public.voters as voter
            where voter.nit = v_nit;

            if not found then
                raise;
            end if;
            if v_voter.name <> v_name or v_voter.class_name <> v_class then
                raise exception 'IDENTITY_MISMATCH';
            end if;
            if v_voter.voted_at is not null then
                raise exception 'ALREADY_VOTED';
            end if;

            return query
                select v_voter.id, v_voter.name, v_voter.class_name, v_voter.nit,
                       v_voter.voted_at, v_voter.created_at, false;
            return;
    end;

    return query
        select v_voter.id, v_voter.name, v_voter.class_name, v_voter.nit,
               v_voter.voted_at, v_voter.created_at, true;
end;
$$;

create or replace function public.import_voters(p_rows jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_item jsonb;
    v_index integer;
    v_name text;
    v_class text;
    v_nit text;
    v_added integer := 0;
    v_updated integer := 0;
    v_skipped integer := 0;
    v_invalid integer := 0;
    v_errors jsonb := '[]'::jsonb;
    v_seen text[] := array[]::text[];
    v_voter public.voters%rowtype;
begin
    if p_rows is null or jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) = 0 then
        raise exception 'IMPORT_EMPTY';
    end if;
    if jsonb_array_length(p_rows) > 5000 then
        raise exception 'IMPORT_TOO_LARGE';
    end if;

    for v_item, v_index in
        select value, ordinality
        from jsonb_array_elements(p_rows) with ordinality
    loop
        v_name := upper(regexp_replace(btrim(coalesce(v_item->>'name', '')), '\s+', ' ', 'g'));
        v_class := upper(regexp_replace(btrim(coalesce(v_item->>'className', '')), '\s+', ' ', 'g'));
        v_nit := upper(btrim(coalesce(v_item->>'nit', '')));

        if v_name = '' or length(v_name) > 120 then
            v_invalid := v_invalid + 1;
            if jsonb_array_length(v_errors) < 50 then
                v_errors := v_errors || jsonb_build_object(
                    'row', v_index, 'nit', v_nit, 'message', 'Nama wajib diisi (maksimal 120 karakter).'
                );
            end if;
            continue;
        end if;

        if v_class = '' or length(v_class) > 40 then
            v_invalid := v_invalid + 1;
            if jsonb_array_length(v_errors) < 50 then
                v_errors := v_errors || jsonb_build_object(
                    'row', v_index, 'nit', v_nit, 'message', 'Kelas wajib diisi (maksimal 40 karakter).'
                );
            end if;
            continue;
        end if;

        if v_nit !~ '^[A-Z0-9._-]{4,20}$' then
            v_invalid := v_invalid + 1;
            if jsonb_array_length(v_errors) < 50 then
                v_errors := v_errors || jsonb_build_object(
                    'row', v_index, 'nit', v_nit, 'message', 'NIT tidak valid (4–20 karakter huruf/angka/titik/strip).'
                );
            end if;
            continue;
        end if;

        if v_nit = any(v_seen) then
            v_skipped := v_skipped + 1;
            if jsonb_array_length(v_errors) < 50 then
                v_errors := v_errors || jsonb_build_object(
                    'row', v_index, 'nit', v_nit, 'message', 'NIT duplikat di dalam file impor.'
                );
            end if;
            continue;
        end if;
        v_seen := array_append(v_seen, v_nit);

        select voter.* into v_voter
        from public.voters as voter
        where voter.nit = v_nit;

        if found then
            if v_voter.voted_at is not null then
                v_skipped := v_skipped + 1;
                if jsonb_array_length(v_errors) < 50 then
                    v_errors := v_errors || jsonb_build_object(
                        'row', v_index, 'nit', v_nit, 'message', 'Sudah mencoblos, data tidak diubah.'
                    );
                end if;
            elsif v_voter.name <> v_name or v_voter.class_name <> v_class then
                update public.voters
                set name = v_name, class_name = v_class
                where id = v_voter.id;
                v_updated := v_updated + 1;
            else
                v_skipped := v_skipped + 1;
            end if;
        else
            insert into public.voters (name, class_name, nit)
            values (v_name, v_class, v_nit);
            v_added := v_added + 1;
        end if;
    end loop;

    return jsonb_build_object(
        'added', v_added,
        'updated', v_updated,
        'skipped', v_skipped,
        'invalid', v_invalid,
        'errors', v_errors
    );
end;
$$;

create or replace function public.delete_voter(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_voted_at timestamptz;
begin
    select voted_at into v_voted_at
    from public.voters
    where id = p_id
    for update;

    if not found then
        raise exception 'VOTER_NOT_FOUND';
    end if;

    if v_voted_at is not null then
        raise exception 'VOTER_HAS_VOTED';
    end if;

    delete from public.voters where id = p_id;
end;
$$;

-- =========================================================
-- RLS & HAK AKSES
-- =========================================================

alter table public.settings enable row level security;
alter table public.candidates enable row level security;
alter table public.candidate_missions enable row level security;
alter table public.voters enable row level security;
alter table public.vote_tallies enable row level security;
alter table public.audit_logs enable row level security;
alter table public.admin_login_attempts enable row level security;

-- Tidak ada policy untuk anon/authenticated: browser tidak bisa akses DB langsung.
-- API memakai service_role yang melewati RLS.

revoke all on function public.cast_vote(uuid, uuid) from public;
revoke all on function public.reset_votes() from public;
revoke all on function public.save_candidate(uuid, integer, text, text, text, text[]) from public;
revoke all on function public.delete_candidate(uuid) from public;
revoke all on function public.resolve_voter(text, text, text) from public;
revoke all on function public.import_voters(jsonb) from public;
revoke all on function public.delete_voter(uuid) from public;

do $$
begin
    if exists (select 1 from pg_roles where rolname = 'anon') then
        execute 'revoke all on all tables in schema public from anon';
        execute 'revoke all on public.candidate_results, public.election_stats from anon';
        execute 'revoke all on all sequences in schema public from anon';
        execute 'revoke all on all functions in schema public from anon';
    end if;

    if exists (select 1 from pg_roles where rolname = 'authenticated') then
        execute 'revoke all on all tables in schema public from authenticated';
        execute 'revoke all on public.candidate_results, public.election_stats from authenticated';
        execute 'revoke all on all sequences in schema public from authenticated';
        execute 'revoke all on all functions in schema public from authenticated';
    end if;

    if exists (select 1 from pg_roles where rolname = 'service_role') then
        execute 'grant usage on schema public to service_role';
        execute 'grant all on all tables in schema public to service_role';
        execute 'grant all on public.candidate_results, public.election_stats to service_role';
        execute 'grant all on all sequences in schema public to service_role';
        execute 'grant execute on all functions in schema public to service_role';

        execute 'grant execute on function public.cast_vote(uuid, uuid) to service_role';
        execute 'grant execute on function public.reset_votes() to service_role';
        execute 'grant execute on function public.save_candidate(uuid, integer, text, text, text, text[]) to service_role';
        execute 'grant execute on function public.delete_candidate(uuid) to service_role';
        execute 'grant execute on function public.resolve_voter(text, text, text) to service_role';
        execute 'grant execute on function public.import_voters(jsonb) to service_role';
        execute 'grant execute on function public.delete_voter(uuid) to service_role';
    end if;
end $$;

-- =========================================================
-- STORAGE BUCKET FOTO KANDIDAT
-- =========================================================

do $$
begin
    if to_regclass('storage.buckets') is not null then
        insert into storage.buckets (id, name, public)
        values ('candidate-photos', 'candidate-photos', true)
        on conflict (id) do update set public = true;
    end if;
end $$;
