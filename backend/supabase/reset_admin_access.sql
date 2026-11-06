-- Reset admin-console access to the previously designated primary admin.
-- This changes only the wallet_admins allowlist; it does not delete user
-- accounts, orders, listings, wallet balances, or transaction history.
begin;

do $$
declare
    default_admin_id text;
begin
    select id
      into default_admin_id
      from public.users
     where lower(trim(email)) = lower('nzungasamuel@gmail.com');

    if default_admin_id is null then
        raise exception 'Cannot reset admin access: user nzungasamuel@gmail.com was not found.';
    end if;

    delete from public.wallet_admins
     where user_id <> default_admin_id;

    insert into public.wallet_admins (user_id, created_at)
    values (default_admin_id, now()::text)
    on conflict (user_id) do nothing;
end $$;

commit;
