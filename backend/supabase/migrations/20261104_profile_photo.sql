alter table public.users
    add column if not exists profile_photo text not null default '';
