-- One-time wallet replacement requested by the project owner. This clears old
-- wallet balances, ledger rows, and manual top-up requests while preserving
-- wallet_admins, which controls access to the admin console.
create table if not exists public.wallet_schema_migrations (
    version integer primary key,
    applied_at text not null
);

alter table public.wallet_accounts add column if not exists wallet_id text;
alter table public.wallet_accounts add column if not exists currency text not null default 'KES';
alter table public.wallet_accounts add column if not exists status text not null default 'active';
alter table public.wallet_accounts add column if not exists created_at text not null default '';

alter table public.wallet_transactions add column if not exists event_type text not null default 'adjustment';
alter table public.wallet_transactions add column if not exists status text not null default 'completed';
alter table public.wallet_transactions add column if not exists channel text not null default 'internal';
alter table public.wallet_transactions add column if not exists counterparty_wallet_id text;
alter table public.wallet_transactions add column if not exists operation_id text;

create table if not exists public.wallet_operations (
    id text primary key,
    user_id text not null references public.users (id) on delete cascade,
    kind text not null check (kind in ('deposit', 'withdrawal', 'transfer')),
    amount_cents integer not null check (amount_cents > 0),
    fee_cents integer not null default 0 check (fee_cents >= 0),
    currency text not null default 'KES',
    channel text not null,
    details_json text not null default '{}',
    payment_reference text,
    status text not null check (status in ('pending', 'processing', 'completed', 'rejected', 'failed')),
    peer_user_id text references public.users (id) on delete set null,
    peer_wallet_id text,
    idempotency_key text unique,
    reviewed_by text references public.users (id),
    reviewed_at text,
    created_at text not null,
    updated_at text not null
);

do $wallet_system_v2$
begin
    if not exists (select 1 from public.wallet_schema_migrations where version = 2) then
        delete from public.wallet_transactions;
        delete from public.wallet_operations;
        delete from public.wallet_accounts;
        drop table if exists public.wallet_topup_requests;
        insert into public.wallet_schema_migrations (version, applied_at) values (2, now()::text);
    end if;
end;
$wallet_system_v2$;

alter table public.wallet_accounts alter column wallet_id set not null;
alter table public.wallet_accounts alter column status set default 'active';
alter table public.wallet_accounts drop constraint if exists wallet_accounts_status_check;
alter table public.wallet_accounts add constraint wallet_accounts_status_check check (status in ('active', 'closed'));

create unique index if not exists idx_wallet_accounts_wallet_id on public.wallet_accounts (wallet_id);
create index if not exists idx_wallet_transactions_user on public.wallet_transactions (user_id, created_at);
create index if not exists idx_wallet_operations_user on public.wallet_operations (user_id, created_at);
create index if not exists idx_wallet_operations_status on public.wallet_operations (status, created_at);
create unique index if not exists idx_wallet_operations_payment_reference
    on public.wallet_operations (payment_reference) where payment_reference is not null;

alter table public.wallet_accounts enable row level security;
alter table public.wallet_transactions enable row level security;
alter table public.wallet_operations enable row level security;
alter table public.wallet_schema_migrations enable row level security;
