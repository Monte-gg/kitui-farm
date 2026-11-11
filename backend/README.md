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
| `POST` | `/api/wallet/mpesa/deposits/stk` | Start a Safaricom Daraja STK Push wallet deposit |
| `GET` | `/api/wallet/mpesa/deposits/:id` | Poll one STK deposit; asks Daraja for the result when the callback is delayed |
| `GET` | `/api/wallet/mpesa/config` | Report whether Daraja STK deposits are configured (never returns credentials) |
| `GET` | `/api/wallet/daraja/config` | Report the Daraja environment and whether B2C payouts are configured |
| `POST` | `/api/payments/mpesa/callback/:token` | Receive Safaricom STK Push results and credit the wallet |
| `POST` | `/api/wallet/paystack/deposits/bank-transfer` | Create a temporary Paystack Pesalink account for a KES wallet deposit |
| `POST` | `/api/paystack/webhook` | Verify Paystack bank-transfer notifications and credit confirmed deposits |
| `POST` | `/api/wallet/withdrawals` | Atomically reserve funds and pay out to M-Pesa (automatic with `DARAJA_AUTO_PAYOUT`, otherwise admin-approved) |
| `POST` | `/api/wallet/admin/operations/:id/daraja-payout` | Start an administrator-authorized Daraja B2C payout in the configured environment |
| `POST` | `/api/v1/payments/b2c-callback?token=…` | Process Safaricom B2C success/failure results idempotently |
| `POST` | `/api/v1/payments/b2c-timeout?token=…` | Record an uncertain B2C timeout; reserved funds remain held pending verification |
| `POST` | `/api/wallet/close` | Close a zero-balance wallet with no pending operations after password confirmation |
| `GET` | `/api/wallet/admin/operations` | List pending deposits and withdrawal requests for authorized administrators |
| `POST` | `/api/wallet/admin/operations/:id/review` | Reject/refund withdrawals or close unverified deposit requests |
| `GET` | `/api/listings` | Browse available listings |
| `GET` | `/api/listings?scope=mine` | Read a farmer's listings |
| `POST`, `PATCH`, `DELETE` | `/api/listings[/:id]` | Farmer-owned listing management |
| `GET`, `POST` | `/api/orders` | Read orders or submit an idempotent checkout |
| `PATCH` | `/api/orders/:id/status` | Buyer cancellation and farmer fulfillment updates |
| `DELETE` | `/api/orders/:id` | Hide an order and restock eligible cancellations |

Wallet deposits and withdrawals run on Safaricom Daraja. A deposit calls Daraja STK Push (`/mpesa/stkpush/v1/processrequest`) for the phone number the customer types; Safaricom sends the prompt, and the wallet is credited only after the signed callback confirms the amount, receipt, and paying phone. If the callback is delayed, the wallet page polls `GET /api/wallet/mpesa/deposits/:id`, which asks Daraja for the result (`/mpesa/stkpushquery/v1/query`) and records a cancelled or failed prompt without touching the balance. A withdrawal reserves the amount from the balance immediately and then pays it out through Daraja B2C; with `DARAJA_AUTO_PAYOUT=true` the payout starts as soon as the customer requests it, otherwise it waits for an administrator in the admin console. The backend creates unique alphanumeric `OriginatorConversationID` values shorter than 20 characters and dynamically sends callbacks to `https://<render-service>/api/v1/payments/b2c-callback?token=…` and `/api/v1/payments/b2c-timeout?token=…`. Final success/failure callbacks update the operation and ledger atomically; a definitive production failure refunds the reserved amount, while a production success leaves it debited. Sandbox callbacks always return the reserved amount because sandbox sends no real funds. A queue timeout is not proof of payout failure, so the operation stays processing/reserved until an admin verifies the outcome in Safaricom before refunding or retrying. `DARAJA_ENV=production` requires Safaricom to approve live B2C access and the live shortcode/credentials. Paystack remains available only for legacy bank-transfer deposits. The backend uses the existing `DATABASE_URL` Supabase Postgres connection and server-validated admin session for atomic wallet updates; no public RPC or schema migration is required. The wallet page listens to an authenticated server-sent event stream and refreshes its balance, operation, and ledger after a change. It checks the Supabase-backed database every 2.5 seconds because user sessions belong to the Kitui Farm API rather than Supabase Auth; direct browser subscriptions would not have a secure Supabase user JWT and row-ownership policy to rely on. Airtel Money and PayPal are not available for new wallet methods; historical records remain visible. Wallet-to-wallet transfers and marketplace wallet payments are ledger-backed database transactions. The wallet v2 migration deliberately deletes old wallet balances, ledger rows, and top-up requests once while preserving the `wallet_admins` allowlist. Signup verification, welcome email, password reset codes, and password-change notifications use the Gmail API over HTTPS. Reset codes expire after 10 minutes and are limited to five attempts; successful resets revoke existing sessions.

### Daraja STK Push settings in Render

1. Open **Render Dashboard → Kitui Farm → Environment**.
2. Add `MPESA_ENV` (`sandbox` while testing, `live` for real money), `MPESA_CONSUMER_KEY`, `MPESA_CONSUMER_SECRET`, `MPESA_SHORTCODE`, and `MPESA_PASSKEY` from the Daraja app you registered for STK Push.
3. Add `MPESA_CALLBACK_SECRET` as a newly generated random value with at least 32 characters. Safaricom calls `https://<your-render-host>/api/payments/mpesa/callback/<MPESA_CALLBACK_SECRET>`; the app sends that URL with every prompt, so a wrong secret only means callbacks are rejected.
4. Leave `MPESA_CALLBACK_BASE_URL` empty on Render: the app falls back to Render's `RENDER_EXTERNAL_URL`. Set it locally only if you expose the server through a public HTTPS tunnel.
5. `MPESA_TRANSACTION_TYPE` is `CustomerPayBillOnline` by default. Use `CustomerBuyGoodsOnline` only for a Buy Goods (Till) shortcode.
6. Save and redeploy. The wallet page reads `GET /api/wallet/mpesa/config`; until all values are present, deposits stay disabled with a message instead of failing halfway through a payment.

### Daraja B2C settings in Render

1. Open **Render Dashboard → Kitui Farm → Environment**.
2. Add `DARAJA_ENV` with `sandbox` while using test credentials. Change it to `production` only after Safaricom enables live B2C payouts for the shortcode and you have production credentials.
3. Add `DARAJA_CONSUMER_KEY`, `DARAJA_CONSUMER_SECRET`, `DARAJA_INITIATOR_NAME`, `DARAJA_SECURITY_CREDENTIAL`, and `DARAJA_SHORTCODE` from the matching Daraja app/organization environment.
4. Add `DARAJA_CALLBACK_SECRET` as a newly generated random value with at least 32 characters. Keep it private. Do not paste keys or the security credential into GitHub or chat.
5. Save and redeploy. Render automatically provides `RENDER_EXTERNAL_URL`; the app uses it to create both HTTPS callbacks. Do not use the GitHub Pages URL for Daraja callbacks.
6. In Daraja, register the callback URLs if the portal asks for them: `https://<your-render-host>/api/v1/payments/b2c-callback?token=<your-callback-secret>` and `https://<your-render-host>/api/v1/payments/b2c-timeout?token=<your-callback-secret>`. The app sends these URLs in each B2C request.
7. Keep the existing `MPESA_*` STK variables for deposits. Remove obsolete `MPESA_B2C_*` variables from Render after the new deployment; they are no longer read for withdrawals.

In sandbox, callbacks simulate the result and the reserved amount is returned because no real payout occurs. In production, a confirmed success completes the withdrawal and a confirmed failure refunds it. A timeout is ambiguous: the amount remains reserved until Safaricom confirms whether it paid, preventing accidental duplicate payouts.

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

Only administrators in this table can approve wallet operations. Daraja M-Pesa STK deposits are credited automatically only after Safaricom confirms the payment. Withdrawals are paid through Daraja B2C by an administrator, or automatically when `DARAJA_AUTO_PAYOUT=true`.

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
