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
| `POST` | `/api/auth/password-reset` | Reports that email delivery is not configured |
| `GET`, `PATCH` | `/api/profile` | Read/update profile |
| `GET`, `PUT` | `/api/settings` | Read/save appearance and delete settings |
| `GET` | `/api/wallet` | Read wallet balance, transactions, and top-up requests |
| `POST` | `/api/wallet/topups` | Submit a manual top-up for administrator verification |
| `GET` | `/api/wallet/admin/topups` | List pending top-ups for an authorized wallet administrator |
| `POST` | `/api/wallet/admin/topups/:id/review` | Approve or reject a top-up request |
| `GET` | `/api/listings` | Browse available listings |
| `GET` | `/api/listings?scope=mine` | Read a farmer's listings |
| `POST`, `PATCH`, `DELETE` | `/api/listings[/:id]` | Farmer-owned listing management |
| `GET`, `POST` | `/api/orders` | Read orders or submit an idempotent checkout |
| `PATCH` | `/api/orders/:id/status` | Buyer cancellation and farmer fulfillment updates |
| `DELETE` | `/api/orders/:id` | Hide an order and restock eligible cancellations |

M-PESA, Airtel Money, and bank choices at checkout remain demo-only. Wallet payments debit a KES balance saved in the database. Customers request manual top-ups with their M-PESA receipt; an authorized administrator must verify the receipt before crediting the wallet. No mobile-money payment is initiated by the website. Signup verification uses the Gmail API over HTTPS; password reset remains unavailable until its email flow is implemented.

Accounts previously stored only in browser local storage are not imported automatically. Create a new account through the server-backed sign-up page; passwords and legacy browser hashes are not transferred.

Run API tests with `npm.cmd test`.

## Database: SQLite locally, Supabase in production

The API picks its engine at startup:

- `DATABASE_URL` set: Supabase Postgres, through the `pg` driver
- otherwise: the local SQLite file (`DB_PATH`, default `backend/data/kitui-farm.sqlite`)

Tests always use in-memory SQLite, so `npm test` needs no credentials. Both engines run the same queries through one async store, and `?` placeholders are converted to `$1..$n` for Postgres.

### Set up Supabase

1. Create a project at [supabase.com](https://supabase.com).
2. In the SQL Editor, open a new query, paste `backend/supabase/schema.sql` and run it. It creates every table and index, seeds the demo listings, and enables row level security.
3. In Project Settings, Database, Connection string, copy the URI into `backend/.env` as `DATABASE_URL=postgresql://...` (start from `backend/.env.example`). Replace `[YOUR-PASSWORD]` with the database password.
4. Run `npm.cmd start`. Accounts, listings, orders, and wallet balances now live in Supabase. The backend creates the wallet tables and adds profile columns automatically when it starts with `DATABASE_URL`.

To designate an administrator for manual wallet top-ups, insert the already-registered account into `wallet_admins` in the SQL Editor:

```sql
insert into public.wallet_admins (user_id, created_at)
select id, now()::text from public.users where lower(email) = lower('ADMIN_GMAIL_ADDRESS')
on conflict (user_id) do nothing;
```

Only administrators in this table can approve credits. Confirm each payment outside the website before approving it in `wallet-admin.html`.

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
