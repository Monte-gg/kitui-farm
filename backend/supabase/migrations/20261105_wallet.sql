create table if not exists public.wallet_accounts (
    user_id text primary key references public.users (id) on delete cascade,
    balance_cents integer not null default 0 check (balance_cents >= 0),
    updated_at text not null
);

create table if not exists public.wallet_transactions (
    id text primary key,
    user_id text not null references public.users (id) on delete cascade,
    kind text not null check (kind in ('credit', 'debit')),
    amount_cents integer not null check (amount_cents > 0),
    reference_key text not null unique,
    payment_reference text,
    description text not null,
    created_by text references public.users (id),
    created_at text not null
);
create index if not exists idx_wallet_transactions_user
    on public.wallet_transactions (user_id, created_at);

create table if not exists public.wallet_topup_requests (
    id text primary key,
    buyer_id text not null references public.users (id) on delete cascade,
    amount_cents integer not null check (amount_cents > 0),
    payment_reference text not null unique,
    status text not null check (status in ('pending', 'approved', 'rejected')),
    reviewed_by text references public.users (id),
    reviewed_at text,
    created_at text not null
);
create index if not exists idx_wallet_topup_requests_status
    on public.wallet_topup_requests (status, created_at);

create table if not exists public.wallet_admins (
    user_id text primary key references public.users (id) on delete cascade,
    created_at text not null
);

alter table public.wallet_accounts enable row level security;
alter table public.wallet_transactions enable row level security;
alter table public.wallet_topup_requests enable row level security;
alter table public.wallet_admins enable row level security;
