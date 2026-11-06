-- Kitui Farm Enterprise - Supabase (Postgres) schema
-- Run this in the Supabase SQL editor (Dashboard -> SQL -> New query) or via `supabase db push`.
--
-- This mirrors the tables created by backend/server.js for node:sqlite so the API can keep
-- the same field names. Types follow PostgREST rules:
--   * money columns use double precision, not numeric, so the API receives JS numbers
--     (numeric is serialised as a string over PostgREST and would break totals)
--   * settings_json stays TEXT because the server stores and parses it as a JSON string
--   * expires_at stays BIGINT milliseconds to match Date.now() comparisons in the API
--
-- Row level security is enabled with no policies. This database is reached only by the API
-- server using its secret key (which bypasses RLS), so browser clients must never query it.

create table if not exists users (
    id text primary key,
    name text not null,
    email text not null,
    phone text not null unique,
    role text not null check (role in ('buyer', 'farmer')),
    password_salt text not null,
    password_hash text not null,
    location text not null default '',
    profile_photo text not null default '',
    gender text not null default '',
    created_at text not null
);

alter table users add column if not exists profile_photo text not null default '';
alter table users add column if not exists gender text not null default '';

create unique index if not exists idx_users_email_lower on users (lower(email));

create table if not exists sessions (
    token_hash text primary key,
    user_id text not null references users (id) on delete cascade,
    expires_at bigint not null
);

create index if not exists idx_sessions_expiry on sessions (expires_at);

create table if not exists pending_signups (
    email text primary key,
    name text not null,
    phone text not null unique,
    role text not null check (role in ('buyer', 'farmer')),
    password_salt text not null,
    password_hash text not null,
    remember integer not null default 0,
    token_hash text not null unique,
    expires_at bigint not null,
    created_at text not null
);

create index if not exists idx_pending_signups_expiry on pending_signups (expires_at);

create table if not exists password_reset_codes (
    user_id text primary key references users (id) on delete cascade,
    code_salt text not null,
    code_hash text not null,
    attempts integer not null default 0,
    expires_at bigint not null,
    created_at text not null
);

create table if not exists listings (
    id text primary key,
    farmer_id text not null,
    seller_name text not null,
    name text not null,
    category text not null,
    quantity integer not null check (quantity >= 0),
    minimum_order integer not null check (minimum_order > 0),
    price double precision not null check (price > 0),
    location text not null,
    image text not null default '',
    created_at text not null
);

create index if not exists idx_listings_farmer on listings (farmer_id);

create table if not exists checkout_requests (
    checkout_key text primary key,
    buyer_id text not null references users (id),
    payload_hash text not null,
    created_at text not null
);

create table if not exists orders (
    id text primary key,
    buyer_id text not null,
    buyer_name text not null,
    address text not null,
    payment_method text not null,
    status text not null,
    buyer_hidden boolean not null default false,
    checkout_key text not null references checkout_requests (checkout_key),
    total double precision not null,
    created_at text not null
);

create index if not exists idx_orders_buyer on orders (buyer_id);
create index if not exists idx_orders_checkout on orders (checkout_key);

create table if not exists order_items (
    id bigserial primary key,
    order_id text not null references orders (id) on delete cascade,
    product_id text not null,
    farmer_id text not null,
    name text not null,
    seller_name text not null,
    location text not null,
    quantity integer not null check (quantity > 0),
    price double precision not null check (price > 0)
);

create index if not exists idx_order_items_farmer on order_items (farmer_id);
create index if not exists idx_order_items_order on order_items (order_id);

create table if not exists user_settings (
    user_id text primary key references users (id) on delete cascade,
    settings_json text not null
);

create table if not exists chat_conversations (
    id text primary key,
    buyer_id text not null references users(id) on delete cascade,
    farmer_id text not null references users(id) on delete cascade,
    listing_id text,
    created_at text not null,
    last_message_at text not null,
    unique (buyer_id, farmer_id, listing_id)
);

create table if not exists chat_messages (
    id text primary key,
    conversation_id text not null references chat_conversations(id) on delete cascade,
    sender_id text not null references users(id) on delete cascade,
    body text not null,
    created_at text not null,
    attachment_json text not null default '[]',
    pinned integer not null default 0,
    read_at text,
    deleted_for text not null default '[]',
    deleted_at text,
    forwarded_from text
);

create table if not exists chat_conversation_states (
    conversation_id text not null references chat_conversations(id) on delete cascade,
    user_id text not null references users(id) on delete cascade,
    cleared_at text,
    deleted_at text,
    primary key (conversation_id, user_id)
);

create index if not exists idx_chat_conversations_buyer on chat_conversations(buyer_id, last_message_at);
create index if not exists idx_chat_conversations_farmer on chat_conversations(farmer_id, last_message_at);
create index if not exists idx_chat_messages_conversation on chat_messages(conversation_id, created_at);
create index if not exists idx_chat_messages_unread on chat_messages(conversation_id, sender_id, read_at);
create index if not exists idx_chat_conversation_states_user on chat_conversation_states(user_id, deleted_at);

create table if not exists wallet_accounts (
    user_id text primary key references users (id) on delete cascade,
    wallet_id text not null unique,
    balance_cents integer not null default 0 check (balance_cents >= 0),
    currency text not null default 'KES',
    status text not null default 'active' check (status in ('active', 'closed')),
    created_at text not null,
    updated_at text not null
);

create table if not exists wallet_transactions (
    id text primary key,
    user_id text not null references users (id) on delete cascade,
    kind text not null check (kind in ('credit', 'debit')),
    event_type text not null default 'adjustment',
    amount_cents integer not null check (amount_cents > 0),
    reference_key text not null unique,
    payment_reference text,
    description text not null,
    created_by text references users (id),
    created_at text not null,
    status text not null default 'completed',
    channel text not null default 'internal',
    counterparty_wallet_id text,
    operation_id text
);

create index if not exists idx_wallet_transactions_user on wallet_transactions (user_id, created_at);

create table if not exists wallet_operations (
    id text primary key,
    user_id text not null references users (id) on delete cascade,
    kind text not null check (kind in ('deposit', 'withdrawal', 'transfer')),
    amount_cents integer not null check (amount_cents > 0),
    fee_cents integer not null default 0 check (fee_cents >= 0),
    currency text not null default 'KES',
    channel text not null,
    details_json text not null default '{}',
    payment_reference text,
    status text not null check (status in ('pending', 'processing', 'completed', 'rejected', 'failed')),
    peer_user_id text references users (id) on delete set null,
    peer_wallet_id text,
    idempotency_key text unique,
    reviewed_by text references users (id),
    reviewed_at text,
    created_at text not null,
    updated_at text not null
);

create index if not exists idx_wallet_operations_user on wallet_operations (user_id, created_at);
create index if not exists idx_wallet_operations_status on wallet_operations (status, created_at);
create unique index if not exists idx_wallet_operations_payment_reference on wallet_operations (payment_reference) where payment_reference is not null;
create table if not exists wallet_schema_migrations (version integer primary key, applied_at text not null);

create table if not exists wallet_admins (
    user_id text primary key references users (id) on delete cascade,
    created_at text not null
);

alter table users enable row level security;
alter table sessions enable row level security;
alter table pending_signups enable row level security;
alter table password_reset_codes enable row level security;
alter table listings enable row level security;
alter table checkout_requests enable row level security;
alter table orders enable row level security;
alter table order_items enable row level security;
alter table user_settings enable row level security;
alter table chat_conversations enable row level security;
alter table chat_messages enable row level security;
alter table chat_conversation_states enable row level security;
alter table wallet_accounts enable row level security;
alter table wallet_transactions enable row level security;
alter table wallet_operations enable row level security;
alter table wallet_schema_migrations enable row level security;
alter table wallet_admins enable row level security;

-- Demo listings, matching seedListings() in backend/server.js.
insert into listings (id, farmer_id, seller_name, name, category, quantity, minimum_order, price, location, image, created_at)
values
    ('demo-ndengu', 'demo-demo-ndengu', 'Samuel Mutua', 'Green Grams (Ndengu)', 'Grains & Pulses', 420, 10, 180, 'Mutomo, Kitui South', '', now()::text),
    ('demo-mangoes', 'demo-demo-mangoes', 'Grace Nduku', 'Ripe Mangoes', 'Fruits', 160, 5, 90, 'Kitui Central', '', now()::text),
    ('demo-watermelon', 'demo-demo-watermelon', 'Peter Muli', 'Watermelon', 'Fruits', 700, 100, 55, 'Mwingi', '', now()::text),
    ('demo-cassava', 'demo-demo-cassava', 'Mary Kilonzo', 'Fresh Cassava', 'Roots & Tubers', 250, 20, 75, 'Mutomo', '', now()::text),
    ('demo-tomatoes', 'demo-demo-tomatoes', 'David Musau', 'Garden Tomatoes', 'Vegetables', 85, 5, 110, 'Kitui Central', '', now()::text),
    ('demo-beans', 'demo-demo-beans', 'Lilian Wambua', 'Rose Coco Beans', 'Grains & Pulses', 300, 100, 210, 'Mwingi North', '', now()::text)
on conflict (id) do nothing;
