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
| `POST` | `/api/auth/signup` | Create buyer/farmer account |
| `POST` | `/api/auth/login` | Sign in with email or Kenyan phone |
| `POST` | `/api/auth/logout` | Revoke the current session |
| `GET` | `/api/auth/me` | Read the signed-in account |
| `POST` | `/api/auth/password-reset` | Reports that email delivery is not configured |
| `GET`, `PATCH` | `/api/profile` | Read/update profile |
| `GET`, `PUT` | `/api/settings` | Read/save appearance and delete settings |
| `GET` | `/api/listings` | Browse available listings |
| `GET` | `/api/listings?scope=mine` | Read a farmer's listings |
| `POST`, `PATCH`, `DELETE` | `/api/listings[/:id]` | Farmer-owned listing management |
| `GET`, `POST` | `/api/orders` | Read orders or submit an idempotent checkout |
| `PATCH` | `/api/orders/:id/status` | Buyer cancellation and farmer fulfillment updates |
| `DELETE` | `/api/orders/:id` | Hide an order and restock eligible cancellations |

Mobile money and bank choices are explicitly demo-only. Orders are stored and stock is reserved, but no payment is initiated or verified. Password reset is unavailable until an email provider is configured.

Accounts previously stored only in browser local storage are not imported automatically. Create a new account through the server-backed sign-up page; passwords and legacy browser hashes are not transferred.

Run API tests with `npm.cmd test`.
