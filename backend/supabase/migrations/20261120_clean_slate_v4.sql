-- Explicitly authorized live clean-slate reset (version = 4).
-- Removes all user accounts, admin grants, wallets, orders, chats, sessions, and
-- user-created listings while preserving the 6 demo Kitui produce listings.
-- Guarded by wallet_schema_migrations (version = 4) so it runs strictly once.

do $clean_slate_v4$
begin
    if not exists (select 1 from public.wallet_schema_migrations where version = 4) then
        delete from public.chat_messages;
        delete from public.chat_conversation_states;
        delete from public.chat_conversations;
        delete from public.chat_presence;
        delete from public.wishlist_items;
        delete from public.order_delivery_updates;
        delete from public.order_return_requests;
        delete from public.order_items;
        delete from public.orders;
        delete from public.checkout_requests;
        delete from public.wallet_transactions;
        delete from public.wallet_operations;
        delete from public.wallet_payment_methods;
        delete from public.wallet_accounts;
        delete from public.wallet_admins;
        delete from public.listing_drafts;
        delete from public.user_settings;
        delete from public.password_reset_codes;
        delete from public.pending_signups;
        delete from public.sessions;
        delete from public.listings where farmer_id not like 'demo-%';
        delete from public.users;
        insert into public.wallet_schema_migrations (version, applied_at) values (4, now()::text);
    end if;
end;
$clean_slate_v4$;
