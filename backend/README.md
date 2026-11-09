# Kitui Farm backend

This local MVP serves the existing HTML app and a same-origin JSON API. Node.js 22.13 or newer is required for the built-in SQLite driver.

## Run locally

```powershell
Set-Location .\backend
npm.cmd install
npm.cmd start
```

Open `http://127.0.0.1:3000`. SQLite data is stored in `backend/data/kitui-farm.sqlite`; set `DB_PATH` to use another file and `PORT` to change the port. The server binds to loopback for local development.

## API

All protected routes use the HTTP-only `kitui_farm_session` cookie created by signup/login. The API accepts only same-origin browser requests and validates access by account role and ownership.

| Method | Route | Purpose |
| --- | --- | --- |
| `GET` | `/api/health` | Health check |
| `POST` | `/api/auth/signup` | Send an email verification link for a buyer/farmer account |
| `POST` | `/api/auth/resend-verification` | Resend an unexpired signup verification link |
| `POST` | `/api/auth/verify-email` | Verify the one-time signup token and create the account/session |
| `POST` | `/api/auth/login` | Sign in with email or Kenyan phone |
| `POST` | `/api/auth/logout` | Revoke the current session |
| `GET` | `/api/auth/me` | Read the signed-in account |
| `POST` | `/api/auth/password-reset` | Email a one-time password reset code when the account exists |
| `POST` | `/api/auth/password-reset/confirm` | Verify the reset code, set a new password, and revoke existing sessions |
| `GET`, `PATCH` | `/api/profile` | Read/update profile |
| `GET`, `PUT` | `/api/settings` | Read/save appearance and delete settings |
| `GET` | `/api/wallet` | Initialize/read wallet identity, balance, ledger history, and deposit/withdrawal requests |
| `GET` | `/api/wallet/events` | Authenticated server-sent events for wallet balance and transaction changes |
| `GET` | `/api/wallet/recipient?identifier=...` | Resolve another user’s wallet ID, Kenyan phone, or exact name before transfer |
| `POST` | `/api/wallet/transfers` | Make an atomic, idempotent wallet-to-wallet transfer |
| `POST` | `/api/wallet/deposits` | Submit a bank-transfer or manual M-Pesa receipt for verification |
| `POST` | `/api/wallet/mpesa/deposits/stk` | Start a Paystack M-Pesa STK wallet deposit |
| `POST` | `/api/payments/mpesa/callback/:token` | Receive legacy Daraja STK Push results |
| `POST` | `/api/wallet/paystack/deposits/bank-transfer` | Create a temporary Paystack Pesalink account for a KES wallet deposit |
| `POST` | `/api/paystack/webhook` | Verify Paystack bank-transfer notifications and credit confirmed deposits |
| `POST` | `/api/wallet/withdrawals` | Atomically reserve funds and queue a M-Pesa withdrawal request for an administrator |
| `POST` | `/api/wallet/admin/operations/:id/daraja-payout` | Start an administrator-authorized Daraja B2C sandbox payout |
| `POST` | `/api/payments/mpesa/b2c/result/:token` | Receive Daraja sandbox B2C result and safely return reserved test funds |
| `POST` | `/api/payments/mpesa/b2c/timeout/:token` | Record a Daraja sandbox B2C timeout for manual status verification |
| `POST` | `/api/wallet/close` | Close a zero-balance wallet with no pending operations after password confirmation |
| `GET` | `/api/wallet/admin/operations` | List pending deposits and withdrawal requests for authorized administrators |
| `POST` | `/api/wallet/admin/operations/:id/review` | Reject/refund withdrawals or close unverified deposit requests |
| `GET` | `/api/listings` | Browse available listings |
| `GET` | `/api/listings?scope=mine` | Read a farmer's listings |
| `POST`, `PATCH`, `DELETE` | `/api/listings[/:id]` | Farmer-owned listing management |
| `GET`, `POST` | `/api/orders` | Read orders or submit an idempotent checkout |
| `PATCH` | `/api/orders/:id/status` | Buyer cancellation and farmer fulfillment updates |
| `DELETE` | `/api/orders/:id` | Hide an order and restock eligible cancellations |

M-Pesa wallet deposits use Paystack M-Pesa STK when `PAYSTACK_SECRET_KEY` and the Paystack webhook signing secret are configured. The wallet is credited only after a signed Paystack `charge.success` event is confirmed with Paystack's transaction verification API. Set the Paystack webhook URL to `https://kitui-farm.onrender.com/api/paystack/webhook`. Live Pesalink deposits remain disabled until Paystack confirms merchant eligibility and the corresponding server-side eligibility settings are enabled. Withdrawals use the Daraja B2C sandbox only: set `MPESA_ENV=sandbox`, `MPESA_B2C_ENABLED=true`, and configure the existing `MPESA_CONSUMER_KEY`, `MPESA_CONSUMER_SECRET`, `MPESA_B2C_INITIATOR_NAME`, `MPESA_B2C_SECURITY_CREDENTIAL`, `MPESA_B2C_PARTY_A`, `MPESA_B2C_COMMAND_ID`, `MPESA_CALLBACK_SECRET`, and `MPESA_CALLBACK_BASE_URL` values in Render. An authorized administrator starts a sandbox request from the admin panel. Each request includes a unique alphanumeric `OriginatorConversationID` shorter than 20 characters as required by Safaricom. Daraja calls `https://sandbox.safaricom.co.ke/mpesa/b2c/v3/paymentrequest` and posts to `/api/payments/mpesa/b2c/result/:token` or `/api/payments/mpesa/b2c/timeout/:token`. The wallet amount remains reserved until a result arrives; because sandbox never moves real money, the backend returns the reserved amount on either final callback and records that it was simulated. A timed-out or uncertain request stays reserved and cannot be retried until its status is checked. Do not treat sandbox callbacks as real payouts or switch this code to live mode without building and reviewing a separate production payout configuration. Paystack is deposit-only. The backend uses the existing `DATABASE_URL` Supabase Postgres connection and server-validated admin session for atomic wallet updates; no public RPC or schema migration is required. The wallet page listens to an authenticated server-sent event stream and refreshes its balance, operation, and ledger after a change. It checks the Supabase-backed database every 2.5 seconds because user sessions belong to the Kitui Farm API rather than Supabase Auth; direct browser subscriptions would not have a secure Supabase user JWT and row-ownership policy to rely on. Airtel Money and PayPal are not available for new wallet methods; historical records remain visible. Wallet-to-wallet transfers and marketplace wallet payments are ledger-backed database transactions. The wallet v2 migration deliberately deletes old wallet balances, ledger rows, and top-up requests once while preserving the `wallet_admins` allowlist. Signup verification, welcome email, password reset codes, and password-change notifications use the Gmail API over HTTPS. Reset codes expire after 10 minutes and are limited to five attempts; successful resets revoke existing sessions.

Accounts previously stored only in browser local storage are not imported automatically. Create a new account through the server-backed sign-up page; passwords and legacy browser hashes are not transferred.

Run API tests with `npm.cmd test`.

## Database: SQLite locally, Supabase in production

The API picks its engine at startup:

- `DATABASE_URL` set: Supabase Postgres, through the `pg` driver
- otherwise: the local SQLite file (`DB_PATH`, default `backend/data/kitui-farm.sqlite`)

Tests always use in-memory SQLite, so `npm test` needs no credentials. Both engines run the same queries through one async store, and `?` placeholders are converted to `$1..$n` for Postgres.

### Set up Supabase

1. Create a project at [supabase.com](https://supabase.com).
2. In the SQL Editor, open a new query, paste `backend/supabase/schema.sql` and run it. It creates every table and index, seeds the demo listings, and enables row level security. For an existing installation, also apply the newest file in `backend/supabase/migrations/`; wallet v2 intentionally clears prior balances, ledger entries, and deposit requests once.
3. In Project Settings, Database, Connection string, copy the URI into `backend/.env` as `DATABASE_URL=postgresql://...` (start from `backend/.env.example`). Replace `[YOUR-PASSWORD]` with the database password.
4. Run `npm.cmd start`. Accounts, listings, orders, and wallet balances now live in Supabase. The backend applies the one-time wallet v2 reset and creates/updates wallet tables automatically when it starts with `DATABASE_URL`.

To designate an administrator for wallet deposit and withdrawal approvals, insert the already-registered account into `wallet_admins` in the SQL Editor:

```sql
insert into public.wallet_admins (user_id, created_at)
select id, now()::text from public.users where lower(email) = lower('ADMIN_GMAIL_ADDRESS')
on conflict (user_id) do nothing;
```

To clear all current admin-console access and start fresh, run `backend/supabase/reset_admin_access.sql` in the Supabase SQL Editor. It deletes all rows from the admin allowlist but preserves user accounts and other application data. It succeeds even if the allowlist is already empty.

Admin sign-up is available from the admin sign-in page. Enter the 4-digit registration gate code (`0987` by default; set `ADMIN_REGISTRATION_CODE` in Render to change it), then create an admin account with a name, Gmail address, and password. The gate grant expires in 10 minutes and failed code attempts are rate-limited. Admin sign-in checks the name without regard to capitalization and verifies the email and password; it does not use the normal user sign-in flow.

Only administrators in this table can approve wallet operations. Confirm manual deposits outside the website before crediting; Paystack M-Pesa STK deposits are automatically credited only after provider verification. Manual withdrawal requests can be marked as sent in the admin console.

`npm start` and `npm test` load `backend/.env` automatically through Node's `--env-file-if-exists`, so `DATABASE_URL` takes effect without exporting it in the shell. The publishable (`sb_publishable_...`) key is not used by this backend and must not be substituted for `DATABASE_URL`.

The API uses `pg` rather than `@supabase/supabase-js` on purpose: checkout must reserve stock and create orders atomically, and PostgREST cannot run a multi-statement transaction. Keep `DATABASE_URL` on the server only, because it contains the database password and that connection bypasses row level security; no browser code should ever hold it. The publishable/anon key is not used by this app at all.

Free Supabase projects pause after a week without activity, which takes the shop offline until the project is resumed.

## Deploy to Render

`render.yaml` in the repo root defines the service: root directory `backend`, build `npm install`, start `npm start`, health check `/api/health`.

1. In Render choose New, then Blueprint, then this GitHub repo.
2. When prompted for `DATABASE_URL`, paste the Supabase URI.
3. In Google Cloud Console, create/select a project, enable the Gmail API, configure the OAuth consent screen, and create a Web application OAuth client. Add `https://developers.google.com/oauthplayground` as an authorized redirect URI. In OAuth 2.0 Playground settings, enable “Use your own OAuth credentials”; enter the client ID/secret, authorize `https://www.googleapis.com/auth/gmail.send` using the sender Gmail account, exchange the code, and copy the refresh token. Keep the client secret and refresh token private. For continuous use, publish the OAuth app to Production; Google says refresh tokens for external apps left in Testing expire after seven days.
4. In the KITUI FARM service’s Environment settings, add `GMAIL_USER` (the same Gmail account that granted access), `GMAIL_OAUTH_CLIENT_ID`, `GMAIL_OAUTH_CLIENT_SECRET`, `GMAIL_OAUTH_REFRESH_TOKEN`, and `PUBLIC_APP_URL=https://monte-gg.github.io/kitui-farm`. This is the public GitHub Pages URL where the verification page is hosted. Keep OAuth secrets in Render only; never put them in website code or share them in chat.
5. Deploy/restart the service. New signups receive a one-time email link; the account is created only after the user confirms it. A welcome email is sent after successful confirmation. Links expire after 24 hours.

The blueprint sets `HOST=0.0.0.0` and `NODE_ENV=production`; with one proxy hop trusted, the same-origin check and `Secure` cookies keep working behind HTTPS. Locally the server still binds to `127.0.0.1`.

The GitHub Pages copy stays a static preview only: it has no API, so sign-in shows the preview notice.
