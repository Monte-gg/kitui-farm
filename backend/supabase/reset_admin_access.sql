-- Remove every current admin-console grant to prepare for fresh admin sign-ups.
-- This only clears the access allowlist. It does not delete user accounts or
-- other application data.
delete from public.wallet_admins;
