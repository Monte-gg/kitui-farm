'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { AsyncLocalStorage } = require('node:async_hooks');
const { DatabaseSync } = require('node:sqlite');
const express = require('express');

const ROOT = path.resolve(__dirname, '..');
const COOKIE = 'kitui_farm_session';
// Static front ends (for example GitHub Pages) are allowed to call this API.
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || 'https://monte-gg.github.io')
    .split(',').map(origin => origin.trim()).filter(Boolean);
const SESSION_MS = 30 * 24 * 60 * 60 * 1000;
const DEFAULT_SETTINGS = { theme: 'system', density: 'comfortable', confirmDeletes: true };
const CATEGORIES = new Set(['Fruits', 'Vegetables', 'Grains & Pulses', 'Roots & Tubers']);
const PAYMENT_METHODS = new Set([
    'KITUI FARM Wallet'
]);
let paypalAccessToken = '';
let paypalAccessTokenExpiresAt = 0;
let mpesaAccessToken = '';
let mpesaAccessTokenExpiresAt = 0;
const PAGES = [
    'about-us.html', 'admin-register.html', 'admin-signin.html', 'buyer-dashboard.html', 'chat.html', 'customer-service.html', 'email-verify.html', 'farmer-dashboard.html', 'farmer-store.html',
    'forgot-password.html', 'index.html', 'login.html', 'payment.html', 'profile.html', 'receipt.html', 'receipts.html',
    'settings.html', 'signup.html', 'wallet.html'
];

function paypalError(message, status) {
    const error = new Error(message);
    error.status = status;
    return error;
}

function paypalConfig({ requireRate = false } = {}) {
    const mode = String(process.env.PAYPAL_MODE || 'sandbox').trim().toLowerCase();
    if (!['sandbox', 'live'].includes(mode)) throw paypalError('PAYPAL_MODE must be set to sandbox or live.', 503);
    const clientId = String(process.env.PAYPAL_CLIENT_ID || '').trim();
    const clientSecret = String(process.env.PAYPAL_CLIENT_SECRET || '').trim();
    const kesToUsdRate = Number(process.env.PAYPAL_KES_TO_USD_RATE);
    if (!clientId || !clientSecret) throw paypalError('PayPal is not configured yet. Add PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET in Render.', 503);
    if (requireRate && (!Number.isFinite(kesToUsdRate) || kesToUsdRate <= 0 || kesToUsdRate > 1000)) {
        throw paypalError('PayPal wallet payments are temporarily unavailable until a valid KES-to-USD rate is configured in Render.', 503);
    }
    return { mode, clientId, clientSecret, kesToUsdRate };
}

function paypalQuote(amountCents, rate) {
    const usdCents = Math.round((amountCents / 100) * rate * 100);
    if (usdCents < 1) throw paypalError('This KES amount is too small for a PayPal payout at the current rate.', 400);
    return { currency: 'USD', amount: (usdCents / 100).toFixed(2), rate };
}

function mpesaConfig() {
    const mode = String(process.env.MPESA_ENV || 'sandbox').trim().toLowerCase();
    if (!['sandbox', 'live'].includes(mode)) throw new Error('MPESA_ENV must be sandbox or live.');
    const consumerKey = String(process.env.MPESA_CONSUMER_KEY || '').trim();
    const consumerSecret = String(process.env.MPESA_CONSUMER_SECRET || '').trim();
    const shortCode = String(process.env.MPESA_SHORTCODE || '').trim();
    const passkey = String(process.env.MPESA_PASSKEY || '').trim();
    const callbackSecret = String(process.env.MPESA_CALLBACK_SECRET || '').trim();
    if (!consumerKey || !consumerSecret || !shortCode || !passkey || callbackSecret.length < 32) {
        const error = new Error('M-Pesa STK Push is not configured. Add the Daraja credentials and a long callback secret in Render.');
        error.status = 503;
        throw error;
    }
    const baseUrl = mode === 'live' ? 'https://api.safaricom.co.ke' : 'https://sandbox.safaricom.co.ke';
    const callbackBase = String(process.env.MPESA_CALLBACK_BASE_URL || process.env.RENDER_EXTERNAL_URL || '').trim();
    if (!callbackBase) {
        const error = new Error('Set RENDER_EXTERNAL_URL or MPESA_CALLBACK_BASE_URL so Daraja can reach the payment callback.');
        error.status = 503;
        throw error;
    }
    let callbackUrl;
    try {
        const parsed = new URL(callbackBase);
        if (parsed.protocol !== 'https:') throw new Error('HTTPS is required.');
        callbackUrl = new URL(`/api/payments/mpesa/callback/${encodeURIComponent(callbackSecret)}`, parsed.origin).toString();
    } catch {
        const error = new Error('MPESA_CALLBACK_BASE_URL must be a valid HTTPS base URL.');
        error.status = 503;
        throw error;
    }
    return { mode, baseUrl, consumerKey, consumerSecret, shortCode, passkey, callbackSecret, callbackUrl,
        transactionType: String(process.env.MPESA_TRANSACTION_TYPE || 'CustomerPayBillOnline').trim() };
}

function mpesaB2CConfig(baseConfig = mpesaConfig()) {
    const enabled = String(process.env.MPESA_B2C_ENABLED || '').trim().toLowerCase() === 'true';
    const initiatorName = String(process.env.MPESA_B2C_INITIATOR_NAME || '').trim();
    const securityCredential = String(process.env.MPESA_B2C_SECURITY_CREDENTIAL || '').trim();
    if (!enabled || !initiatorName || !securityCredential) {
        const error = new Error('Automatic M-Pesa payouts are not configured. The request will be sent to the admin for manual handling.');
        error.status = 503;
        throw error;
    }
    const callbackBase = String(process.env.MPESA_CALLBACK_BASE_URL || process.env.RENDER_EXTERNAL_URL || '').trim();
    const callbackPath = `/api/payments/mpesa/b2c/${encodeURIComponent(baseConfig.callbackSecret)}`;
    return {
        ...baseConfig,
        initiatorName,
        securityCredential,
        commandId: String(process.env.MPESA_B2C_COMMAND_ID || 'BusinessPayment').trim(),
        partyA: String(process.env.MPESA_B2C_PARTY_A || baseConfig.shortCode).trim(),
        resultUrl: new URL(`${callbackPath}/result`, callbackBase).toString(),
        timeoutUrl: new URL(`${callbackPath}/timeout`, callbackBase).toString()
    };
}

async function mpesaRequest(endpoint, { method = 'GET', body, config = mpesaConfig() } = {}) {
    if (!mpesaAccessToken || Date.now() >= mpesaAccessTokenExpiresAt - 60_000) {
        const credentials = Buffer.from(`${config.consumerKey}:${config.consumerSecret}`).toString('base64');
        const response = await fetch(`${config.baseUrl}/oauth/v1/generate?grant_type=client_credentials`, {
            headers: { Authorization: `Basic ${credentials}` }, signal: AbortSignal.timeout(15_000)
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok || !data.access_token) {
            mpesaAccessToken = ''; mpesaAccessTokenExpiresAt = 0;
            const error = new Error('Daraja could not authorize the M-Pesa request. Check the Consumer Key and Consumer Secret in Render.');
            error.status = 502; throw error;
        }
        mpesaAccessToken = data.access_token;
        mpesaAccessTokenExpiresAt = Date.now() + Number(data.expires_in || 3599) * 1000;
    }
    const response = await fetch(`${config.baseUrl}${endpoint}`, {
        method, headers: { Authorization: `Bearer ${mpesaAccessToken}`, 'Content-Type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(20_000)
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
        const error = new Error(String(data.errorMessage || data.error || data.ResponseDescription || 'Daraja could not process the M-Pesa request.'));
        error.status = response.status; error.mpesaData = data; throw error;
    }
    return data;
}

function paystackConfig() {
    const secretKey = String(process.env.PAYSTACK_SECRET_KEY || '').trim();
    const webhookSecret = String(process.env.PAYSTACK_WEBHOOK_SECRET || '').trim();
    const enabled = String(process.env.PAYSTACK_BANK_ENABLED || '').trim().toLowerCase() === 'true';
    if (!enabled || !secretKey) {
        const error = new Error('Paystack Pesalink deposits are not enabled. Configure an approved Paystack account and credentials in Render.');
        error.status = 503; throw error;
    }
    return { secretKey, webhookSecret };
}

function validPaystackWebhookSignature(req, config) {
    const rawBody = req.rawBody || Buffer.alloc(0);
    const signedHeader = String(req.get('Paystack-Signature') || '');
    if (config.webhookSecret && signedHeader) {
        const fields = signedHeader.split(',').map(part => part.trim());
        const timestamp = fields.find(part => part.startsWith('t='))?.slice(2) || '';
        const timestampSeconds = Number(timestamp);
        if (!/^\d+$/.test(timestamp) || !Number.isSafeInteger(timestampSeconds) || Math.abs(Date.now() / 1000 - timestampSeconds) > 300) return false;
        const expected = crypto.createHmac('sha512', config.webhookSecret).update(`${timestamp}.`).update(rawBody).digest();
        return fields.filter(part => part.startsWith('v1=')).some(part => {
            const value = part.slice(3);
            const separator = value.indexOf(':');
            const signature = separator >= 0 ? value.slice(separator + 1) : value;
            if (!/^[a-f0-9]{128}$/i.test(signature)) return false;
            const received = Buffer.from(signature, 'hex');
            return received.length === expected.length && crypto.timingSafeEqual(received, expected);
        });
    }
    // Support existing Paystack integrations that still send the legacy header.
    const legacySignature = String(req.get('x-paystack-signature') || '');
    if (!legacySignature) return false;
    const expected = crypto.createHmac('sha512', config.secretKey).update(rawBody).digest();
    if (!/^[a-f0-9]{128}$/i.test(legacySignature)) return false;
    const received = Buffer.from(legacySignature, 'hex');
    return received.length === expected.length && crypto.timingSafeEqual(received, expected);
}

async function paystackRequest(endpoint, { method = 'GET', body, config = paystackConfig() } = {}) {
    const response = await fetch(`https://api.paystack.co${endpoint}`, {
        method, headers: { Authorization: `Bearer ${config.secretKey}`, 'Content-Type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(20_000)
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.status === false) {
        const error = new Error(String(data.message || 'Paystack could not process the bank transfer request.'));
        error.status = response.status || 502; throw error;
    }
    return data;
}

async function paypalRequest(endpoint, { method = 'GET', body, config = paypalConfig(), requestId } = {}) {
    const origin = config.mode === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com';
    if (!paypalAccessToken || Date.now() >= paypalAccessTokenExpiresAt - 60_000) {
        const tokenResponse = await fetch(`${origin}/v1/oauth2/token`, {
            method: 'POST',
            headers: {
                Authorization: `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64')}`,
                'Content-Type': 'application/x-www-form-urlencoded'
            },
            body: 'grant_type=client_credentials',
            signal: AbortSignal.timeout(15_000)
        });
        const tokenData = await tokenResponse.json().catch(() => ({}));
        if (!tokenResponse.ok || !tokenData.access_token) {
            paypalAccessToken = '';
            paypalAccessTokenExpiresAt = 0;
            throw paypalError('PayPal could not authorize this payout. Check the PayPal API credentials and Payouts access in Render.', 502);
        }
        paypalAccessToken = tokenData.access_token;
        paypalAccessTokenExpiresAt = Date.now() + Number(tokenData.expires_in || 300) * 1000;
    }
    const response = await fetch(`${origin}${endpoint}`, {
        method,
        headers: {
            Authorization: `Bearer ${paypalAccessToken}`,
            'Content-Type': 'application/json',
            ...(method === 'POST' && (requestId || body?.sender_batch_header?.sender_batch_id)
                ? { 'PayPal-Request-Id': requestId || body.sender_batch_header.sender_batch_id } : {})
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(20_000)
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
        const error = new Error(String(data.message || 'PayPal could not process this payout.'));
        error.status = response.status;
        error.paypalData = data;
        throw error;
    }
    return data;
}

async function createOrRecoverPayPalPayout(operation) {
    const details = JSON.parse(operation.details_json || '{}');
    const config = paypalConfig({ requireRate: !details.paypalPayoutAmountUsd });
    const paypalEmail = details.email || details.paypalEmail;
    if (!paypalEmail || !/^\S+@\S+\.\S+$/.test(paypalEmail)) throw paypalError('The saved PayPal payout email is missing or invalid.', 400);
    const quote = details.paypalPayoutAmountUsd
        ? { currency: 'USD', amount: String(details.paypalPayoutAmountUsd), rate: Number(details.paypalKesToUsdRate) }
        : paypalQuote(Number(operation.amount_cents), config.kesToUsdRate);
    const senderBatchId = operation.id;
    try {
        return await paypalRequest('/v1/payments/payouts', {
            method: 'POST', config,
            body: {
                sender_batch_header: {
                    sender_batch_id: senderBatchId,
                    recipient_type: 'EMAIL',
                    email_subject: 'Your KITUI FARM wallet withdrawal',
                    email_message: 'Your KITUI FARM wallet payout has been sent. PayPal may ask you to accept it.'
                },
                items: [{
                    recipient_type: 'EMAIL',
                    amount: { value: quote.amount, currency: quote.currency },
                    receiver: paypalEmail,
                    sender_item_id: operation.id,
                    note: `KITUI FARM wallet withdrawal ${operation.id.slice(0, 8)}`
                }]
            }
        });
    } catch (error) {
        // A timed-out request may have reached PayPal. Reuse the stable batch id;
        // PayPal prevents duplicate payouts and returns a link to the first batch.
        const duplicateLink = error.paypalData?.links?.find(link => /payout/i.test(`${link.rel} ${link.href}`));
        if (!duplicateLink?.href) throw error;
        const match = duplicateLink.href.match(/\/v1\/payments\/payouts\/([^/?]+)/);
        if (!match) throw error;
        return paypalRequest(`/v1/payments/payouts/${encodeURIComponent(match[1])}`, { config });
    }
}

function isDefinitivePayPalRejection(error) {
    if (!error?.status || error.status < 400 || error.status >= 500) return false;
    const description = JSON.stringify(error.paypalData || {}).toLowerCase();
    return !description.includes('duplicate') && !description.includes('sender_batch_id');
}

// ---------------------------------------------------------------------------
// Data stores
//
// Both stores expose the same async surface (all/get/run/exec/transaction/close)
// and take `?` placeholders. SQLite (node:sqlite) is used for local development
// and tests; Supabase Postgres is used when DATABASE_URL is set. All queries go
// through one connection for SQLite, so work is serialised to keep a request
// from interleaving inside another request's transaction.
// ---------------------------------------------------------------------------

const SQLITE_SCHEMA = `
    PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL COLLATE NOCASE UNIQUE,
        phone TEXT NOT NULL UNIQUE, role TEXT NOT NULL CHECK (role IN ('buyer', 'farmer')),
        password_salt TEXT NOT NULL, password_hash TEXT NOT NULL, location TEXT NOT NULL DEFAULT '',
        profile_photo TEXT NOT NULL DEFAULT '', gender TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
        token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS pending_signups (
        email TEXT PRIMARY KEY COLLATE NOCASE,
        name TEXT NOT NULL,
        phone TEXT NOT NULL UNIQUE,
        role TEXT NOT NULL CHECK (role IN ('buyer', 'farmer')),
        password_salt TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        remember INTEGER NOT NULL DEFAULT 0,
        token_hash TEXT NOT NULL UNIQUE,
        expires_at INTEGER NOT NULL,
        created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS password_reset_codes (
        user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        code_salt TEXT NOT NULL,
        code_hash TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        expires_at INTEGER NOT NULL,
        created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS listings (
        id TEXT PRIMARY KEY, farmer_id TEXT NOT NULL, seller_name TEXT NOT NULL, name TEXT NOT NULL,
        category TEXT NOT NULL, quantity INTEGER NOT NULL CHECK (quantity >= 0),
        minimum_order INTEGER NOT NULL CHECK (minimum_order > 0),
        price REAL NOT NULL CHECK (price > 0), location TEXT NOT NULL, image TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS checkout_requests (
        checkout_key TEXT PRIMARY KEY,
        buyer_id TEXT NOT NULL REFERENCES users(id),
        payload_hash TEXT NOT NULL,
        created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS orders (
        id TEXT PRIMARY KEY, buyer_id TEXT NOT NULL REFERENCES users(id), buyer_name TEXT NOT NULL,
        address TEXT NOT NULL, payment_method TEXT NOT NULL, status TEXT NOT NULL,
        buyer_hidden INTEGER NOT NULL DEFAULT 0,
        checkout_key TEXT NOT NULL REFERENCES checkout_requests(checkout_key),
        total REAL NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS order_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT, order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
        product_id TEXT NOT NULL, farmer_id TEXT NOT NULL, name TEXT NOT NULL,
        seller_name TEXT NOT NULL, location TEXT NOT NULL,
        quantity INTEGER NOT NULL CHECK (quantity > 0), price REAL NOT NULL CHECK (price > 0)
    );
    CREATE TABLE IF NOT EXISTS order_delivery_updates (
        id TEXT PRIMARY KEY, order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
        status TEXT NOT NULL, note TEXT NOT NULL DEFAULT '', updated_by TEXT REFERENCES users(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS order_return_requests (
        id TEXT PRIMARY KEY, order_id TEXT NOT NULL UNIQUE REFERENCES orders(id) ON DELETE CASCADE,
        buyer_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        reason TEXT NOT NULL, photo_data TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
        response TEXT NOT NULL DEFAULT '', reviewed_by TEXT REFERENCES users(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS user_settings (
        user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, settings_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS listing_drafts (
        farmer_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        draft_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS wallet_accounts (
        user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        wallet_id TEXT NOT NULL UNIQUE,
        balance_cents INTEGER NOT NULL DEFAULT 0 CHECK (balance_cents >= 0),
        currency TEXT NOT NULL DEFAULT 'KES',
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'closed')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS wallet_transactions (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK (kind IN ('credit', 'debit')),
        event_type TEXT NOT NULL DEFAULT 'adjustment',
        amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
        reference_key TEXT NOT NULL UNIQUE, payment_reference TEXT,
        description TEXT NOT NULL, created_by TEXT REFERENCES users(id), created_at TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'completed', channel TEXT NOT NULL DEFAULT 'internal',
        counterparty_wallet_id TEXT, operation_id TEXT
    );
    CREATE TABLE IF NOT EXISTS wallet_operations (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK (kind IN ('deposit', 'withdrawal', 'transfer')),
        amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
        fee_cents INTEGER NOT NULL DEFAULT 0 CHECK (fee_cents >= 0), currency TEXT NOT NULL DEFAULT 'KES',
        channel TEXT NOT NULL, details_json TEXT NOT NULL DEFAULT '{}', payment_reference TEXT,
        status TEXT NOT NULL CHECK (status IN ('pending', 'processing', 'completed', 'rejected', 'failed')),
        peer_user_id TEXT REFERENCES users(id) ON DELETE SET NULL, peer_wallet_id TEXT, idempotency_key TEXT UNIQUE,
        reviewed_by TEXT REFERENCES users(id), reviewed_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS wallet_payment_methods (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK (kind IN ('mpesa', 'airtel', 'bank', 'paypal')),
        label TEXT NOT NULL, details_json TEXT NOT NULL,
        use_for TEXT NOT NULL CHECK (use_for IN ('deposit', 'withdrawal', 'both')),
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS wallet_schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS wallet_admins (
        user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS chat_conversations (
        id TEXT PRIMARY KEY,
        buyer_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        farmer_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        listing_id TEXT,
        created_at TEXT NOT NULL,
        last_message_at TEXT NOT NULL,
        UNIQUE (buyer_id, farmer_id, listing_id)
    );
    CREATE TABLE IF NOT EXISTS chat_presence (
        user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        last_seen TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS chat_messages (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,
        sender_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        body TEXT NOT NULL,
        created_at TEXT NOT NULL,
        attachment_json TEXT NOT NULL DEFAULT '[]',
        pinned INTEGER NOT NULL DEFAULT 0,
        read_at TEXT,
        deleted_for TEXT NOT NULL DEFAULT '[]',
        deleted_at TEXT,
        forwarded_from TEXT
    );
    CREATE TABLE IF NOT EXISTS chat_conversation_states (
        conversation_id TEXT NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        cleared_at TEXT,
        deleted_at TEXT,
        PRIMARY KEY (conversation_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS wishlist_items (
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        listing_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (user_id, listing_id)
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions(expires_at);
    CREATE INDEX IF NOT EXISTS idx_pending_signups_expiry ON pending_signups(expires_at);
    CREATE INDEX IF NOT EXISTS idx_listings_farmer ON listings(farmer_id);
    CREATE INDEX IF NOT EXISTS idx_orders_buyer ON orders(buyer_id);
    CREATE INDEX IF NOT EXISTS idx_order_items_farmer ON order_items(farmer_id);
    CREATE INDEX IF NOT EXISTS idx_wallet_transactions_user ON wallet_transactions(user_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_wallet_operations_user ON wallet_operations(user_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_wallet_operations_status ON wallet_operations(status, created_at);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_wallet_operations_payment_reference ON wallet_operations(payment_reference) WHERE payment_reference IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_chat_conversations_buyer ON chat_conversations(buyer_id, last_message_at);
    CREATE INDEX IF NOT EXISTS idx_chat_conversations_farmer ON chat_conversations(farmer_id, last_message_at);
    CREATE INDEX IF NOT EXISTS idx_chat_messages_conversation ON chat_messages(conversation_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_chat_messages_unread ON chat_messages(conversation_id, sender_id, read_at);
    CREATE INDEX IF NOT EXISTS idx_chat_conversation_states_user ON chat_conversation_states(user_id, deleted_at);
    CREATE INDEX IF NOT EXISTS idx_wishlist_items_user ON wishlist_items(user_id, created_at);
`;

function seedListings(db) {
    const rows = [
        ['demo-ndengu', 'Samuel Mutua', 'Green Grams (Ndengu)', 'Grains & Pulses', 420, 10, 180, 'Mutomo, Kitui South'],
        ['demo-mangoes', 'Grace Nduku', 'Ripe Mangoes', 'Fruits', 160, 5, 90, 'Kitui Central'],
        ['demo-watermelon', 'Peter Muli', 'Watermelon', 'Fruits', 700, 100, 55, 'Mwingi'],
        ['demo-cassava', 'Mary Kilonzo', 'Fresh Cassava', 'Roots & Tubers', 250, 20, 75, 'Mutomo'],
        ['demo-tomatoes', 'David Musau', 'Garden Tomatoes', 'Vegetables', 85, 5, 110, 'Kitui Central'],
        ['demo-beans', 'Lilian Wambua', 'Rose Coco Beans', 'Grains & Pulses', 300, 100, 210, 'Mwingi North']
    ];
    const insert = db.prepare(`
        INSERT OR IGNORE INTO listings
        (id, farmer_id, seller_name, name, category, quantity, minimum_order, price, location, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const [id, seller, name, category, quantity, minimum, price, location] of rows) {
        insert.run(id, `demo-${id}`, seller, name, category, quantity, minimum, price, location, new Date().toISOString());
    }
}

function createSqliteStore(dbPath) {
    if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const db = new DatabaseSync(dbPath);
    db.exec(SQLITE_SCHEMA);
    const addMissingColumns = (table, columns) => {
        const existing = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(column => column.name));
        for (const [name, definition] of Object.entries(columns)) {
            if (!existing.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
        }
    };
    addMissingColumns('wallet_accounts', {
        wallet_id: 'TEXT', currency: "TEXT NOT NULL DEFAULT 'KES'", status: "TEXT NOT NULL DEFAULT 'active'",
        created_at: "TEXT NOT NULL DEFAULT ''"
    });
    addMissingColumns('wallet_transactions', {
        event_type: "TEXT NOT NULL DEFAULT 'adjustment'", status: "TEXT NOT NULL DEFAULT 'completed'",
        channel: "TEXT NOT NULL DEFAULT 'internal'", counterparty_wallet_id: 'TEXT', operation_id: 'TEXT'
    });
    addMissingColumns('chat_messages', {
        attachment_json: "TEXT NOT NULL DEFAULT '[]'", pinned: 'INTEGER NOT NULL DEFAULT 0',
        read_at: 'TEXT', deleted_for: "TEXT NOT NULL DEFAULT '[]'", deleted_at: 'TEXT', forwarded_from: 'TEXT'
    });
    if (!db.prepare('SELECT version FROM wallet_schema_migrations WHERE version = 2').get()) {
        db.exec('BEGIN IMMEDIATE');
        try {
            // The owner explicitly requested a clean wallet start; keep the admin allowlist intact.
            db.exec('DELETE FROM wallet_transactions; DELETE FROM wallet_operations; DELETE FROM wallet_accounts; DROP TABLE IF EXISTS wallet_topup_requests;');
            db.prepare('INSERT INTO wallet_schema_migrations (version, applied_at) VALUES (2, ?)').run(new Date().toISOString());
            db.exec('COMMIT');
        } catch (error) {
            db.exec('ROLLBACK');
            throw error;
        }
    }
    if (!db.prepare('SELECT version FROM wallet_schema_migrations WHERE version = 3').get()) {
        db.exec('BEGIN IMMEDIATE');
        try {
            // Explicitly authorized reset: clear wallet balances and histories, preserving users and payment settings.
            db.exec('DELETE FROM wallet_transactions; DELETE FROM wallet_operations; DELETE FROM wallet_accounts;');
            db.prepare('INSERT INTO wallet_schema_migrations (version, applied_at) VALUES (3, ?)').run(new Date().toISOString());
            db.exec('COMMIT');
        } catch (error) { db.exec('ROLLBACK'); throw error; }
    }
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_wallet_accounts_wallet_id ON wallet_accounts(wallet_id)');
    const userColumns = db.prepare('PRAGMA table_info(users)').all();
    if (!userColumns.some(column => column.name === 'profile_photo')) {
        db.exec("ALTER TABLE users ADD COLUMN profile_photo TEXT NOT NULL DEFAULT ''");
    }
    if (!userColumns.some(column => column.name === 'gender')) {
        db.exec("ALTER TABLE users ADD COLUMN gender TEXT NOT NULL DEFAULT ''");
    }
    seedListings(db);
    const inTransaction = new AsyncLocalStorage();
    let queue = Promise.resolve();

    const enqueue = action => {
        const result = queue.then(action, action);
        queue = result.then(() => {}, () => {});
        return result;
    };
    const direct = (sql, params) => db.prepare(sql);

    const store = {
        engine: 'sqlite',
        all(sql, params = []) {
            const read = () => direct(sql, params).all(...params);
            return inTransaction.getStore() ? Promise.resolve(read()) : enqueue(read);
        },
        get(sql, params = []) {
            const read = () => direct(sql, params).get(...params);
            return inTransaction.getStore() ? Promise.resolve(read()) : enqueue(read);
        },
        run(sql, params = []) {
            const write = () => ({ changes: Number(direct(sql, params).run(...params).changes) });
            return inTransaction.getStore() ? Promise.resolve(write()) : enqueue(write);
        },
        async exec(sql) {
            db.exec(sql);
        },
        transaction(action) {
            return enqueue(async () => {
                db.exec('BEGIN IMMEDIATE');
                try {
                    const value = await inTransaction.run(true, action);
                    db.exec('COMMIT');
                    return value;
                } catch (error) {
                    db.exec('ROLLBACK');
                    throw error;
                }
            });
        },
        async close() {
            db.close();
        }
    };
    return store;
}

function createPostgresStore(connectionString, options = {}) {
    let Pool = options.Pool;
    if (!Pool) {
        try {
            ({ Pool } = require('pg'));
        } catch {
            throw new Error('The "pg" package is required for DATABASE_URL. Run "npm install" in backend/.');
        }
    }
    const url = new URL(connectionString);
    const local = ['localhost', '127.0.0.1'].includes(url.hostname);
    const pool = new Pool({
        connectionString,
        max: Number(process.env.PGPOOL_MAX) || 5,
        ssl: local ? false : { rejectUnauthorized: false }
    });
    const ready = options.autoMigrate
        ? (async () => {
            const statements = [
                "ALTER TABLE users ADD COLUMN IF NOT EXISTS profile_photo TEXT NOT NULL DEFAULT ''",
                "ALTER TABLE users ADD COLUMN IF NOT EXISTS gender TEXT NOT NULL DEFAULT ''",
                `CREATE TABLE IF NOT EXISTS pending_signups (
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
            )`,
                `CREATE TABLE IF NOT EXISTS password_reset_codes (
                user_id text primary key references users(id) on delete cascade,
                code_salt text not null,
                code_hash text not null,
                attempts integer not null default 0,
                expires_at bigint not null,
                created_at text not null
            )`,
                `CREATE TABLE IF NOT EXISTS order_delivery_updates (
                id text primary key, order_id text not null references orders(id) on delete cascade,
                status text not null, note text not null default '', updated_by text references users(id) on delete set null,
                created_at text not null
            )`,
                `CREATE TABLE IF NOT EXISTS order_return_requests (
                id text primary key, order_id text not null unique references orders(id) on delete cascade,
                buyer_id text not null references users(id) on delete cascade,
                reason text not null, photo_data text not null default '',
                status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
                response text not null default '', reviewed_by text references users(id) on delete set null,
                created_at text not null, updated_at text not null
            )`,
                `CREATE TABLE IF NOT EXISTS listing_drafts (
                farmer_id text primary key references users(id) on delete cascade,
                draft_json text not null,
                updated_at text not null
            )`,
                `CREATE TABLE IF NOT EXISTS wallet_accounts (
                user_id text primary key references users(id) on delete cascade,
                wallet_id text not null unique,
                balance_cents integer not null default 0 check (balance_cents >= 0),
                currency text not null default 'KES',
                status text not null default 'active' check (status in ('active', 'closed')),
                created_at text not null,
                updated_at text not null
            )`,
                `CREATE TABLE IF NOT EXISTS wallet_transactions (
                id text primary key, user_id text not null references users(id) on delete cascade,
                kind text not null check (kind in ('credit', 'debit')),
                event_type text not null default 'adjustment',
                amount_cents integer not null check (amount_cents > 0),
                reference_key text not null unique, payment_reference text,
                description text not null, created_by text references users(id), created_at text not null,
                status text not null default 'completed', channel text not null default 'internal',
                counterparty_wallet_id text, operation_id text
            )`,
                `CREATE TABLE IF NOT EXISTS wallet_operations (
                id text primary key, user_id text not null references users(id) on delete cascade,
                kind text not null check (kind in ('deposit', 'withdrawal', 'transfer')),
                amount_cents integer not null check (amount_cents > 0),
                fee_cents integer not null default 0 check (fee_cents >= 0), currency text not null default 'KES',
                channel text not null, details_json text not null default '{}', payment_reference text,
                status text not null check (status in ('pending', 'processing', 'completed', 'rejected', 'failed')),
                peer_user_id text references users(id) on delete set null, peer_wallet_id text, idempotency_key text unique,
                reviewed_by text references users(id), reviewed_at text, created_at text not null, updated_at text not null
            )`,
                `CREATE TABLE IF NOT EXISTS wallet_payment_methods (
                id text primary key, user_id text not null references users(id) on delete cascade,
                kind text not null check (kind in ('mpesa', 'airtel', 'bank', 'paypal')),
                label text not null, details_json text not null,
                use_for text not null check (use_for in ('deposit', 'withdrawal', 'both')),
                created_at text not null, updated_at text not null
            )`,
                'ALTER TABLE wallet_accounts ADD COLUMN IF NOT EXISTS wallet_id text',
                "ALTER TABLE wallet_accounts ADD COLUMN IF NOT EXISTS currency text NOT NULL DEFAULT 'KES'",
                "ALTER TABLE wallet_accounts ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'active'",
                "ALTER TABLE wallet_accounts ADD COLUMN IF NOT EXISTS created_at text NOT NULL DEFAULT ''",
                "ALTER TABLE wallet_transactions ADD COLUMN IF NOT EXISTS event_type text NOT NULL DEFAULT 'adjustment'",
                "ALTER TABLE wallet_transactions ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'completed'",
                "ALTER TABLE wallet_transactions ADD COLUMN IF NOT EXISTS channel text NOT NULL DEFAULT 'internal'",
                'ALTER TABLE wallet_transactions ADD COLUMN IF NOT EXISTS counterparty_wallet_id text',
                'ALTER TABLE wallet_transactions ADD COLUMN IF NOT EXISTS operation_id text',
                'CREATE TABLE IF NOT EXISTS wallet_schema_migrations (version integer primary key, applied_at text not null)',
                `DO $wallet_migration$ BEGIN
                    IF NOT EXISTS (SELECT 1 FROM wallet_schema_migrations WHERE version = 2) THEN
                        DELETE FROM wallet_transactions;
                        DELETE FROM wallet_operations;
                        DELETE FROM wallet_accounts;
                        DROP TABLE IF EXISTS wallet_topup_requests;
                        INSERT INTO wallet_schema_migrations (version, applied_at) VALUES (2, now()::text);
                    END IF;
                END; $wallet_migration$`,
                `DO $wallet_migration_v3$ BEGIN
                    IF NOT EXISTS (SELECT 1 FROM wallet_schema_migrations WHERE version = 3) THEN
                        DELETE FROM wallet_transactions;
                        DELETE FROM wallet_operations;
                        DELETE FROM wallet_accounts;
                        INSERT INTO wallet_schema_migrations (version, applied_at) VALUES (3, now()::text);
                    END IF;
                END; $wallet_migration_v3$`,
                'ALTER TABLE wallet_accounts ALTER COLUMN wallet_id SET NOT NULL',
                `DO $wallet_account_constraints$ BEGIN
                    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'wallet_accounts_status_check' AND conrelid = 'wallet_accounts'::regclass) THEN
                        ALTER TABLE wallet_accounts ADD CONSTRAINT wallet_accounts_status_check CHECK (status IN ('active', 'closed'));
                    END IF;
                END; $wallet_account_constraints$`,
                `CREATE TABLE IF NOT EXISTS wallet_admins (
                user_id text primary key references users(id) on delete cascade,
                created_at text not null
            )`,
                `CREATE TABLE IF NOT EXISTS chat_conversations (
                id text primary key,
                buyer_id text not null references users(id) on delete cascade,
                farmer_id text not null references users(id) on delete cascade,
                listing_id text,
                created_at text not null,
                last_message_at text not null,
                unique (buyer_id, farmer_id, listing_id)
            )`,
                `CREATE TABLE IF NOT EXISTS chat_presence (
                user_id text primary key references users(id) on delete cascade,
                last_seen text not null
            )`,
                `CREATE TABLE IF NOT EXISTS chat_messages (
                id text primary key,
                conversation_id text not null references chat_conversations(id) on delete cascade,
                sender_id text not null references users(id) on delete cascade,
                body text not null,
                created_at text not null,
                attachment_json text not null default '[]', pinned integer not null default 0,
                read_at text, deleted_for text not null default '[]', deleted_at text, forwarded_from text
            )`,
                `CREATE TABLE IF NOT EXISTS chat_conversation_states (
                conversation_id text not null references chat_conversations(id) on delete cascade,
                user_id text not null references users(id) on delete cascade,
                cleared_at text, deleted_at text, primary key (conversation_id, user_id)
            )`,
                'ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS attachment_json text NOT NULL DEFAULT \'[]\'',
                'ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS pinned integer NOT NULL DEFAULT 0',
                'ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS read_at text',
                'ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS deleted_for text NOT NULL DEFAULT \'[]\'',
                'ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS deleted_at text',
                'ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS forwarded_from text',
                `CREATE TABLE IF NOT EXISTS wishlist_items (
                user_id text not null references users(id) on delete cascade,
                listing_id text not null,
                created_at text not null,
                primary key (user_id, listing_id)
            )`,
                'CREATE INDEX IF NOT EXISTS idx_wallet_transactions_user ON wallet_transactions(user_id, created_at)',
                'CREATE UNIQUE INDEX IF NOT EXISTS idx_wallet_accounts_wallet_id ON wallet_accounts(wallet_id)',
                'CREATE INDEX IF NOT EXISTS idx_wallet_operations_user ON wallet_operations(user_id, created_at)',
                'CREATE INDEX IF NOT EXISTS idx_wallet_operations_status ON wallet_operations(status, created_at)',
                'CREATE UNIQUE INDEX IF NOT EXISTS idx_wallet_operations_payment_reference ON wallet_operations(payment_reference) WHERE payment_reference IS NOT NULL',
                'CREATE INDEX IF NOT EXISTS idx_pending_signups_expiry ON pending_signups(expires_at)',
                'CREATE INDEX IF NOT EXISTS idx_chat_conversations_buyer ON chat_conversations(buyer_id, last_message_at)',
                'CREATE INDEX IF NOT EXISTS idx_chat_conversations_farmer ON chat_conversations(farmer_id, last_message_at)',
                'CREATE INDEX IF NOT EXISTS idx_chat_messages_conversation ON chat_messages(conversation_id, created_at)',
                'CREATE INDEX IF NOT EXISTS idx_chat_messages_unread ON chat_messages(conversation_id, sender_id, read_at)',
                'CREATE INDEX IF NOT EXISTS idx_chat_conversation_states_user ON chat_conversation_states(user_id, deleted_at)',
                'CREATE INDEX IF NOT EXISTS idx_wishlist_items_user ON wishlist_items(user_id, created_at)',
                'CREATE INDEX IF NOT EXISTS idx_order_delivery_updates_order ON order_delivery_updates(order_id, created_at)',
                'CREATE INDEX IF NOT EXISTS idx_order_return_requests_status ON order_return_requests(status, created_at)',
                'ALTER TABLE wallet_accounts ENABLE ROW LEVEL SECURITY',
                'ALTER TABLE wallet_transactions ENABLE ROW LEVEL SECURITY',
                'ALTER TABLE wallet_operations ENABLE ROW LEVEL SECURITY',
                'ALTER TABLE wallet_schema_migrations ENABLE ROW LEVEL SECURITY',
                'ALTER TABLE wallet_admins ENABLE ROW LEVEL SECURITY',
                'ALTER TABLE pending_signups ENABLE ROW LEVEL SECURITY',
                'ALTER TABLE password_reset_codes ENABLE ROW LEVEL SECURITY',
                'ALTER TABLE chat_conversations ENABLE ROW LEVEL SECURITY',
                'ALTER TABLE chat_messages ENABLE ROW LEVEL SECURITY',
                'ALTER TABLE chat_conversation_states ENABLE ROW LEVEL SECURITY',
                'ALTER TABLE chat_presence ENABLE ROW LEVEL SECURITY',
                'ALTER TABLE wishlist_items ENABLE ROW LEVEL SECURITY',
                'ALTER TABLE listing_drafts ENABLE ROW LEVEL SECURITY'
            ];
            for (const statement of statements) await pool.query(statement);
        })()
        : Promise.resolve();
    const session = new AsyncLocalStorage();

    // Postgres reports a unique violation as 23505; the routes branch on the
    // SQLite errcode, so both engines are normalised to 2067 here.
    const normalize = error => {
        if (error && error.code === '23505') error.errcode = 2067;
        return error;
    };
    const toPostgres = sql => {
        let index = 0;
        return sql.replace(/\?/g, () => `$${++index}`);
    };
    const query = async (sql, params) => {
        await ready;
        const runner = session.getStore() || pool;
        try {
            return await runner.query(toPostgres(sql), params);
        } catch (error) {
            throw normalize(error);
        }
    };

    return {
        engine: 'postgres',
        async all(sql, params = []) {
            return (await query(sql, params)).rows;
        },
        async get(sql, params = []) {
            return (await query(sql, params)).rows[0];
        },
        async run(sql, params = []) {
            const result = await query(sql, params);
            return { changes: Number(result.rowCount) || 0 };
        },
        async exec(sql) {
            await ready;
            await pool.query(sql);
        },
        async transaction(action) {
            await ready;
            const client = await pool.connect();
            try {
                await client.query('BEGIN');
                const value = await session.run(client, action);
                await client.query('COMMIT');
                return value;
            } catch (error) {
                await client.query('ROLLBACK');
                throw normalize(error);
            } finally {
                client.release();
            }
        },
        async close() {
            await pool.end();
        }
    };
}

function createStore(options = {}) {
    if (options.db) return options.db;
    if (options.dbPath) return createSqliteStore(options.dbPath);
    const connectionString = options.databaseUrl || process.env.DATABASE_URL;
    if (connectionString) return createPostgresStore(connectionString, { autoMigrate: true });
    return createSqliteStore(process.env.DB_PATH || path.join(__dirname, 'data', 'kitui-farm.sqlite'));
}

function cookies(header = '') {
    return Object.fromEntries(header.split(';').map(part => {
        const index = part.indexOf('=');
        return index < 0 ? ['', ''] : [part.slice(0, index).trim(), part.slice(index + 1).trim()];
    }).filter(([key]) => key));
}

function text(value, maxLength) {
    return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

function emailIsValid(value) {
    return /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@gmail\.com$/i.test(value);
}

function appBaseUrl(req) {
    const origin = req.headers.origin && ALLOWED_ORIGINS.includes(new URL(req.headers.origin).origin)
        ? new URL(req.headers.origin).origin : `${req.protocol}://${req.get('host')}`;
    const defaultBase = new URL(origin).hostname.endsWith('.github.io') ? `${origin}/kitui-farm` : origin;
    return (process.env.PUBLIC_APP_URL || defaultBase).trim().replace(/\/$/, '');
}

async function sendGmailMessage({ email, subject, body, html }) {
    const gmailUser = (process.env.GMAIL_USER || '').trim().toLowerCase();
    const oauthClientId = (process.env.GMAIL_OAUTH_CLIENT_ID || '').trim();
    const oauthClientSecret = (process.env.GMAIL_OAUTH_CLIENT_SECRET || '').trim();
    const oauthRefreshToken = (process.env.GMAIL_OAUTH_REFRESH_TOKEN || '').trim();
    if (!emailIsValid(gmailUser) || !oauthClientId || !oauthClientSecret || !oauthRefreshToken) {
        const error = new Error('Email delivery is not configured yet. Add the Gmail API OAuth settings in Render, then try again.');
        error.status = 503;
        throw error;
    }
    const rawMessage = [
        `From: KITUI FARM <${gmailUser}>`,
        `To: ${email}`,
        `Subject: =?UTF-8?B?${Buffer.from(subject).toString('base64')}?=`,
        'MIME-Version: 1.0',
        `Content-Type: ${html ? 'text/html' : 'text/plain'}; charset=UTF-8`,
        'Content-Transfer-Encoding: 8bit',
        '',
        html || body
    ].join('\r\n');
    try {
        const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                client_id: oauthClientId,
                client_secret: oauthClientSecret,
                refresh_token: oauthRefreshToken,
                grant_type: 'refresh_token'
            }),
            signal: AbortSignal.timeout(15000)
        });
        const tokenPayload = await tokenResponse.json().catch(() => ({}));
        if (!tokenResponse.ok || !tokenPayload.access_token) {
            console.error('[signup-email] Gmail OAuth token request failed', {
                httpStatus: tokenResponse.status,
                error: typeof tokenPayload.error === 'string' ? tokenPayload.error : 'unknown_error'
            });
            const error = new Error('Gmail authorization failed. Check the Gmail API OAuth values in Render.');
            error.status = 502;
            throw error;
        }
        const sendResponse = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
            method: 'POST',
            headers: {
                authorization: `Bearer ${tokenPayload.access_token}`,
                'content-type': 'application/json'
            },
            body: JSON.stringify({ raw: Buffer.from(rawMessage).toString('base64url') }),
            signal: AbortSignal.timeout(20000)
        });
        if (!sendResponse.ok) {
            const sendPayload = await sendResponse.json().catch(() => ({}));
            console.error('[signup-email] Gmail API send failed', {
                httpStatus: sendResponse.status,
                errorStatus: typeof sendPayload.error?.status === 'string' ? sendPayload.error.status : 'unknown_error',
                errorCode: Number.isInteger(sendPayload.error?.code) ? sendPayload.error.code : undefined
            });
            const error = new Error('Gmail could not send the verification email. Check Gmail API authorization and permissions.');
            error.status = 502;
            throw error;
        }
    } catch (cause) {
        if (cause.status) throw cause;
        console.error('[signup-email] Gmail API request failed', {
            code: typeof cause.code === 'string' ? cause.code : 'request_failed',
            name: typeof cause.name === 'string' ? cause.name : 'Error'
        });
        const error = new Error('Gmail could not send the verification email. Check the Gmail API OAuth setup in Render.');
        error.status = 502;
        throw error;
    }
}

function escapeEmailHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, character => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[character]));
}

function brandedEmailTemplate({ preheader, title, greeting, paragraphs = [], ctaLabel, ctaUrl, code, note }) {
    const paragraphMarkup = paragraphs.map(paragraph =>
        `<p style="margin:0 0 16px;color:#342718;font-size:15px;line-height:1.7">${escapeEmailHtml(paragraph).replace(/\r?\n/g, '<br>')}</p>`
    ).join('');
    const codeMarkup = code ? `<div style="margin:23px 0;padding:18px 16px;border:1px solid #e5dcc6;border-radius:12px;background:#fff2c7;text-align:center"><div style="margin-bottom:7px;color:#766b53;font-size:12px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase">Your secure code</div><div style="color:#17472c;font-family:Arial,Helvetica,sans-serif;font-size:32px;font-weight:800;letter-spacing:8px">${escapeEmailHtml(code)}</div></div>` : '';
    const buttonMarkup = ctaLabel && ctaUrl
        ? `<table role="presentation" cellspacing="0" cellpadding="0" style="margin:24px 0 8px"><tr><td align="center" style="border-radius:9px;background:#08723d"><a href="${escapeEmailHtml(ctaUrl)}" style="display:inline-block;padding:13px 22px;border:1px solid #08723d;border-radius:9px;color:#ffffff;font-size:15px;font-weight:700;text-decoration:none">${escapeEmailHtml(ctaLabel)}</a></td></tr></table>`
        : '';
    const noteMarkup = note
        ? `<div style="margin-top:18px;padding:12px 14px;border-left:3px solid #d77b20;background:#fff2c7;color:#766b53;font-size:13px;line-height:1.6">${escapeEmailHtml(note)}</div>`
        : '';
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0;padding:0;background:#fbf8ed;font-family:Arial,Helvetica,sans-serif;color:#342718"><div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent">${escapeEmailHtml(preheader || title)}</div><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#fbf8ed"><tr><td align="center" style="padding:28px 14px"><table role="presentation" width="600" cellspacing="0" cellpadding="0" style="width:100%;max-width:600px;border:1px solid #e5dcc6;border-radius:16px;background:#fffdf7;overflow:hidden"><tr><td style="padding:22px 28px;background:#17472c;color:#fff2c7"><div style="font-size:20px;font-weight:800;letter-spacing:.4px">KITUI FARM</div><div style="margin-top:4px;color:#e5f0d8;font-size:12px">Fresh from local farms</div></td></tr><tr><td style="padding:30px 28px"><h1 style="margin:0 0 20px;color:#17472c;font-size:25px;line-height:1.25">${escapeEmailHtml(title)}</h1><p style="margin:0 0 16px;color:#342718;font-size:15px;line-height:1.65">Hello ${escapeEmailHtml(greeting)},</p>${paragraphMarkup}${codeMarkup}${buttonMarkup}${noteMarkup}<div style="margin-top:26px;padding-top:18px;border-top:1px solid #e5dcc6;color:#766b53;font-size:13px;line-height:1.6">Need help? Contact KITUI FARM Customer Service at <a href="tel:0114583373" style="color:#08723d;font-weight:700;text-decoration:none">0114 583 373</a>.</div><p style="margin:19px 0 0;color:#766b53;font-size:13px">KITUI FARM Support</p></td></tr></table><div style="padding:14px 8px 0;color:#766b53;font-size:11px;text-align:center">You received this email because of activity on your KITUI FARM account.</div></td></tr></table></body></html>`;
}

function deletionEmailTemplate({ title, greeting, paragraphs }) {
    const body = paragraphs.map(paragraph => `<p style="margin:0 0 16px;line-height:1.65;color:#344236">${paragraph}</p>`).join('');
    return `<!doctype html><html lang="en"><body style="margin:0;background:#fbf8ed;font-family:Arial,Helvetica,sans-serif;color:#342718"><div style="max-width:620px;margin:32px auto;padding:0 16px"><div style="background:#fffdf7;border:1px solid #e5dcc6;border-radius:16px;overflow:hidden"><div style="padding:24px 30px;background:#17472c;color:#fff2c7;font-size:20px;font-weight:700">KITUI FARM</div><div style="padding:30px"><h1 style="margin:0 0 22px;color:#17472c;font-size:25px">${title}</h1><p style="margin:0 0 16px;line-height:1.65;color:#342718">Hello ${greeting},</p>${body}<div style="margin-top:26px;padding-top:18px;border-top:1px solid #e5dcc6;color:#766b53;font-size:14px;line-height:1.6">Need help? Contact KITUI FARM Customer Service at <a href="tel:0114583373" style="color:#08723d;font-weight:700">0114 583 373</a>.</div><p style="margin:22px 0 0;color:#766b53;font-size:14px">KITUI FARM Support</p></div></div></div></body></html>`;
}

async function sendAdminDeletionEmail({ email, name, reason }) {
    const escapedReason = escapeEmailHtml(reason).replace(/\r?\n/g, '<br>');
    await sendGmailMessage({
        email,
        subject: 'Your KITUI FARM account has been closed',
        body: `Hello ${name},\n\nYour KITUI FARM account has been closed by an administrator. Reason: ${reason}\n\nAccess to your account and its data has been revoked. For support, contact Customer Service at 0114 583 373.\n\nKITUI FARM Support`,
        html: deletionEmailTemplate({
            title: 'Your account has been closed',
            greeting: escapeEmailHtml(name),
            paragraphs: [
                'Your KITUI FARM account has been closed by an administrator.',
                `<strong>Reason provided:</strong><br>${escapedReason}`,
                'Access to your account and its data has been revoked.'
            ]
        })
    });
}

async function sendSelfDeletionEmail({ email, name }) {
    await sendGmailMessage({
        email,
        subject: 'Your KITUI FARM account has been deleted',
        body: `Hello ${name},\n\nYour KITUI FARM account has been permanently deleted at your request. It can no longer be accessed or recovered. Any remaining wallet balance and wallet records were cleared as part of account deletion, according to KITUI FARM policy. To use KITUI FARM again, you will need to register a brand new account.\n\nFor support, contact Customer Service at 0114 583 373.\n\nKITUI FARM Support`,
        html: deletionEmailTemplate({
            title: 'Your account has been deleted',
            greeting: escapeEmailHtml(name),
            paragraphs: [
                'Your KITUI FARM account has been permanently deleted at your request.',
                '<strong>This account can no longer be accessed or recovered.</strong>',
                'Any remaining wallet balance and wallet records were cleared as part of account deletion, according to KITUI FARM policy.',
                'If you wish to use KITUI FARM in the future, you will need to register a brand new account.'
            ]
        })
    });
}

async function sendSignupVerification({ email, name, token, baseUrl, resent = false }) {
    const configuredUrl = (process.env.PUBLIC_APP_URL || baseUrl).trim().replace(/\/$/, '');
    if (!/^https:\/\//i.test(configuredUrl) && process.env.NODE_ENV === 'production') {
        const error = new Error('Email verification needs an HTTPS PUBLIC_APP_URL in Render.');
        error.status = 503;
        throw error;
    }
    const verifyUrl = `${configuredUrl}/email-verify.html?token=${encodeURIComponent(token)}`;
    await sendGmailMessage({
        email,
        subject: resent ? 'Your new KITUI FARM verification link' : 'Verify your KITUI FARM email',
        body: `Hello ${name},\n\n${resent ? 'Here is the new verification link you requested.' : 'Confirm this Gmail address to finish creating your KITUI FARM account.'}\n\nThis link expires in 24 hours and can only be used once.\n\n${verifyUrl}\n\nIf you did not request this account, you can ignore this email.\n\nKITUI FARM Support`,
        html: brandedEmailTemplate({
            preheader: resent ? 'Your new KITUI FARM email verification link.' : 'Confirm your email to finish creating your KITUI FARM account.',
            title: resent ? 'Your new verification link' : 'Verify your email address',
            greeting: name,
            paragraphs: [resent
                ? 'You requested a new link to verify your email address and finish setting up your KITUI FARM account.'
                : 'Confirm this Gmail address to finish creating your KITUI FARM account.'],
            ctaLabel: 'Verify my email',
            ctaUrl: verifyUrl,
            note: 'This link expires in 24 hours and can only be used once. If you did not request this account, you can ignore this email.'
        })
    });
}

async function sendWelcomeEmail({ email, name, role, baseUrl }) {
    const configuredUrl = (process.env.PUBLIC_APP_URL || baseUrl).trim().replace(/\/$/, '');
    const roleMessage = role === 'farmer'
        ? 'You can now add and manage your farm products, share photos or videos, and connect with customers.'
        : 'You can now explore local produce, save products to your wishlist, and connect with farmers.';
    await sendGmailMessage({
        email,
        subject: 'Welcome to KITUI FARM',
        body: `Hello ${name},\n\nWelcome to KITUI FARM! Your email is verified and your account is ready.\n\n${roleMessage}\n\nSign in to KITUI FARM: ${configuredUrl}/login.html\n\nWe’re glad you’re here.\n\nKITUI FARM Support`,
        html: brandedEmailTemplate({
            preheader: 'Your KITUI FARM account is ready. Find fresh local produce and connect with the community.',
            title: 'Welcome to KITUI FARM',
            greeting: name,
            paragraphs: [
                'Your email is verified and your account is ready.',
                roleMessage,
                'We’re glad to have you as part of the KITUI FARM community.'
            ],
            ctaLabel: 'Sign in to KITUI FARM',
            ctaUrl: `${configuredUrl}/login.html`,
            note: 'Keep your account details private. KITUI FARM will never ask you to send your password by email.'
        })
    });
}

async function sendPasswordResetEmail({ email, name, code, baseUrl }) {
    const configuredUrl = (process.env.PUBLIC_APP_URL || baseUrl).trim().replace(/\/$/, '');
    await sendGmailMessage({
        email,
        subject: 'Your KITUI FARM password reset code',
        body: `Hello ${name},\n\nYour KITUI FARM password reset code is: ${code}\n\nEnter this code on the password reset page to choose a new password. The code expires in 10 minutes and can only be used once. If you did not request this, ignore this email.\n\nKITUI FARM Support`,
        html: brandedEmailTemplate({
            preheader: 'Use your one-time KITUI FARM code to reset your password.',
            title: 'Reset your password',
            greeting: name,
            paragraphs: ['Use this one-time code on the KITUI FARM password reset page to choose a new password.'],
            code,
            ctaLabel: 'Open password reset',
            ctaUrl: `${configuredUrl}/forgot-password.html`,
            note: 'This code expires in 10 minutes and can only be used once. If you did not request a password reset, ignore this email and keep your current password.'
        })
    });
}

async function sendPasswordChangedEmail({ email, name, baseUrl }) {
    const configuredUrl = (process.env.PUBLIC_APP_URL || baseUrl).trim().replace(/\/$/, '');
    await sendGmailMessage({
        email,
        subject: 'Your KITUI FARM password was changed',
        body: `Hello ${name},\n\nThe password for your KITUI FARM account was changed successfully. You can now sign in with your new password.\n\nIf you did not make this change, contact KITUI FARM Customer Service immediately at 0114 583 373.\n\nKITUI FARM Support`,
        html: brandedEmailTemplate({
            preheader: 'Your KITUI FARM account password was changed.',
            title: 'Your password was changed',
            greeting: name,
            paragraphs: ['The password for your KITUI FARM account was changed successfully. You can now sign in with your new password.'],
            ctaLabel: 'Sign in to KITUI FARM',
            ctaUrl: `${configuredUrl}/login.html`,
            note: 'If you did not make this change, contact KITUI FARM Customer Service immediately at 0114 583 373.'
        })
    });
}

async function sendAdminWelcomeEmail({ email, name, baseUrl }) {
    const configuredUrl = (process.env.PUBLIC_APP_URL || baseUrl).trim().replace(/\/$/, '');
    const adminSignInUrl = `${configuredUrl}/admin-signin.html`;
    await sendGmailMessage({
        email,
        subject: 'Welcome to the KITUI FARM Admin Console',
        body: `Hello ${name},\n\nWelcome to the KITUI FARM Admin Console. Your administrator account has been created.\n\nThe Admin Console is the secure management area for overseeing KITUI FARM. Depending on your assigned permissions, you can review user accounts, farmer listings, buyer orders, support conversations, wallet requests, and other marketplace activity. Use these tools only to support the safe and fair operation of KITUI FARM.\n\nSign in to the Admin Console: ${adminSignInUrl}\n\nKeep your password and admin access details private. Never share them by email or with another user.\n\nKITUI FARM Support`,
        html: brandedEmailTemplate({
            preheader: 'Your administrator account is ready. Learn what the KITUI FARM Admin Console is for.',
            title: 'Welcome to the Admin Console',
            greeting: name,
            paragraphs: [
                'Your KITUI FARM administrator account has been created.',
                'The Admin Console is the secure management area for overseeing KITUI FARM. Depending on your assigned permissions, you can review user accounts, farmer listings, buyer orders, support conversations, wallet requests, and other marketplace activity.',
                'Use these tools only to support the safe and fair operation of KITUI FARM.'
            ],
            ctaLabel: 'Sign in to the Admin Console',
            ctaUrl: adminSignInUrl,
            note: 'Keep your password and admin access details private. Never share them by email or with another user.'
        })
    });
}

async function sendOrderReceiptEmail({ email, name, order, baseUrl }) {
    const configuredUrl = (process.env.PUBLIC_APP_URL || baseUrl).trim().replace(/\/$/, '');
    const receiptUrl = `${configuredUrl}/receipt.html?id=${encodeURIComponent(order.id)}`;
    const itemRows = order.items.map(item => {
        const lineTotal = Number(item.quantity) * Number(item.price);
        return `<tr><td style="padding:10px 8px;border-bottom:1px solid #e5dcc6">${escapeEmailHtml(item.name)}</td><td style="padding:10px 8px;border-bottom:1px solid #e5dcc6;text-align:right">${Number(item.quantity).toLocaleString('en-KE')} kg</td><td style="padding:10px 8px;border-bottom:1px solid #e5dcc6;text-align:right">KES ${Number(item.price).toLocaleString('en-KE')}</td><td style="padding:10px 8px;border-bottom:1px solid #e5dcc6;text-align:right">KES ${lineTotal.toLocaleString('en-KE')}</td></tr>`;
    }).join('');
    const date = new Date(order.createdAt).toLocaleString('en-KE', { dateStyle:'medium', timeStyle:'short', timeZone:'Africa/Nairobi' });
    const total = Number(order.total).toLocaleString('en-KE', { minimumFractionDigits:2, maximumFractionDigits:2 });
    const html = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><body style="margin:0;padding:24px 12px;background:#fbf8ed;font-family:Arial,sans-serif;color:#342718"><main style="max-width:640px;margin:auto;border:1px solid #e5dcc6;border-radius:16px;background:#fffdf7;overflow:hidden"><header style="padding:22px 26px;background:#17472c;color:#fff2c7"><strong style="font-size:20px">KITUI FARM</strong><div style="margin-top:4px;font-size:13px;color:#e5f0d8">Purchase receipt</div></header><section style="padding:26px"><h1 style="margin:0 0 8px;color:#17472c;font-size:25px">Your order receipt</h1><p style="margin:0 0 20px;color:#657064">Hello ${escapeEmailHtml(name)}, your wallet payment was successful.</p><p><strong>Receipt / order ID:</strong> ${escapeEmailHtml(order.id)}<br><strong>Date:</strong> ${escapeEmailHtml(date)}<br><strong>Payment:</strong> KITUI FARM Wallet<br><strong>Delivery address:</strong> ${escapeEmailHtml(order.address)}</p><table width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;font-size:14px"><thead><tr><th align="left" style="padding:9px 8px;border-bottom:2px solid #17472c">Product</th><th align="right" style="padding:9px 8px;border-bottom:2px solid #17472c">Qty</th><th align="right" style="padding:9px 8px;border-bottom:2px solid #17472c">Price</th><th align="right" style="padding:9px 8px;border-bottom:2px solid #17472c">Total</th></tr></thead><tbody>${itemRows}</tbody></table><p style="margin:20px 0;font-size:19px;text-align:right"><strong>Total paid: KES ${total}</strong></p><p style="margin:0;color:#657064">Order status: ${escapeEmailHtml(order.status)}</p><p style="margin:22px 0"><a href="${escapeEmailHtml(receiptUrl)}" style="display:inline-block;padding:12px 18px;border-radius:8px;background:#08723d;color:white;font-weight:700;text-decoration:none">View or print receipt</a></p><p style="color:#657064;font-size:13px">Need help? Call KITUI FARM Customer Service on 0114 583 373.</p></section></main></body></html>`;
    const textLines = order.items.map(item => `${item.name} — ${item.quantity} kg × KES ${item.price} = KES ${(Number(item.quantity) * Number(item.price)).toFixed(2)}`);
    await sendGmailMessage({
        email, subject:`KITUI FARM receipt for order ${order.id}`,
        body:`Hello ${name},\n\nYour KITUI FARM Wallet payment was successful.\nReceipt / order ID: ${order.id}\nDate: ${date}\nDelivery address: ${order.address}\n\n${textLines.join('\n')}\n\nTotal paid: KES ${total}\nOrder status: ${order.status}\n\nView or print your receipt: ${receiptUrl}\n\nKITUI FARM Customer Service: 0114 583 373`,
        html
    });
}

function normalizedPhone(value) {
    const digits = String(value || '').replace(/\D/g, '');
    const local = digits.startsWith('254') ? digits.slice(3) : digits.startsWith('0') ? digits.slice(1) : digits;
    return /^[17]\d{8}$/.test(local) ? `+254${local}` : '';
}

function amountCents(value) {
    const amount = typeof value === 'number' ? String(value) : text(value, 16);
    if (!/^\d{1,7}(?:\.\d{1,2})?$/.test(amount)) return 0;
    const cents = Math.round(Number(amount) * 100);
    return Number.isSafeInteger(cents) && cents > 0 && cents <= 100000000 ? cents : 0;
}

function publicUser(user) {
    return { id: user.id, name: user.name, email: user.email, phone: user.phone, role: user.role, location: user.location, gender: user.gender || '', profilePhoto: user.profile_photo || '' };
}

function publicListing(row) {
    return {
        id: row.id, farmerId: row.farmer_id, sellerName: row.seller_name, name: row.name,
        category: row.category, quantity: row.quantity, minimumOrder: row.minimum_order,
        price: row.price, location: row.location,
        image: /^data:video\/(?:mp4|webm|quicktime);base64,/i.test(row.image || '') ? '' : row.image,
        videoUrl: /^data:video\/(?:mp4|webm|quicktime);base64,/i.test(row.image || '')
            ? `/api/listings/${encodeURIComponent(row.id)}/video` : '',
        createdAt: row.created_at
    };
}

async function publicOrder(store, row) {
    const [items, deliveryUpdates, returnRequest] = await Promise.all([store.all(
        'SELECT product_id, farmer_id, name, seller_name, location, quantity, price FROM order_items WHERE order_id = ?',
        [row.id]
    ), store.all('SELECT status, note, created_at FROM order_delivery_updates WHERE order_id = ? ORDER BY created_at, id', [row.id]),
    store.get('SELECT id, reason, length(photo_data) AS photo_size, status, response, created_at, updated_at FROM order_return_requests WHERE order_id = ?', [row.id])]);
    const publicItems = items.map(item => ({
        productId: item.product_id, farmerId: item.farmer_id, name: item.name,
        sellerName: item.seller_name, location: item.location, quantity: item.quantity, price: item.price
    }));
    const deliveryDate = new Date(new Date(row.created_at).getTime() + 2 * 24 * 60 * 60 * 1000);
    return {
        id: row.id, buyerId: row.buyer_id, buyerName: row.buyer_name, address: row.address,
        paymentMethod: row.payment_method, status: row.status, total: row.total, createdAt: row.created_at, items: publicItems,
        deliveryUpdates: deliveryUpdates.map(update => ({ status: update.status, note: update.note, createdAt: update.created_at })),
        returnRequest: returnRequest ? {
            id: returnRequest.id, reason: returnRequest.reason, hasPhoto: Number(returnRequest.photo_size || 0) > 0,
            photoUrl: Number(returnRequest.photo_size || 0) > 0 ? `/api/orders/${encodeURIComponent(row.id)}/returns/photo` : '',
            status: returnRequest.status, response: returnRequest.response,
            createdAt: returnRequest.created_at, updatedAt: returnRequest.updated_at
        } : null,
        paymentStatus: row.payment_method === 'KITUI FARM Wallet' ? 'Paid with wallet' : row.payment_method === 'Cash on delivery' ? 'Due on delivery' : 'Not processed (demo)',
        estimatedDelivery: deliveryDate.toLocaleDateString('en-KE', { day: 'numeric', month: 'short', year: 'numeric' })
    };
}

function validateListing(input, partial = false) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return 'A listing object is required.';
    const result = {};
    for (const field of ['name', 'category', 'quantity', 'minimumOrder', 'price', 'location', 'image']) {
        if (partial && !(field in input)) continue;
        const value = input[field];
        if (field === 'name' || field === 'location') {
            const valueText = text(value, field === 'name' ? 100 : 160);
            if (!valueText) return `${field} is required.`;
            result[field] = valueText;
        } else if (field === 'category') {
            if (!CATEGORIES.has(value)) return 'Choose a valid produce category.';
            result.category = value;
        } else if (field === 'quantity' || field === 'minimumOrder') {
            const number = Number(value);
            if (!Number.isSafeInteger(number) || number < (field === 'quantity' ? 0 : 1) || number > 10000000) {
                return `${field} must be a valid whole number.`;
            }
            result[field] = number;
        } else if (field === 'price') {
            const number = Number(value);
            if (!Number.isFinite(number) || number <= 0 || number > 100000000) return 'price must be a positive amount.';
            result.price = number;
        } else {
            const image = typeof value === 'string' ? value : '';
            const videoMatch = /^data:video\/(mp4|webm|quicktime);base64,([A-Za-z0-9+/]+={0,2})$/i.exec(image);
            const validPhoto = image.length <= 1000000
                && /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(image);
            const validVideo = videoMatch && image.length <= 7100000
                && Buffer.from(videoMatch[2], 'base64').length <= 5 * 1024 * 1024;
            if (image && !validPhoto && !validVideo) {
                return 'Choose a PNG, JPEG, or WebP photo up to 700 KB, or an MP4, WebM, or MOV video up to 5 MB.';
            }
            result.image = image;
        }
    }
    if (!Object.keys(result).length) return 'At least one listing field must be provided.';
    return result;
}

function createApp(options = {}) {
    const store = createStore(options);
    const app = express();
    const attempts = new Map();
    const adminAttempts = new Map();
    const adminRegistrationAttempts = new Map();
    const adminRegistrationGrants = new Map();
    const signupAttempts = new Map();
    const passwordResetAttempts = new Map();
    const reverseGeocodeCache = new Map();
    const reverseGeocodeUsers = new Map();
    let reverseGeocodeQueue = Promise.resolve();
    let lastReverseGeocodeAt = 0;
    const secureCookie = process.env.NODE_ENV === 'production' ? '; Secure' : '';

    app.disable('x-powered-by');
    if (process.env.NODE_ENV === 'production') {
        // Behind a host proxy (Render, Railway) the origin check needs the
        // forwarded protocol, and rate limiting needs the forwarded client IP.
        app.set('trust proxy', 1);
    }
    app.use((req, res, next) => {
        res.set({
            'X-Content-Type-Options': 'nosniff',
            'X-Frame-Options': 'DENY',
            'Referrer-Policy': 'same-origin',
            'Permissions-Policy': 'camera=(), microphone=(), geolocation=(self)'
        });
        if (req.path.startsWith('/api/')) res.setHeader('Cache-Control', 'no-store');
        if (req.path.startsWith('/api/') && req.headers.origin) {
            let origin;
            try { origin = new URL(req.headers.origin).origin; } catch { return res.status(403).json({ error: 'Invalid request origin.' }); }
            const sameOrigin = origin === `${req.protocol}://${req.get('host')}`;
            if (ALLOWED_ORIGINS.includes(origin)) {
                res.setHeader('Access-Control-Allow-Origin', origin);
                res.setHeader('Vary', 'Origin');
                res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
                res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
                res.setHeader('Access-Control-Max-Age', '600');
            } else if (!sameOrigin) {
                return res.status(403).json({ error: 'Cross-origin requests are not allowed.' });
            }
            if (req.method === 'OPTIONS') return res.status(204).end();
        }
        next();
    });
    app.use('/api', express.json({ limit: '8mb', strict: true, verify: (req, res, buffer) => { req.rawBody = Buffer.from(buffer); } }));

    async function createSession(user, res, remember) {
        const token = crypto.randomBytes(32).toString('hex');
        const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
        const expiresAt = Date.now() + SESSION_MS;
        await store.run('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)',
            [tokenHash, user.id, expiresAt]);
        const maxAge = remember ? `; Max-Age=${Math.floor(SESSION_MS / 1000)}` : '';
        res.setHeader('Set-Cookie', `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict${secureCookie}${maxAge}`);
        return token;
    }

    async function auth(req, res, next) {
        // Cookie sessions cover same-origin use; a bearer token covers static
        // front ends on another origin, where third-party cookies are blocked.
        const header = req.headers.authorization || '';
        const bearer = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
        const token = bearer || cookies(req.headers.cookie)[COOKIE];
        if (!token || !/^[a-f0-9]{64}$/.test(token)) return res.status(401).json({ error: 'Please log in to continue.' });
        const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
        const session = await store.get(`
            SELECT users.*, sessions.token_hash FROM sessions
            JOIN users ON users.id = sessions.user_id
            WHERE sessions.token_hash = ? AND sessions.expires_at > ?
        `, [tokenHash, Date.now()]);
        if (!session) {
            await store.run('DELETE FROM sessions WHERE token_hash = ?', [tokenHash]);
            return res.status(401).json({ error: 'Your session has expired. Please log in again.' });
        }
        req.user = session;
        req.tokenHash = tokenHash;
        next();
    }

    function role(required) {
        return (req, res, next) => req.user.role === required
            ? next()
            : res.status(403).json({ error: `A ${required} account is required for this action.` });
    }

    async function walletAdmin(req, res, next) {
        try {
            const admin = await store.get('SELECT user_id FROM wallet_admins WHERE user_id = ?', [req.user.id]);
            if (!admin) return res.status(403).json({ error: 'A wallet administrator account is required.' });
            next();
        } catch (error) {
            next(error);
        }
    }

    async function adminPageAuth(req, res, next) {
        const header = req.headers.authorization || '';
        const bearer = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
        const token = bearer || cookies(req.headers.cookie)[COOKIE];
        if (!token || !/^[a-f0-9]{64}$/.test(token)) {
            return res.redirect('/admin-signin.html');
        }
        try {
            const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
            const session = await store.get(`
                SELECT users.*, sessions.token_hash FROM sessions
                JOIN users ON users.id = sessions.user_id
                WHERE sessions.token_hash = ? AND sessions.expires_at > ?
            `, [tokenHash, Date.now()]);
            if (!session) return res.redirect('/admin-signin.html');
            const admin = await store.get('SELECT user_id FROM wallet_admins WHERE user_id = ?', [session.id]);
            if (!admin) return res.status(404).type('text/plain').send('Not found.');
            req.user = session;
            req.tokenHash = tokenHash;
            next();
        } catch (error) {
            next(error);
        }
    }

    async function createWallet(userId) {
        let account = await store.get('SELECT * FROM wallet_accounts WHERE user_id = ?', [userId]);
        if (account?.status === 'active') return account;
        if (account?.status === 'closed') throw walletError('Your wallet is closed. Reopen it from this page first.', 409);
        const now = new Date().toISOString();
        for (let attempt = 0; attempt < 3; attempt++) {
            const walletId = `KF${crypto.randomBytes(6).toString('hex').toUpperCase()}`;
            try {
                await store.run(`
                    INSERT INTO wallet_accounts (user_id, wallet_id, balance_cents, currency, status, created_at, updated_at)
                    VALUES (?, ?, 0, 'KES', 'active', ?, ?)
                    ON CONFLICT (user_id) DO NOTHING
                `, [userId, walletId, now, now]);
                account = await store.get('SELECT * FROM wallet_accounts WHERE user_id = ?', [userId]);
                if (account) return account;
            } catch (error) {
                if (error.errcode !== 2067) throw error;
            }
        }
        throw new Error('Could not initialize a unique wallet ID. Try again.');
    }

    async function getActiveWallet(userId) {
        const account = await store.get('SELECT * FROM wallet_accounts WHERE user_id = ?', [userId]);
        if (!account) throw walletError('Create a KITUI FARM Wallet to continue.', 409);
        if (account.status !== 'active') throw walletError('Your wallet is closed. Reopen it to continue.', 409);
        return account;
    }

    function walletError(message, status) {
        const error = new Error(message);
        error.status = status;
        return error;
    }

    async function addDeliveryUpdate(orderId, status, note, userId) {
        await store.run(`INSERT INTO order_delivery_updates (id, order_id, status, note, updated_by, created_at)
            VALUES (?, ?, ?, ?, ?, ?)`,
        [crypto.randomUUID(), orderId, status, text(note, 500), userId || null, new Date().toISOString()]);
    }

    async function reverseWalletSale(order, actorId) {
        const items = await store.all(`SELECT farmer_id, SUM(quantity * price) AS total
            FROM order_items WHERE order_id = ? AND farmer_id <> '' GROUP BY farmer_id`, [order.id]);
        const now = new Date().toISOString();
        for (const item of items) {
            const reference = `checkout:${order.checkout_key}:seller:${item.farmer_id}`;
            const sale = await store.get('SELECT id FROM wallet_transactions WHERE reference_key = ?', [reference]);
            // Older orders may predate seller wallet credits; only reverse proceeds actually credited.
            if (!sale) continue;
            const cents = Math.round(Number(item.total) * 100);
            const debited = await store.run(`UPDATE wallet_accounts SET balance_cents = balance_cents - ?, updated_at = ?
                WHERE user_id = ? AND status = 'active' AND balance_cents >= ?`,
            [cents, now, item.farmer_id, cents]);
            if (!debited.changes) {
                throw walletError('The farmer’s wallet no longer has enough available funds to reverse this sale. Contact customer service for help with cancellation.', 409);
            }
            await store.run(`INSERT INTO wallet_transactions
                (id, user_id, kind, event_type, amount_cents, reference_key, description, created_by, created_at, status, channel)
                VALUES (?, ?, 'debit', 'sale_reversal', ?, ?, ?, ?, ?, 'completed', 'wallet')`,
            [crypto.randomUUID(), item.farmer_id, cents, `sale-reversal:${order.id}:${item.farmer_id}`,
                `Reversal for cancelled order ${order.id}`, actorId, now]);
        }
        const refunded = await store.run(`UPDATE wallet_accounts SET balance_cents = balance_cents + ?, updated_at = ?
            WHERE user_id = ? AND status = 'active' AND balance_cents <= ?`,
        [Math.round(Number(order.total) * 100), now, order.buyer_id, 2147483647 - Math.round(Number(order.total) * 100)]);
        if (!refunded.changes) throw walletError('The buyer wallet cannot accept this refund right now.', 409);
        await store.run(`INSERT INTO wallet_transactions
            (id, user_id, kind, event_type, amount_cents, reference_key, description, created_by, created_at, status, channel)
            VALUES (?, ?, 'credit', 'refund', ?, ?, ?, ?, ?, 'completed', 'wallet')`,
        [crypto.randomUUID(), order.buyer_id, Math.round(Number(order.total) * 100), `refund:${order.id}`,
            `Refund for cancelled order ${order.id}`, actorId, now]);
    }

    app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

    app.get('/api/location/reverse', auth, async (req, res, next) => {
        try {
            const latitude = Number(req.query.lat);
            const longitude = Number(req.query.lon);
            if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90
                || !Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
                return res.status(400).json({ error: 'A valid current location is required.' });
            }
            const now = Date.now();
            const previous = reverseGeocodeUsers.get(req.user.id) || 0;
            if (now - previous < 5000) return res.status(429).json({ error: 'Please wait a moment before checking your location again.' });
            reverseGeocodeUsers.set(req.user.id, now);
            const key = `${latitude.toFixed(4)},${longitude.toFixed(4)}`;
            if (reverseGeocodeCache.has(key)) return res.json({ location: reverseGeocodeCache.get(key), attribution: '© OpenStreetMap contributors' });

            const lookup = async () => {
                if (reverseGeocodeCache.has(key)) return reverseGeocodeCache.get(key);
                const waitMs = Math.max(0, 1000 - (Date.now() - lastReverseGeocodeAt));
                if (waitMs) await new Promise(resolve => setTimeout(resolve, waitMs));
                lastReverseGeocodeAt = Date.now();
                const url = new URL(process.env.REVERSE_GEOCODER_URL || 'https://nominatim.openstreetmap.org/reverse');
                url.search = new URLSearchParams({ format: 'jsonv2', lat: String(latitude), lon: String(longitude), zoom: '16', addressdetails: '1', layer: 'address' }).toString();
                const response = await fetch(url, {
                    headers: {
                        Accept: 'application/json',
                        'User-Agent': 'KITUI FARM/1.0 (https://monte-gg.github.io/kitui-farm/; customer service 0114 583 373)'
                    },
                    signal: AbortSignal.timeout(8000)
                });
                if (!response.ok) throw new Error('Could not identify your nearby area. Enter the area manually and try again later.');
                const place = await response.json();
                const address = place.address || {};
                const locality = address.neighbourhood || address.suburb || address.residential || address.quarter || address.city_district
                    || address.village || address.hamlet || address.town || address.city || '';
                const town = address.city || address.town || address.municipality || address.county || '';
                const location = locality && town && locality.toLowerCase() !== town.toLowerCase()
                    ? `${locality}, ${town}` : locality || town;
                if (!location) throw new Error('No nearby town or neighbourhood name was found. Enter your area manually.');
                reverseGeocodeCache.set(key, location);
                if (reverseGeocodeCache.size > 1000) reverseGeocodeCache.delete(reverseGeocodeCache.keys().next().value);
                return location;
            };
            const request = reverseGeocodeQueue.then(lookup, lookup);
            reverseGeocodeQueue = request.then(() => undefined, () => undefined);
            const location = await request;
            res.json({ location, attribution: '© OpenStreetMap contributors' });
        } catch (error) {
            if (error.name === 'TimeoutError' || error.name === 'AbortError') {
                return res.status(504).json({ error: 'Location lookup timed out. Enter your area manually and try again.' });
            }
            if (error.message?.startsWith('Could not identify') || error.message?.startsWith('No nearby')) {
                return res.status(502).json({ error: error.message });
            }
            next(error);
        }
    });

    app.post('/api/auth/signup', async (req, res, next) => {
        const name = text(req.body?.name, 100);
        const email = text(req.body?.email, 254).toLowerCase();
        const phone = normalizedPhone(req.body?.phone);
        const { role: accountRole, password } = req.body || {};
        if (name.length < 2) return res.status(400).json({ error: 'Enter your full name.' });
        if (!emailIsValid(email)) return res.status(400).json({ error: 'Enter a valid @gmail.com address.' });
        if (!phone) return res.status(400).json({ error: 'Enter a valid Kenyan phone number.' });
        if (!['buyer', 'farmer'].includes(accountRole)) return res.status(400).json({ error: 'Choose buyer or farmer as your account type.' });
        if (typeof password !== 'string' || password.length < 8 || password.length > 128) {
            return res.status(400).json({ error: 'Password must be at least 8 characters.' });
        }
        const now = Date.now();
        const attempt = signupAttempts.get(req.ip) || { count: 0, resetAt: now + 15 * 60 * 1000 };
        if (attempt.resetAt <= now) { attempt.count = 0; attempt.resetAt = now + 15 * 60 * 1000; }
        if (attempt.count >= 5) return res.status(429).json({ error: 'Too many verification emails requested. Try again in 15 minutes.' });
        attempt.count++;
        signupAttempts.set(req.ip, attempt);
        try {
            await store.run('DELETE FROM pending_signups WHERE expires_at <= ?', [now]);
            const existing = await store.get('SELECT id FROM users WHERE email = ? OR phone = ?', [email, phone]);
            if (existing) return res.status(409).json({ error: 'An account already exists with this email or phone number.' });
            const pendingPhone = await store.get('SELECT email FROM pending_signups WHERE phone = ? AND email <> ? AND expires_at > ?', [phone, email, now]);
            if (pendingPhone) return res.status(409).json({ error: 'A signup is already awaiting verification with this phone number.' });
            const priorPending = await store.get('SELECT created_at FROM pending_signups WHERE email = ?', [email]);
            if (priorPending && now - new Date(priorPending.created_at).getTime() < 60000) {
                return res.status(429).json({ error: 'A verification email was just sent. Check your inbox or wait one minute before requesting another.' });
            }
            const salt = crypto.randomBytes(16);
            const passwordHash = crypto.scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
            const rawToken = crypto.randomBytes(32).toString('hex');
            const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
            const expiresAt = now + 24 * 60 * 60 * 1000;
            const createdAt = new Date(now).toISOString();
            await store.run('DELETE FROM pending_signups WHERE email = ?', [email]);
            await store.run(`
                INSERT INTO pending_signups (email, name, phone, role, password_salt, password_hash, remember, token_hash, expires_at, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `, [email, name, phone, accountRole, salt.toString('hex'), passwordHash.toString('hex'), req.body.remember ? 1 : 0,
                tokenHash, expiresAt, createdAt]);
            try {
                await sendSignupVerification({ email, name, token: rawToken, baseUrl: appBaseUrl(req) });
            } catch (error) {
                await store.run('DELETE FROM pending_signups WHERE email = ? AND token_hash = ?', [email, tokenHash]);
                throw error;
            }
            res.status(202).json({ verificationRequired: true, email });
        } catch (error) {
            if (error.errcode === 2067) {
                return res.status(409).json({ error: 'An account already exists with this email or phone number.' });
            }
            if (error.status) return res.status(error.status).json({ error: error.message });
            next(error);
        }
    });

    app.post('/api/auth/resend-verification', async (req, res, next) => {
        const email = text(req.body?.email, 254).toLowerCase();
        if (!emailIsValid(email)) return res.status(400).json({ error: 'Enter a valid @gmail.com address.' });
        const now = Date.now();
        const attempt = signupAttempts.get(req.ip) || { count: 0, resetAt: now + 15 * 60 * 1000 };
        if (attempt.resetAt <= now) { attempt.count = 0; attempt.resetAt = now + 15 * 60 * 1000; }
        if (attempt.count >= 5) return res.status(429).json({ error: 'Too many verification emails requested. Try again in 15 minutes.' });
        attempt.count++;
        signupAttempts.set(req.ip, attempt);
        try {
            const pending = await store.get('SELECT * FROM pending_signups WHERE email = ? AND expires_at > ?', [email, now]);
            if (!pending) return res.status(404).json({ error: 'No unverified signup was found for this Gmail address. Start signup again.' });
            if (now - new Date(pending.created_at).getTime() < 60000) {
                return res.status(429).json({ error: 'A verification email was just sent. Wait one minute before requesting another.' });
            }
            const rawToken = crypto.randomBytes(32).toString('hex');
            const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
            const createdAt = new Date(now).toISOString();
            await store.run('UPDATE pending_signups SET token_hash = ?, expires_at = ?, created_at = ? WHERE email = ?',
                [tokenHash, now + 24 * 60 * 60 * 1000, createdAt, email]);
            await sendSignupVerification({ email: pending.email, name: pending.name, token: rawToken, baseUrl: appBaseUrl(req), resent: true });
            res.json({ verificationRequired: true, email });
        } catch (error) {
            if (error.status) return res.status(error.status).json({ error: error.message });
            next(error);
        }
    });

    app.post('/api/auth/verify-email', async (req, res, next) => {
        const rawToken = text(req.body?.token, 128);
        if (!/^[a-f0-9]{64}$/i.test(rawToken)) return res.status(400).json({ error: 'This verification link is invalid or incomplete.' });
        const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
        try {
            const pending = await store.get('SELECT * FROM pending_signups WHERE token_hash = ? AND expires_at > ?', [tokenHash, Date.now()]);
            if (!pending) return res.status(400).json({ error: 'This verification link has expired or was already used. Request a new link.' });
            const id = crypto.randomUUID();
            const createdAt = new Date().toISOString();
            await store.transaction(async () => {
                const stillPending = await store.get('SELECT email FROM pending_signups WHERE token_hash = ? AND expires_at > ?', [tokenHash, Date.now()]);
                if (!stillPending) throw walletError('This verification link has expired or was already used. Request a new link.', 400);
                await store.run(`
                    INSERT INTO users (id, name, email, phone, role, password_salt, password_hash, created_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                `, [id, pending.name, pending.email, pending.phone, pending.role, pending.password_salt, pending.password_hash, createdAt]);
                await store.run('DELETE FROM pending_signups WHERE token_hash = ?', [tokenHash]);
            });
            const user = await store.get('SELECT * FROM users WHERE id = ?', [id]);
            const sessionToken = await createSession(user, res, Boolean(pending.remember));
            try {
                await sendWelcomeEmail({
                    email: pending.email,
                    name: pending.name,
                    role: pending.role,
                    baseUrl: appBaseUrl(req)
                });
            } catch (emailError) {
                console.error('[welcome-email] Delivery failed after account creation', {
                    status: Number.isInteger(emailError.status) ? emailError.status : 502
                });
            }
            res.status(201).json({ user: publicUser(user), token: sessionToken, remember: Boolean(pending.remember) });
        } catch (error) {
            if (error.errcode === 2067) return res.status(409).json({ error: 'An account already exists with this email or phone number. Please sign in.' });
            if (error.status) return res.status(error.status).json({ error: error.message });
            next(error);
        }
    });

    app.post('/api/auth/login', async (req, res, next) => {
        const now = Date.now();
        const attempt = attempts.get(req.ip) || { count: 0, resetAt: now + 15 * 60 * 1000 };
        if (attempt.resetAt <= now) {
            attempt.count = 0;
            attempt.resetAt = now + 15 * 60 * 1000;
        }
        if (attempt.count >= 20) return res.status(429).json({ error: 'Too many sign-in attempts. Try again in 15 minutes.' });
        try {
            const identifier = text(req.body?.identifier, 254);
            const phone = normalizedPhone(identifier);
            const user = await store.get('SELECT * FROM users WHERE email = ? OR phone = ?',
                [identifier.toLowerCase(), phone || identifier]);
            let valid = false;
            if (user && typeof req.body?.password === 'string' && req.body.password.length <= 128) {
                const actual = crypto.scryptSync(req.body.password, Buffer.from(user.password_salt, 'hex'), 64,
                    { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
                const expected = Buffer.from(user.password_hash, 'hex');
                valid = actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
            }
            if (!valid) {
                attempt.count++;
                attempts.set(req.ip, attempt);
                return res.status(401).json({ error: 'Email/phone or password is incorrect.' });
            }
            attempts.delete(req.ip);
            const token = await createSession(user, res, Boolean(req.body.remember));
            res.json({ user: publicUser(user), token });
        } catch (error) {
            next(error);
        }
    });

    app.post('/api/admin/registration/start', (req, res) => {
        const now = Date.now();
        const attempt = adminRegistrationAttempts.get(req.ip) || { count: 0, resetAt: now + 15 * 60 * 1000 };
        if (attempt.resetAt <= now) { attempt.count = 0; attempt.resetAt = now + 15 * 60 * 1000; }
        if (attempt.count >= 5) return res.status(429).json({ error: 'Too many registration-code attempts. Try again in 15 minutes.' });
        const configuredCode = text(process.env.ADMIN_REGISTRATION_CODE || '0987', 4);
        const provided = Buffer.from(text(req.body?.code, 4));
        const expected = Buffer.from(configuredCode);
        const codeMatches = /^[0-9]{4}$/.test(configuredCode)
            && provided.length === expected.length && crypto.timingSafeEqual(provided, expected);
        if (!codeMatches) {
            attempt.count++;
            adminRegistrationAttempts.set(req.ip, attempt);
            return res.status(401).json({ error: 'The security code is incorrect.' });
        }
        adminRegistrationAttempts.delete(req.ip);
        const grant = crypto.randomBytes(32).toString('hex');
        adminRegistrationGrants.set(crypto.createHash('sha256').update(grant).digest('hex'), now + 10 * 60 * 1000);
        res.json({ registrationToken: grant, expiresInSeconds: 600 });
    });

    app.post('/api/admin/registration/complete', async (req, res, next) => {
        const grant = text(req.body?.registrationToken, 128);
        const grantHash = /^[a-f0-9]{64}$/i.test(grant) ? crypto.createHash('sha256').update(grant).digest('hex') : '';
        const expiresAt = grantHash ? adminRegistrationGrants.get(grantHash) : 0;
        if (!expiresAt || expiresAt <= Date.now()) {
            if (grantHash) adminRegistrationGrants.delete(grantHash);
            return res.status(401).json({ error: 'Admin registration access expired. Enter the security code again.' });
        }
        const name = text(req.body?.name, 100);
        const email = text(req.body?.email, 254).toLowerCase();
        const password = req.body?.password;
        if (name.length < 2 || !emailIsValid(email) || typeof password !== 'string' || password.length < 8 || password.length > 128) {
            return res.status(400).json({ error: 'Enter your name, a valid Gmail address, and a password of at least 8 characters.' });
        }
        try {
            const existing = await store.get('SELECT id FROM users WHERE lower(trim(email)) = lower(?)', [email]);
            if (existing) return res.status(409).json({ error: 'An account already uses this Gmail. Sign in to it or register with a different email.' });
            const id = crypto.randomUUID();
            const phone = `ADMIN-${crypto.randomUUID()}`;
            const salt = crypto.randomBytes(16);
            const passwordHash = crypto.scryptSync(password, salt, 64,
                { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
            const createdAt = new Date().toISOString();
            await store.transaction(async () => {
                await store.run(`INSERT INTO users (id, name, email, phone, role, password_salt, password_hash, created_at)
                    VALUES (?, ?, ?, ?, 'buyer', ?, ?, ?)`,
                [id, name, email, phone, salt.toString('hex'), passwordHash.toString('hex'), createdAt]);
                await store.run('INSERT INTO wallet_admins (user_id, created_at) VALUES (?, ?)', [id, createdAt]);
            });
            adminRegistrationGrants.delete(grantHash);
            try {
                await sendAdminWelcomeEmail({ email, name, baseUrl: appBaseUrl(req) });
            } catch (emailError) {
                console.error('[admin-welcome-email] Delivery failed after admin account creation', {
                    status: Number.isInteger(emailError.status) ? emailError.status : 502
                });
            }
            res.status(201).json({ registered: true });
        } catch (error) {
            if (error.errcode === 2067 || error.code === '23505') {
                return res.status(409).json({ error: 'An account already uses this Gmail. Sign in to it or register with a different email.' });
            }
            next(error);
        }
    });

    app.post('/api/admin/login', async (req, res, next) => {
        const now = Date.now();
        const attempt = adminAttempts.get(req.ip) || { count: 0, resetAt: now + 15 * 60 * 1000 };
        if (attempt.resetAt <= now) {
            attempt.count = 0;
            attempt.resetAt = now + 15 * 60 * 1000;
        }
        if (attempt.count >= 5) return res.status(429).json({ error: 'Too many admin sign-in attempts. Try again in 15 minutes.' });
        try {
            const name = text(req.body?.name, 100).trim().toLowerCase();
            const email = text(req.body?.email, 254).trim().toLowerCase();
            const password = req.body?.password;
            const user = name.length >= 2 && emailIsValid(email) && typeof password === 'string' && password.length <= 128
                ? await store.get('SELECT * FROM users WHERE lower(trim(email)) = ?', [email])
                : null;
            const admin = user ? await store.get('SELECT user_id FROM wallet_admins WHERE user_id = ?', [user.id]) : null;
            const nameMatches = Boolean(user && user.name.trim().toLowerCase() === name);
            let passwordMatches = false;
            if (user && typeof password === 'string') {
                const actual = crypto.scryptSync(password, Buffer.from(user.password_salt, 'hex'), 64,
                    { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
                const expected = Buffer.from(user.password_hash, 'hex');
                passwordMatches = actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
            }
            if (!user || !admin || !nameMatches || !passwordMatches) {
                attempt.count++;
                adminAttempts.set(req.ip, attempt);
                return res.status(401).json({ error: 'The details could not be verified for an enabled admin account.' });
            }
            adminAttempts.delete(req.ip);
            const token = await createSession(user, res, true);
            res.json({ user: { ...publicUser(user), role: 'admin' }, token });
        } catch (error) {
            next(error);
        }
    });

    app.post('/api/admin/welcome-email/resend', auth, walletAdmin, async (req, res, next) => {
        try {
            const account = await store.get('SELECT name, email FROM users WHERE id = ?', [req.user.id]);
            if (!account?.email) return res.status(404).json({ error: 'The admin account email could not be found.' });
            await sendAdminWelcomeEmail({ email: account.email, name: account.name, baseUrl: appBaseUrl(req) });
            res.json({ sent: true, email: account.email });
        } catch (error) {
            console.error('[admin-welcome-email] Resend failed', {
                status: Number.isInteger(error.status) ? error.status : 502
            });
            if (error.status) return res.status(error.status).json({ error: error.message });
            next(error);
        }
    });

    app.post('/api/auth/logout', auth, async (req, res) => {
        await store.run('DELETE FROM sessions WHERE token_hash = ?', [req.tokenHash]);
        res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secureCookie}`);
        res.status(204).end();
    });
    app.get('/api/auth/me', auth, (req, res) => res.json({ user: publicUser(req.user) }));

    app.delete('/api/account', auth, async (req, res, next) => {
        const password = req.body?.password;
        if (req.body?.confirmation !== 'DELETE') {
            return res.status(400).json({ error: 'Type DELETE to confirm account removal.' });
        }
        if (typeof password !== 'string' || !password || password.length > 128) {
            return res.status(400).json({ error: 'Enter your account password to confirm deletion.' });
        }
        try {
            const account = await store.get('SELECT * FROM users WHERE id = ?', [req.user.id]);
            if (!account) return res.status(401).json({ error: 'Your account is no longer available. Please sign in again.' });
            const actual = crypto.scryptSync(password, Buffer.from(account.password_salt, 'hex'), 64,
                { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
            const expected = Buffer.from(account.password_hash, 'hex');
            if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) {
                return res.status(401).json({ error: 'The password is incorrect. Your account was not deleted.' });
            }

            await store.transaction(async () => {
                // Keep other users' wallet records valid if this account approved or created them.
                await store.run('UPDATE wallet_operations SET reviewed_by = NULL WHERE reviewed_by = ?', [account.id]);
                await store.run('UPDATE wallet_transactions SET created_by = NULL WHERE created_by = ?', [account.id]);

                if (account.role === 'buyer') {
                    await store.run(`DELETE FROM order_items WHERE order_id IN
                        (SELECT id FROM orders WHERE buyer_id = ?)`, [account.id]);
                    await store.run('DELETE FROM orders WHERE buyer_id = ?', [account.id]);
                    await store.run('DELETE FROM checkout_requests WHERE buyer_id = ?', [account.id]);
                } else {
                    await store.run('DELETE FROM listings WHERE farmer_id = ?', [account.id]);
                    // Preserve other buyers' order history while removing the deleted farmer's identity.
                    await store.run(`UPDATE order_items SET farmer_id = '', seller_name = 'Deleted farmer', location = ''
                        WHERE farmer_id = ?`, [account.id]);
                }

                await store.run('DELETE FROM sessions WHERE user_id = ?', [account.id]);
                const deleted = await store.run('DELETE FROM users WHERE id = ?', [account.id]);
                if (!deleted.changes) throw new Error('The account could not be deleted.');
            });

            let emailSent = true;
            try {
                await sendSelfDeletionEmail({ email: account.email, name: account.name });
            } catch (emailError) {
                emailSent = false;
                console.error('[account-deletion-email] Self-deletion notice could not be sent', {
                    name: emailError.name || 'Error', status: emailError.status || 0
                });
            }

            res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secureCookie}`);
            res.json({ deleted: true, emailSent });
        } catch (error) {
            next(error);
        }
    });
    app.get('/api/profile', auth, (req, res) => res.json({ user: publicUser(req.user) }));

    app.patch('/api/profile', auth, async (req, res, next) => {
        const patch = req.body;
        if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return res.status(400).json({ error: 'A profile object is required.' });
        const fields = [];
        const values = [];
        if ('name' in patch) {
            const name = text(patch.name, 100);
            if (name.length < 2) return res.status(400).json({ error: 'Enter your full name.' });
            fields.push('name = ?'); values.push(name);
        }
        if ('email' in patch) {
            const email = text(patch.email, 254).toLowerCase();
            if (!emailIsValid(email)) return res.status(400).json({ error: 'Enter a valid @gmail.com address.' });
            fields.push('email = ?'); values.push(email);
        }
        if ('phone' in patch) {
            const phone = normalizedPhone(patch.phone);
            if (!phone) return res.status(400).json({ error: 'Enter a valid Kenyan phone number.' });
            fields.push('phone = ?'); values.push(phone);
        }
        if ('location' in patch) {
            fields.push('location = ?'); values.push(text(patch.location, 160));
        }
        if ('gender' in patch) {
            const gender = text(patch.gender, 24).toLowerCase();
            if (!['', 'female', 'male', 'non-binary', 'other'].includes(gender)) {
                return res.status(400).json({ error: 'Choose a valid gender option.' });
            }
            fields.push('gender = ?'); values.push(gender);
        }
        if ('profilePhoto' in patch) {
            const photo = patch.profilePhoto;
            if (typeof photo !== 'string' || photo.length > 400000 || (photo && !/^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(photo))) {
                return res.status(400).json({ error: 'Choose a valid JPG, PNG, or WebP profile photo.' });
            }
            fields.push('profile_photo = ?'); values.push(photo);
        }
        if (!fields.length) return res.status(400).json({ error: 'No supported profile fields were supplied.' });
        try {
            await store.run(`UPDATE users SET ${fields.join(', ')} WHERE id = ?`, [...values, req.user.id]);
            if (req.user.role === 'farmer' && 'name' in patch) {
                await store.run('UPDATE listings SET seller_name = ? WHERE farmer_id = ?', [text(patch.name, 100), req.user.id]);
            }
            if (req.user.role === 'farmer' && 'location' in patch) {
                await store.run('UPDATE listings SET location = ? WHERE farmer_id = ?', [text(patch.location, 160), req.user.id]);
            }
            res.json({ user: publicUser(await store.get('SELECT * FROM users WHERE id = ?', [req.user.id])) });
        } catch (error) {
            if (error.errcode === 2067) return res.status(409).json({ error: 'That email or phone number is already in use.' });
            next(error);
        }
    });

    app.get('/api/settings', auth, async (req, res) => {
        const row = await store.get('SELECT settings_json FROM user_settings WHERE user_id = ?', [req.user.id]);
        res.json({ settings: row ? JSON.parse(row.settings_json) : DEFAULT_SETTINGS });
    });
    app.put('/api/settings', auth, async (req, res) => {
        const value = req.body;
        if (!value || typeof value !== 'object' || Array.isArray(value)
            || !['system', 'light', 'dark'].includes(value.theme)
            || !['comfortable', 'compact'].includes(value.density)
            || typeof value.confirmDeletes !== 'boolean') {
            return res.status(400).json({ error: 'Settings contain an unsupported value.' });
        }
        const settings = { theme: value.theme, density: value.density, confirmDeletes: value.confirmDeletes };
        await store.run(`
            INSERT INTO user_settings (user_id, settings_json) VALUES (?, ?)
            ON CONFLICT(user_id) DO UPDATE SET settings_json = excluded.settings_json
        `, [req.user.id, JSON.stringify(settings)]);
        res.json({ settings });
    });

    app.get('/api/wallet', auth, async (req, res, next) => {
        try {
            const [account, transactions, operations, admin, paymentMethods] = await Promise.all([
                store.get('SELECT * FROM wallet_accounts WHERE user_id = ?', [req.user.id]),
                store.all(`SELECT id, kind, event_type, amount_cents, description, status, channel,
                    counterparty_wallet_id, operation_id, created_at FROM wallet_transactions
                    WHERE user_id = ? ORDER BY created_at DESC LIMIT 50`, [req.user.id]),
                store.all(`SELECT id, kind, amount_cents, fee_cents, currency, channel, details_json,
                    payment_reference, status, created_at, updated_at FROM wallet_operations
                    WHERE user_id = ? AND kind IN ('deposit', 'withdrawal') ORDER BY created_at DESC LIMIT 30`, [req.user.id]),
                store.get('SELECT user_id FROM wallet_admins WHERE user_id = ?', [req.user.id]),
                store.all('SELECT id, kind, label, details_json, use_for, created_at FROM wallet_payment_methods WHERE user_id = ? ORDER BY created_at DESC', [req.user.id])
            ]);
            res.json({
                wallet: account ? { id: account.wallet_id, balance: Number(account.balance_cents) / 100, currency: account.currency, status: account.status, createdAt: account.created_at } : null,
                transactions: transactions.map(row => ({
                    id: row.id, type: row.event_type, direction: row.kind, amount: Number(row.amount_cents) / 100,
                    description: row.description, status: row.status, channel: row.channel,
                    counterpartyWalletId: row.counterparty_wallet_id || '', operationId: row.operation_id || '', createdAt: row.created_at
                })),
                operations: operations.map(row => ({
                    id: row.id, type: row.kind, amount: Number(row.amount_cents) / 100, fee: Number(row.fee_cents) / 100,
                    currency: row.currency, channel: row.channel, details: JSON.parse(row.details_json || '{}'),
                    paymentReference: row.payment_reference || '', status: row.status, createdAt: row.created_at, updatedAt: row.updated_at
                })),
                isAdmin: Boolean(admin),
                paymentMethods: paymentMethods.filter(row => row.kind !== 'airtel').map(row => ({ id: row.id, kind: row.kind, label: row.label, details: JSON.parse(row.details_json || '{}'), useFor: row.use_for, createdAt: row.created_at }))
            });
        } catch (error) { next(error); }
    });

    app.get('/api/wallet/mpesa/config', auth, (req, res) => {
        try { const config = mpesaConfig(); res.json({ stkEnabled: true, mode: config.mode }); }
        catch (error) { res.json({ stkEnabled: false, mode: String(process.env.MPESA_ENV || 'sandbox').trim().toLowerCase() }); }
    });

    app.get('/api/wallet/paystack/config', auth, (req, res) => {
        try { paystackConfig(); res.json({ bankTransferEnabled: true }); }
        catch { res.json({ bankTransferEnabled: false }); }
    });

    app.post('/api/paystack/webhook', async (req, res) => {
        let config;
        try { config = paystackConfig(); } catch { return res.status(503).send('Webhook not configured.'); }
        if (!validPaystackWebhookSignature(req, config)) return res.status(401).send('Invalid signature.');
        try {
            const event = req.body;
            const data = event?.data || {};
            const reference = text(data.reference, 120);
            if (!reference) return res.sendStatus(200);
            const operation = await store.get("SELECT * FROM wallet_operations WHERE kind = 'deposit' AND channel = 'paystack_pesalink' AND payment_reference = ?", [reference]);
            if (!operation || operation.status !== 'processing') return res.sendStatus(200);
            const details = JSON.parse(operation.details_json || '{}');
            const now = new Date().toISOString();
            if (event.event === 'bank.transfer.rejected') {
                details.paystackResult = text(data.gateway_response || data.message || 'Bank transfer rejected.', 240);
                await store.run("UPDATE wallet_operations SET status = 'failed', details_json = ?, updated_at = ? WHERE id = ? AND status = 'processing'", [JSON.stringify(details), now, operation.id]);
                return res.sendStatus(200);
            }
            if (event.event !== 'charge.success') return res.sendStatus(200);
            const verified = await paystackRequest(`/transaction/verify/${encodeURIComponent(reference)}`, { config });
            const paid = verified.data || {};
            if (paid.status !== 'success') return res.sendStatus(200);
            const verifiedReference = text(paid.reference, 120);
            const amountMatches = Number(paid.amount) === Number(operation.amount_cents);
            if (verifiedReference !== reference || paid.currency !== 'KES' || !amountMatches) {
                details.paystackReview = 'Paystack reported a successful charge that does not match the wallet deposit amount or currency.';
                details.paystackCallbackAmount = Number(paid.amount) || null;
                details.paystackCallbackCurrency = text(paid.currency, 8);
                await store.run("UPDATE wallet_operations SET status = 'pending', details_json = ?, updated_at = ? WHERE id = ? AND status = 'processing'", [JSON.stringify(details), now, operation.id]);
                return res.sendStatus(200);
            }
            await store.transaction(async () => {
                const changed = await store.run("UPDATE wallet_operations SET status = 'completed', details_json = ?, updated_at = ? WHERE id = ? AND status = 'processing'", [JSON.stringify({ ...details, paystackPaidAt: paid.paid_at || null }), now, operation.id]);
                if (!changed.changes) return;
                const credited = await store.run("UPDATE wallet_accounts SET balance_cents = balance_cents + ?, updated_at = ? WHERE user_id = ? AND status = 'active' AND balance_cents <= ?", [operation.amount_cents, now, operation.user_id, 2147483647 - operation.amount_cents]);
                if (!credited.changes) throw new Error('Active wallet was not available for Paystack credit.');
                await store.run(`INSERT INTO wallet_transactions
                    (id, user_id, kind, event_type, amount_cents, reference_key, payment_reference, description, created_by, created_at, status, channel, operation_id)
                    VALUES (?, ?, 'credit', 'deposit', ?, ?, ?, ?, ?, ?, 'completed', 'paystack_pesalink', ?)` ,
                [crypto.randomUUID(), operation.user_id, operation.amount_cents, `wallet-deposit:${operation.id}`, reference, 'Wallet deposit via Paystack Pesalink', operation.user_id, now, operation.id]);
            });
            res.sendStatus(200);
        } catch (error) {
            console.error('Paystack wallet webhook failed', error.message);
            res.status(500).send('Webhook processing failed.');
        }
    });

    app.post('/api/payments/mpesa/callback/:token', async (req, res) => {
        let config;
        try { config = mpesaConfig(); } catch { return res.status(503).json({ ResultCode: 1, ResultDesc: 'Callback is not configured.' }); }
        const receivedToken = String(req.params.token || '');
        const expectedToken = config.callbackSecret;
        const tokenMatches = receivedToken.length === expectedToken.length
            && crypto.timingSafeEqual(Buffer.from(receivedToken), Buffer.from(expectedToken));
        if (!tokenMatches) return res.status(404).json({ ResultCode: 1, ResultDesc: 'Not found.' });
        try {
            const callback = req.body?.Body?.stkCallback;
            const checkoutId = text(callback?.CheckoutRequestID, 120);
            if (!callback || !checkoutId) return res.status(400).json({ ResultCode: 1, ResultDesc: 'Invalid callback payload.' });
            const operation = await store.get("SELECT * FROM wallet_operations WHERE kind = 'deposit' AND channel = 'mpesa_stk' AND payment_reference = ?", [checkoutId]);
            if (!operation) return res.json({ ResultCode: 0, ResultDesc: 'Callback acknowledged.' });
            if (operation.status !== 'processing') return res.json({ ResultCode: 0, ResultDesc: 'Callback already handled.' });
            const details = JSON.parse(operation.details_json || '{}');
            const now = new Date().toISOString();
            if (Number(callback.ResultCode) !== 0) {
                details.mpesaResultCode = Number(callback.ResultCode);
                details.mpesaResultDescription = text(callback.ResultDesc, 240);
                await store.run("UPDATE wallet_operations SET status = 'failed', details_json = ?, updated_at = ? WHERE id = ? AND status = 'processing'", [JSON.stringify(details), now, operation.id]);
                return res.json({ ResultCode: 0, ResultDesc: 'Payment failure recorded.' });
            }
            const metadata = callback.CallbackMetadata?.Item || [];
            const valueOf = name => metadata.find(item => item.Name === name)?.Value;
            const amountCentsReceived = Math.round(Number(valueOf('Amount')) * 100);
            const receipt = text(valueOf('MpesaReceiptNumber'), 32).toUpperCase();
            const payerPhone = normalizedPhone(valueOf('PhoneNumber'));
            if (!receipt || amountCentsReceived !== Number(operation.amount_cents) || !payerPhone || payerPhone !== details.payerPhone) {
                details.mpesaCallbackReview = 'Successful Daraja callback did not match the expected amount, receipt, or phone.';
                details.mpesaReceiptNumber = receipt;
                details.mpesaCallbackAmount = Number(valueOf('Amount')) || null;
                await store.run("UPDATE wallet_operations SET status = 'pending', details_json = ?, updated_at = ? WHERE id = ? AND status = 'processing'", [JSON.stringify(details), now, operation.id]);
                return res.json({ ResultCode: 0, ResultDesc: 'Payment requires merchant review.' });
            }
            await store.transaction(async () => {
                const changed = await store.run("UPDATE wallet_operations SET status = 'completed', details_json = ?, updated_at = ? WHERE id = ? AND status = 'processing'", [JSON.stringify({ ...details, mpesaReceiptNumber: receipt, mpesaTransactionDate: valueOf('TransactionDate') || null }), now, operation.id]);
                if (!changed.changes) return;
                const credited = await store.run('UPDATE wallet_accounts SET balance_cents = balance_cents + ?, updated_at = ? WHERE user_id = ? AND status = \'active\' AND balance_cents <= ?', [operation.amount_cents, now, operation.user_id, 2147483647 - operation.amount_cents]);
                if (!credited.changes) throw new Error('Active wallet was not available for M-Pesa credit.');
                await store.run(`INSERT INTO wallet_transactions
                    (id, user_id, kind, event_type, amount_cents, reference_key, payment_reference, description, created_by, created_at, status, channel, operation_id)
                    VALUES (?, ?, 'credit', 'deposit', ?, ?, ?, ?, ?, ?, 'completed', 'mpesa_stk', ?)` ,
                [crypto.randomUUID(), operation.user_id, operation.amount_cents, `wallet-deposit:${operation.id}`, receipt, 'Wallet deposit via M-Pesa STK Push', operation.user_id, now, operation.id]);
            });
            return res.json({ ResultCode: 0, ResultDesc: 'Payment callback processed.' });
        } catch (error) {
            console.error('M-Pesa callback processing failed', error.message);
            return res.status(500).json({ ResultCode: 1, ResultDesc: 'Payment callback could not be processed.' });
        }
    });

    app.post('/api/payments/mpesa/b2c/:token/result', async (req, res) => {
        let config;
        try { config = mpesaConfig(); } catch { return res.status(503).json({ ResultCode: 1, ResultDesc: 'Callback is not configured.' }); }
        const token = String(req.params.token || '');
        if (token.length !== config.callbackSecret.length || !crypto.timingSafeEqual(Buffer.from(token), Buffer.from(config.callbackSecret))) return res.status(404).json({ ResultCode: 1, ResultDesc: 'Not found.' });
        try {
            const result = req.body?.Result;
            const originatorId = text(result?.OriginatorConversationID, 120);
            if (!result || !originatorId) return res.status(400).json({ ResultCode: 1, ResultDesc: 'Invalid B2C result payload.' });
            const operation = await store.get("SELECT * FROM wallet_operations WHERE kind = 'withdrawal' AND channel = 'mpesa_b2c' AND payment_reference = ?", [originatorId]);
            if (!operation || operation.status !== 'processing') return res.json({ ResultCode: 0, ResultDesc: 'Callback already handled or request not found.' });
            const now = new Date().toISOString();
            const details = JSON.parse(operation.details_json || '{}');
            details.mpesaB2CResultCode = Number(result.ResultCode);
            details.mpesaB2CResultDescription = text(result.ResultDesc, 240);
            details.mpesaB2CTransactionId = text(result.TransactionID, 80);
            if (Number(result.ResultCode) === 0) {
                const parameters = result.ResultParameters?.ResultParameter || [];
                const parameterValue = key => {
                    const item = (Array.isArray(parameters) ? parameters : [parameters]).find(entry => entry?.Key === key);
                    return item?.Value;
                };
                const callbackAmount = parameterValue('TransactionAmount');
                const recipientName = String(parameterValue('ReceiverPartyPublicName') || '');
                const phoneMatch = recipientName.match(/254\d{9}/);
                if (!details.mpesaB2CTransactionId || (callbackAmount != null && Math.round(Number(callbackAmount) * 100) !== Number(operation.amount_cents))
                    || (phoneMatch && phoneMatch[0] !== details.mpesaB2CRecipientPhone)) {
                    details.mpesaB2CReviewNeeded = 'Safaricom reported success, but the receipt, amount, or recipient could not be verified automatically.';
                    await store.run("UPDATE wallet_operations SET status = 'pending', details_json = ?, updated_at = ? WHERE id = ? AND status = 'processing'", [JSON.stringify(details), now, operation.id]);
                    return res.json({ ResultCode: 0, ResultDesc: 'Payout result requires merchant review.' });
                }
                await store.transaction(async () => {
                    const changed = await store.run("UPDATE wallet_operations SET status = 'completed', details_json = ?, updated_at = ? WHERE id = ? AND status = 'processing'", [JSON.stringify(details), now, operation.id]);
                    if (!changed.changes) return;
                    const finalized = await store.run("UPDATE wallet_transactions SET status = 'completed', payment_reference = ? WHERE operation_id = ? AND event_type = 'withdrawal' AND status = 'pending'", [details.mpesaB2CTransactionId || originatorId, operation.id]);
                    if (!finalized.changes) throw new Error('M-Pesa withdrawal ledger could not be finalized.');
                });
            } else {
                await store.transaction(async () => {
                    const changed = await store.run("UPDATE wallet_operations SET status = 'failed', details_json = ?, updated_at = ? WHERE id = ? AND status = 'processing'", [JSON.stringify(details), now, operation.id]);
                    if (!changed.changes) return;
                    const refunded = await store.run("UPDATE wallet_accounts SET balance_cents = balance_cents + ?, updated_at = ? WHERE user_id = ? AND status = 'active' AND balance_cents <= ?", [operation.amount_cents, now, operation.user_id, 2147483647 - operation.amount_cents]);
                    if (!refunded.changes) throw new Error('M-Pesa payout failed but the wallet could not be refunded automatically.');
                    await store.run("UPDATE wallet_transactions SET status = 'failed' WHERE operation_id = ? AND event_type = 'withdrawal' AND status = 'pending'", [operation.id]);
                    await store.run(`INSERT INTO wallet_transactions
                        (id, user_id, kind, event_type, amount_cents, reference_key, payment_reference, description, created_at, status, channel, operation_id)
                        VALUES (?, ?, 'credit', 'refund', ?, ?, ?, ?, ?, 'completed', 'internal', ?)`,
                    [crypto.randomUUID(), operation.user_id, operation.amount_cents, `wallet-withdrawal-refund:${operation.id}`, details.mpesaB2CTransactionId || originatorId,
                        'Automatic refund after M-Pesa payout failed', now, operation.id]);
                });
            }
            return res.json({ ResultCode: 0, ResultDesc: 'B2C result processed.' });
        } catch (error) {
            console.error('M-Pesa B2C result processing failed', error.message);
            return res.status(500).json({ ResultCode: 1, ResultDesc: 'B2C result could not be processed.' });
        }
    });

    app.post('/api/payments/mpesa/b2c/:token/timeout', async (req, res) => {
        let config;
        try { config = mpesaConfig(); } catch { return res.status(503).json({ ResultCode: 1, ResultDesc: 'Callback is not configured.' }); }
        const token = String(req.params.token || '');
        if (token.length !== config.callbackSecret.length || !crypto.timingSafeEqual(Buffer.from(token), Buffer.from(config.callbackSecret))) return res.status(404).json({ ResultCode: 1, ResultDesc: 'Not found.' });
        try {
            const originatorId = text(req.body?.Result?.OriginatorConversationID || req.body?.OriginatorConversationID, 120);
            if (originatorId) {
                const operation = await store.get("SELECT * FROM wallet_operations WHERE kind = 'withdrawal' AND channel = 'mpesa_b2c' AND payment_reference = ?", [originatorId]);
                if (operation?.status === 'processing') {
                    const details = JSON.parse(operation.details_json || '{}');
                    details.mpesaB2CTimeout = true;
                    details.mpesaB2CTimeoutAt = new Date().toISOString();
                    await store.run("UPDATE wallet_operations SET status = 'pending', details_json = ?, updated_at = ? WHERE id = ? AND status = 'processing'", [JSON.stringify(details), new Date().toISOString(), operation.id]);
                }
            }
            return res.json({ ResultCode: 0, ResultDesc: 'B2C timeout acknowledged.' });
        } catch (error) {
            console.error('M-Pesa B2C timeout processing failed', error.message);
            return res.status(500).json({ ResultCode: 1, ResultDesc: 'B2C timeout could not be processed.' });
        }
    });

    app.post('/api/wallet/create', auth, async (req, res, next) => {
        try {
            const wallet = await createWallet(req.user.id);
            res.status(201).json({ wallet: { id: wallet.wallet_id, balance: Number(wallet.balance_cents) / 100, currency: wallet.currency, status: wallet.status, createdAt: wallet.created_at } });
        } catch (error) { if (error.status) return res.status(error.status).json({ error: error.message }); next(error); }
    });

    app.post('/api/wallet/reopen', auth, async (req, res, next) => {
        if (req.body?.confirmation !== 'REOPEN') return res.status(400).json({ error: 'Type REOPEN to confirm wallet recovery.' });
        if (typeof req.body?.password !== 'string' || !req.body.password || req.body.password.length > 128) return res.status(400).json({ error: 'Enter your account password to reopen the wallet.' });
        try {
            const user = await store.get('SELECT * FROM users WHERE id = ?', [req.user.id]);
            const actual = crypto.scryptSync(req.body.password, Buffer.from(user.password_salt, 'hex'), 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
            const expected = Buffer.from(user.password_hash, 'hex');
            if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) return res.status(401).json({ error: 'The password is incorrect.' });
            const changed = await store.run(`UPDATE wallet_accounts SET status = 'active', updated_at = ? WHERE user_id = ? AND status = 'closed' AND balance_cents = 0 AND NOT EXISTS (SELECT 1 FROM wallet_operations WHERE user_id = ? AND status IN ('pending', 'processing'))`, [new Date().toISOString(), req.user.id, req.user.id]);
            if (!changed.changes) return res.status(409).json({ error: 'No recoverable closed wallet was found, or a pending transaction must be resolved first.' });
            res.json({ status: 'active', message: 'Your wallet has been reopened.' });
        } catch (error) { next(error); }
    });

    app.get('/api/wallet/payment-methods', auth, async (req, res, next) => {
        try {
            const rows = (await store.all('SELECT id, kind, label, details_json, use_for, created_at FROM wallet_payment_methods WHERE user_id = ? ORDER BY created_at DESC', [req.user.id])).filter(row => row.kind !== 'airtel');
            res.json({ paymentMethods: rows.map(row => ({ id: row.id, kind: row.kind, label: row.label, details: JSON.parse(row.details_json || '{}'), useFor: row.use_for, createdAt: row.created_at })) });
        } catch (error) { next(error); }
    });

    async function ownedPaymentMethod(userId, methodId, useFor) {
        const method = await store.get('SELECT * FROM wallet_payment_methods WHERE id = ? AND user_id = ?', [text(methodId, 80), userId]);
        if (!method) throw walletError('Save a payment method in Settings before requesting a deposit or payout.', 409);
        if (method.kind === 'airtel') throw walletError('Airtel Money is no longer available. Choose M-Pesa, bank transfer, or PayPal.', 409);
        if (method.use_for !== useFor && method.use_for !== 'both') throw walletError('This saved method is not enabled for that transaction.', 409);
        return method;
    }

    app.post('/api/wallet/payment-methods', auth, async (req, res, next) => {
        const kind = text(req.body?.kind, 16).toLowerCase();
        const label = text(req.body?.label, 60);
        const useFor = text(req.body?.useFor, 16).toLowerCase();
        if (!['mpesa', 'bank', 'paypal'].includes(kind)) return res.status(400).json({ error: 'Choose M-Pesa, bank, or PayPal.' });
        if (!['deposit', 'withdrawal', 'both'].includes(useFor) || (kind === 'paypal' && useFor !== 'withdrawal')) return res.status(400).json({ error: 'PayPal is currently available for withdrawals only. Choose a valid use for this method.' });
        if (!label) return res.status(400).json({ error: 'Enter a label for this payment method.' });
        const details = {};
        if (kind === 'mpesa') {
            details.phone = normalizedPhone(text(req.body?.phone, 30));
            if (!details.phone) return res.status(400).json({ error: 'Enter a valid Kenyan mobile number.' });
        } else if (kind === 'bank') {
            details.accountName = text(req.body?.accountName, 100);
            details.accountNumber = text(req.body?.accountNumber, 34);
            details.bankName = text(req.body?.bankName, 80);
            details.branch = text(req.body?.branch, 80);
            if (!details.accountName || !/^[A-Za-z0-9 -]{5,34}$/.test(details.accountNumber) || !details.bankName) return res.status(400).json({ error: 'Enter the account name, account number, and bank name.' });
        } else {
            details.email = text(req.body?.email, 254).toLowerCase();
            if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(details.email)) return res.status(400).json({ error: 'Enter a valid PayPal email address.' });
        }
        try {
            const count = await store.get('SELECT COUNT(*) AS total FROM wallet_payment_methods WHERE user_id = ?', [req.user.id]);
            if (Number(count.total) >= 10) return res.status(429).json({ error: 'You can save up to 10 payment methods.' });
            const id = crypto.randomUUID(), now = new Date().toISOString();
            await store.run('INSERT INTO wallet_payment_methods (id,user_id,kind,label,details_json,use_for,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)', [id, req.user.id, kind, label, JSON.stringify(details), useFor, now, now]);
            res.status(201).json({ paymentMethod: { id, kind, label, details, useFor, createdAt: now } });
        } catch (error) { next(error); }
    });

    app.delete('/api/wallet/payment-methods/:id', auth, async (req, res, next) => {
        try {
            const removed = await store.run('DELETE FROM wallet_payment_methods WHERE id = ? AND user_id = ?', [text(req.params.id, 80), req.user.id]);
            if (!removed.changes) return res.status(404).json({ error: 'Saved payment method not found.' });
            res.json({ removed: true });
        } catch (error) { next(error); }
    });

    app.get('/api/wallet/recipient', auth, async (req, res, next) => {
        const identifier = text(req.query?.identifier, 120);
        if (!identifier) return res.status(400).json({ error: 'Enter a wallet ID, phone number, or full name.' });
        try {
            let user;
            const phone = normalizedPhone(identifier);
            const wallet = await store.get(`
                SELECT users.id, users.name, users.role, users.phone, wallet_accounts.wallet_id, wallet_accounts.status
                FROM wallet_accounts JOIN users ON users.id = wallet_accounts.user_id
                WHERE lower(wallet_accounts.wallet_id) = lower(?)
            `, [identifier]);
            if (wallet) user = wallet;
            else if (phone) user = await store.get(`
                SELECT users.id, users.name, users.role, users.phone, wallet_accounts.wallet_id, wallet_accounts.status
                FROM users LEFT JOIN wallet_accounts ON wallet_accounts.user_id = users.id WHERE users.phone = ?
            `, [phone]);
            else {
                const matches = await store.all(`
                    SELECT users.id, users.name, users.role, users.phone, wallet_accounts.wallet_id, wallet_accounts.status
                    FROM users LEFT JOIN wallet_accounts ON wallet_accounts.user_id = users.id
                    WHERE lower(users.name) = lower(?) ORDER BY users.id ASC LIMIT 2
                `, [identifier]);
                if (matches.length > 1) return res.status(409).json({ error: 'That name matches more than one account. Use the recipient’s wallet ID or phone number.' });
                user = matches[0];
            }
            if (!user) return res.status(404).json({ error: 'No active wallet found for that recipient.' });
            if (user.id === req.user.id) return res.status(400).json({ error: 'You cannot transfer money to your own wallet.' });
            if (!user.wallet_id || user.status !== 'active') return res.status(404).json({ error: 'The recipient must create or reopen an active wallet before receiving funds.' });
            res.json({ recipient: { name: user.name, role: user.role, walletId: user.wallet_id, phone: user.phone } });
        } catch (error) { next(error); }
    });

    app.post('/api/wallet/transfers', auth, async (req, res, next) => {
        const identifier = text(req.body?.recipient, 120);
        const cents = amountCents(req.body?.amount);
        const idempotencyKey = text(req.body?.idempotencyKey, 80);
        if (!identifier) return res.status(400).json({ error: 'Enter the recipient wallet ID, phone number, or full name.' });
        if (!cents) return res.status(400).json({ error: 'Enter an amount from KES 0.01 to KES 1,000,000.00.' });
        if (!/^[A-Za-z0-9-]{16,80}$/.test(idempotencyKey)) return res.status(400).json({ error: 'Refresh the page and try the transfer again.' });
        try {
            const prior = await store.get('SELECT id, status, amount_cents, peer_wallet_id FROM wallet_operations WHERE idempotency_key = ? AND user_id = ?', [idempotencyKey, req.user.id]);
            if (prior) return res.json({ transfer: { id: prior.id, status: prior.status, amount: Number(prior.amount_cents) / 100, toWalletId: prior.peer_wallet_id } });
            let recipient;
            const phone = normalizedPhone(identifier);
            if (phone) recipient = await store.get('SELECT id FROM users WHERE phone = ?', [phone]);
            if (!recipient) recipient = await store.get(`
                SELECT users.id FROM wallet_accounts JOIN users ON users.id = wallet_accounts.user_id
                WHERE lower(wallet_accounts.wallet_id) = lower(?)
            `, [identifier]);
            if (!recipient && !phone) {
                const matches = await store.all('SELECT id FROM users WHERE lower(name) = lower(?) ORDER BY id LIMIT 2', [identifier]);
                if (matches.length > 1) return res.status(409).json({ error: 'That name matches more than one account. Use the recipient’s wallet ID or phone number.' });
                recipient = matches[0];
            }
            if (!recipient) return res.status(404).json({ error: 'Recipient account not found.' });
            if (recipient.id === req.user.id) return res.status(400).json({ error: 'You cannot transfer money to your own wallet.' });
            const operationId = crypto.randomUUID();
            const createdAt = new Date().toISOString();
            let senderWalletId = '';
            let recipientWalletId = '';
            await store.transaction(async () => {
                const sender = await getActiveWallet(req.user.id);
                const receiver = await getActiveWallet(recipient.id);
                const debited = await store.run(`
                    UPDATE wallet_accounts SET balance_cents = balance_cents - ?, updated_at = ?
                    WHERE user_id = ? AND status = 'active' AND balance_cents >= ?
                `, [cents, createdAt, req.user.id, cents]);
                if (!debited.changes) throw walletError('Your available balance is too low for this transfer.', 402);
                const credited = await store.run(`
                    UPDATE wallet_accounts SET balance_cents = balance_cents + ?, updated_at = ?
                    WHERE user_id = ? AND status = 'active' AND balance_cents <= ?
                `, [cents, createdAt, recipient.id, 2147483647 - cents]);
                if (!credited.changes) throw walletError('The recipient wallet cannot accept this amount.', 409);
                await store.run(`
                    INSERT INTO wallet_operations
                        (id, user_id, kind, amount_cents, currency, channel, details_json, status, peer_user_id, peer_wallet_id, idempotency_key, created_at, updated_at)
                    VALUES (?, ?, 'transfer', ?, 'KES', 'wallet', '{}', 'completed', ?, ?, ?, ?, ?)
                `, [operationId, req.user.id, cents, recipient.id, receiver.wallet_id, idempotencyKey, createdAt, createdAt]);
                await store.run(`
                    INSERT INTO wallet_transactions
                        (id, user_id, kind, event_type, amount_cents, reference_key, description, created_at, status, channel, counterparty_wallet_id, operation_id)
                    VALUES (?, ?, 'debit', 'transfer', ?, ?, ?, ?, 'completed', 'wallet', ?, ?)
                `, [crypto.randomUUID(), req.user.id, cents, `wallet-transfer:${operationId}:sent`, `Transfer to ${receiver.wallet_id}`, createdAt, receiver.wallet_id, operationId]);
                await store.run(`
                    INSERT INTO wallet_transactions
                        (id, user_id, kind, event_type, amount_cents, reference_key, description, created_at, status, channel, counterparty_wallet_id, operation_id)
                    VALUES (?, ?, 'credit', 'transfer', ?, ?, ?, ?, 'completed', 'wallet', ?, ?)
                `, [crypto.randomUUID(), recipient.id, cents, `wallet-transfer:${operationId}:received`, `Transfer from ${sender.wallet_id}`, createdAt, sender.wallet_id, operationId]);
                senderWalletId = sender.wallet_id;
                recipientWalletId = receiver.wallet_id;
            });
            res.status(201).json({ transfer: { id: operationId, amount: cents / 100, status: 'completed', fromWalletId: senderWalletId, toWalletId: recipientWalletId } });
        } catch (error) {
            if (error.errcode === 2067) {
                const prior = await store.get('SELECT id, status, amount_cents, peer_wallet_id FROM wallet_operations WHERE idempotency_key = ? AND user_id = ?', [idempotencyKey, req.user.id]);
                if (prior) return res.json({ transfer: { id: prior.id, amount: Number(prior.amount_cents) / 100, toWalletId: prior.peer_wallet_id, status: prior.status } });
                return res.status(409).json({ error: 'This transfer request could not be completed. Refresh and try again.' });
            }
            if (error.status) return res.status(error.status).json({ error: error.message });
            next(error);
        }
    });

    app.post('/api/wallet/deposits', auth, async (req, res, next) => {
        const cents = amountCents(req.body?.amount);
        const methodId = text(req.body?.paymentMethodId, 80);
        let channel = text(req.body?.channel, 32);
        const idempotencyKey = text(req.body?.idempotencyKey, 80);
        const allowedChannels = new Set(['mpesa_stk_simulation', 'bank_transfer']);
        if (!cents) return res.status(400).json({ error: 'Enter an amount from KES 0.01 to KES 1,000,000.00.' });
        if (!allowedChannels.has(channel)) return res.status(400).json({ error: 'Choose a supported deposit method.' });
        if (!/^[A-Za-z0-9-]{16,80}$/.test(idempotencyKey)) return res.status(400).json({ error: 'Refresh the page and try the deposit request again.' });
        const paymentReference = text(req.body?.paymentReference, 32).toUpperCase();
        if (paymentReference && !/^[A-Z0-9-]{5,32}$/.test(paymentReference)) return res.status(400).json({ error: 'Enter a valid payment reference.' });
        try {
            const prior = await store.get('SELECT id, kind, amount_cents, status, channel, payment_reference, created_at FROM wallet_operations WHERE idempotency_key = ? AND user_id = ?', [idempotencyKey, req.user.id]);
            if (prior) return res.json({ operation: { id: prior.id, type: prior.kind, amount: Number(prior.amount_cents) / 100, status: prior.status, channel: prior.channel, paymentReference: prior.payment_reference || '', createdAt: prior.created_at } });
            if (!paymentReference) return res.status(400).json({ error: 'Enter the payment receipt/reference. A real M-Pesa prompt is not connected yet.' });
            await getActiveWallet(req.user.id);
            const method = await ownedPaymentMethod(req.user.id, methodId, 'deposit');
            if (method.kind === 'paypal') return res.status(400).json({ error: 'PayPal deposits are not enabled; use PayPal only for manual payout requests.' });
            channel = method.kind === 'mpesa' ? 'mpesa_stk_simulation' : 'bank_transfer';
            const details = JSON.parse(method.details_json || '{}');
            const pending = await store.get("SELECT COUNT(*) AS total FROM wallet_operations WHERE user_id = ? AND kind = 'deposit' AND status IN ('pending', 'processing')", [req.user.id]);
            if (Number(pending.total) >= 5) return res.status(429).json({ error: 'You have several deposits awaiting review. Wait for those to be resolved first.' });
            const id = crypto.randomUUID();
            const now = new Date().toISOString();
            await store.run(`
                INSERT INTO wallet_operations
                    (id, user_id, kind, amount_cents, currency, channel, details_json, payment_reference, status, idempotency_key, created_at, updated_at)
                VALUES (?, ?, 'deposit', ?, 'KES', ?, ?, ?, 'pending', ?, ?, ?)
            `, [id, req.user.id, cents, channel, JSON.stringify(details), paymentReference || null, idempotencyKey, now, now]);
            res.status(201).json({ operation: { id, type: 'deposit', amount: cents / 100, status: 'pending', channel, paymentReference, createdAt: now } });
        } catch (error) {
            if (error.errcode === 2067) {
                const prior = await store.get('SELECT id, kind, amount_cents, status, channel, payment_reference, created_at FROM wallet_operations WHERE idempotency_key = ? AND user_id = ?', [idempotencyKey, req.user.id]);
                if (prior) return res.json({ operation: { id: prior.id, type: prior.kind, amount: Number(prior.amount_cents) / 100, status: prior.status, channel: prior.channel, paymentReference: prior.payment_reference || '', createdAt: prior.created_at } });
                return res.status(409).json({ error: 'That payment reference has already been submitted.' });
            }
            next(error);
        }
    });

    app.post('/api/wallet/paystack/deposits/bank-transfer', auth, async (req, res, next) => {
        const cents = amountCents(req.body?.amount);
        const idempotencyKey = text(req.body?.idempotencyKey, 80);
        if (!cents) return res.status(400).json({ error: 'Enter a bank deposit amount from KES 0.01 to KES 1,000,000.00.' });
        if (!/^[A-Za-z0-9-]{16,80}$/.test(idempotencyKey)) return res.status(400).json({ error: 'Refresh the page and try the bank deposit again.' });
        let config;
        try { config = paystackConfig(); } catch (error) { return res.status(error.status || 503).json({ error: error.message }); }
        try {
            const prior = await store.get('SELECT * FROM wallet_operations WHERE idempotency_key = ? AND user_id = ?', [idempotencyKey, req.user.id]);
            if (prior) {
                if (prior.kind !== 'deposit' || prior.channel !== 'paystack_pesalink' || Number(prior.amount_cents) !== cents) return res.status(409).json({ error: 'This bank deposit request key was already used. Refresh and try again.' });
                if (prior.status === 'failed') return res.status(409).json({ error: 'The previous Paystack bank deposit did not complete. Start another deposit.' });
                const details = JSON.parse(prior.details_json || '{}');
                return res.json({ operation: { id: prior.id, status: prior.status, amount: cents / 100, ...details.paystackInstructions } });
            }
            await getActiveWallet(req.user.id);
            const pending = await store.get("SELECT COUNT(*) AS total FROM wallet_operations WHERE user_id = ? AND kind = 'deposit' AND status IN ('pending', 'processing')", [req.user.id]);
            if (Number(pending.total) >= 5) return res.status(429).json({ error: 'You have several wallet deposits awaiting confirmation. Resolve those first.' });
            const user = await store.get('SELECT email FROM users WHERE id = ?', [req.user.id]);
            if (!user?.email) return res.status(409).json({ error: 'Add a verified email to your profile before using Paystack bank payments.' });
            const id = crypto.randomUUID();
            const reference = `KF${id.replaceAll('-', '').slice(0, 28)}`;
            const now = new Date().toISOString();
            const details = { paystackReference: reference };
            await store.run(`INSERT INTO wallet_operations
                (id, user_id, kind, amount_cents, fee_cents, currency, channel, details_json, payment_reference, status, idempotency_key, created_at, updated_at)
                VALUES (?, ?, 'deposit', ?, 0, 'KES', 'paystack_pesalink', ?, ?, 'processing', ?, ?, ?)`,
            [id, req.user.id, cents, JSON.stringify(details), reference, idempotencyKey, now, now]);
            try {
                const expiry = new Date(Date.now() + 25 * 60 * 1000).toISOString();
                const result = await paystackRequest('/charge', { method: 'POST', config, body: {
                    email: user.email, amount: cents, currency: 'KES', reference,
                    bank_transfer: { account_expires_at: expiry },
                    metadata: { wallet_operation_id: id, purpose: 'KITUI FARM wallet deposit' }
                } });
                const charge = result.data || {};
                if (charge.reference !== reference || charge.status !== 'pending_bank_transfer' || !charge.account_number) {
                    details.paystackResult = text(charge.display_text || result.message || 'Paystack did not return Pesalink transfer instructions.', 240);
                    await store.run("UPDATE wallet_operations SET status = 'failed', details_json = ?, updated_at = ? WHERE id = ? AND status = 'processing'", [JSON.stringify(details), new Date().toISOString(), id]);
                    return res.status(502).json({ error: details.paystackResult });
                }
                const instructions = {
                    accountName: text(charge.account_name, 120), accountNumber: text(charge.account_number, 40),
                    bankName: text(charge.bank?.name, 120), transactionReference: text(charge.transaction_reference, 80),
                    expiresAt: text(charge.account_expires_at, 40), amount: cents / 100
                };
                details.paystackInstructions = instructions;
                await store.run("UPDATE wallet_operations SET details_json = ?, updated_at = ? WHERE id = ? AND status = 'processing'", [JSON.stringify(details), new Date().toISOString(), id]);
                res.status(201).json({ operation: { id, status: 'processing', ...instructions } });
            } catch (error) {
                details.paystackInitiationError = text(error.message, 240);
                const status = error.status && error.status < 500 ? 'failed' : 'processing';
                await store.run('UPDATE wallet_operations SET status = ?, details_json = ?, updated_at = ? WHERE id = ? AND status = \'processing\'', [status, JSON.stringify(details), new Date().toISOString(), id]);
                return res.status(status === 'failed' ? 502 : 202).json({
                    operation: { id, status, amount: cents / 100 },
                    error: status === 'processing' ? 'Paystack is still processing this request. Do not submit another transfer; refresh your wallet shortly.' : 'Paystack rejected the bank deposit request. Check that Pesalink is enabled on your account.'
                });
            }
        } catch (error) {
            if (error.status) return res.status(error.status).json({ error: error.message });
            next(error);
        }
    });

    app.get('/api/wallet/paystack/deposits/:id', auth, async (req, res, next) => {
        try {
            const operation = await store.get("SELECT id, amount_cents, status, details_json, updated_at FROM wallet_operations WHERE id = ? AND user_id = ? AND kind = 'deposit' AND channel = 'paystack_pesalink'", [text(req.params.id, 80), req.user.id]);
            if (!operation) return res.status(404).json({ error: 'Paystack bank deposit not found.' });
            const details = JSON.parse(operation.details_json || '{}');
            res.json({ operation: { id: operation.id, amount: Number(operation.amount_cents) / 100, status: operation.status, ...details.paystackInstructions, message: details.paystackResult || '', updatedAt: operation.updated_at } });
        } catch (error) { next(error); }
    });

    app.post('/api/wallet/mpesa/deposits/stk', auth, async (req, res, next) => {
        const cents = amountCents(req.body?.amount);
        const phone = normalizedPhone(req.body?.phone);
        const methodId = text(req.body?.paymentMethodId, 80);
        const idempotencyKey = text(req.body?.idempotencyKey, 80);
        if (!cents || cents % 100 !== 0 || cents > 15000000) return res.status(400).json({ error: 'Enter a whole-number M-Pesa deposit between KES 1 and KES 150,000.' });
        if (!phone) return res.status(400).json({ error: 'Enter a valid Kenyan phone number to receive the M-Pesa prompt.' });
        if (!/^[A-Za-z0-9-]{16,80}$/.test(idempotencyKey)) return res.status(400).json({ error: 'Refresh the page and try the M-Pesa deposit again.' });
        let config;
        try { config = mpesaConfig(); } catch (error) { return res.status(error.status || 503).json({ error: error.message }); }
        try {
            const prior = await store.get('SELECT * FROM wallet_operations WHERE idempotency_key = ? AND user_id = ?', [idempotencyKey, req.user.id]);
            if (prior) {
                if (prior.kind !== 'deposit' || prior.channel !== 'mpesa_stk' || Number(prior.amount_cents) !== cents) return res.status(409).json({ error: 'This M-Pesa request key was already used. Refresh and try again.' });
                const priorDetails = JSON.parse(prior.details_json || '{}');
                if (prior.status === 'failed') return res.status(409).json({ error: priorDetails.mpesaResultDescription || 'The previous M-Pesa request did not complete. You can start a new deposit.' });
                return res.json({ operation: { id: prior.id, status: prior.status, amount: cents / 100, phone: priorDetails.payerPhone, message: prior.status === 'completed' ? 'Payment received and wallet credited.' : 'M-Pesa request already started. Check your phone and wait for confirmation.' } });
            }
            await getActiveWallet(req.user.id);
            const method = await ownedPaymentMethod(req.user.id, methodId, 'deposit');
            if (method.kind !== 'mpesa') return res.status(400).json({ error: 'Choose a saved M-Pesa deposit method to use STK Push.' });
            const pending = await store.get("SELECT COUNT(*) AS total FROM wallet_operations WHERE user_id = ? AND kind = 'deposit' AND status IN ('pending', 'processing')", [req.user.id]);
            if (Number(pending.total) >= 5) return res.status(429).json({ error: 'You have several deposits awaiting confirmation. Resolve those first.' });
            const id = crypto.randomUUID();
            const now = new Date().toISOString();
            const details = { payerPhone: phone, mpesaEnvironment: config.mode };
            await store.run(`INSERT INTO wallet_operations
                (id, user_id, kind, amount_cents, fee_cents, currency, channel, details_json, status, idempotency_key, created_at, updated_at)
                VALUES (?, ?, 'deposit', ?, 0, 'KES', 'mpesa_stk', ?, 'processing', ?, ?, ?)`,
            [id, req.user.id, cents, JSON.stringify(details), idempotencyKey, now, now]);

            const dateParts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
                timeZone: 'Africa/Nairobi', year: 'numeric', month: '2-digit', day: '2-digit',
                hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
            }).formatToParts(new Date()).filter(part => part.type !== 'literal').map(part => [part.type, part.value]));
            const timestamp = `${dateParts.year}${dateParts.month}${dateParts.day}${dateParts.hour}${dateParts.minute}${dateParts.second}`;
            const password = Buffer.from(`${config.shortCode}${config.passkey}${timestamp}`).toString('base64');
            let result;
            try {
                result = await mpesaRequest('/mpesa/stkpush/v1/processrequest', { config, method: 'POST', body: {
                    BusinessShortCode: config.shortCode, Password: password, Timestamp: timestamp,
                    TransactionType: config.transactionType, Amount: cents / 100,
                    PartyA: phone.slice(1), PartyB: config.shortCode, PhoneNumber: phone.slice(1),
                    CallBackURL: config.callbackUrl, AccountReference: `KF${id.replaceAll('-', '').slice(0, 10)}`,
                    TransactionDesc: 'KITUI FARM wallet deposit'
                } });
            } catch (error) {
                // Keep uncertain requests visible for reconciliation: a network
                // timeout may happen after Safaricom has already sent the prompt.
                details.mpesaInitiationError = text(error.message, 240);
                const status = error.status && error.status < 500 ? 'failed' : 'pending';
                await store.run('UPDATE wallet_operations SET status = ?, details_json = ?, updated_at = ? WHERE id = ? AND status = \'processing\'', [status, JSON.stringify(details), new Date().toISOString(), id]);
                return res.status(status === 'failed' ? 502 : 202).json({
                    operation: { id, status, amount: cents / 100 },
                    error: status === 'pending' ? 'The payment request timed out. Check your phone before trying again; the request is awaiting confirmation.' : 'Daraja rejected the M-Pesa request. Check the sandbox app settings and try again.'
                });
            }
            if (String(result.ResponseCode) !== '0' || !result.CheckoutRequestID) {
                details.mpesaResultCode = text(result.ResponseCode, 20);
                details.mpesaResultDescription = text(result.ResponseDescription || result.errorMessage, 240);
                await store.run("UPDATE wallet_operations SET status = 'failed', details_json = ?, updated_at = ? WHERE id = ? AND status = 'processing'", [JSON.stringify(details), new Date().toISOString(), id]);
                return res.status(502).json({ error: details.mpesaResultDescription || 'Daraja could not start the M-Pesa prompt.' });
            }
            details.mpesaCheckoutRequestId = text(result.CheckoutRequestID, 120);
            details.mpesaMerchantRequestId = text(result.MerchantRequestID, 120);
            await store.run("UPDATE wallet_operations SET payment_reference = ?, details_json = ?, updated_at = ? WHERE id = ? AND status = 'processing'", [details.mpesaCheckoutRequestId, JSON.stringify(details), new Date().toISOString(), id]);
            res.status(202).json({ operation: { id, status: 'processing', amount: cents / 100, phone, message: text(result.CustomerMessage || result.ResponseDescription, 240) || 'Check your phone and enter your M-Pesa PIN to approve the payment.' } });
        } catch (error) {
            if (error.status) return res.status(error.status).json({ error: error.message });
            next(error);
        }
    });

    app.get('/api/wallet/mpesa/deposits/:id', auth, async (req, res, next) => {
        try {
            const operation = await store.get("SELECT id, amount_cents, status, details_json, created_at, updated_at FROM wallet_operations WHERE id = ? AND user_id = ? AND kind = 'deposit' AND channel = 'mpesa_stk'", [text(req.params.id, 80), req.user.id]);
            if (!operation) return res.status(404).json({ error: 'M-Pesa deposit request not found.' });
            const details = JSON.parse(operation.details_json || '{}');
            res.json({ operation: { id: operation.id, amount: Number(operation.amount_cents) / 100, status: operation.status, receipt: details.mpesaReceiptNumber || '', message: details.mpesaResultDescription || '', updatedAt: operation.updated_at } });
        } catch (error) { next(error); }
    });

    app.get('/api/wallet/paypal-quote', auth, async (req, res) => {
        try {
            const cents = amountCents(req.query?.amount);
            if (!cents) return res.status(400).json({ error: 'Enter a valid KES amount to see the PayPal estimate.' });
            const config = paypalConfig({ requireRate: true });
            res.json({ quote: paypalQuote(cents, config.kesToUsdRate) });
        } catch (error) { res.status(error.status || 503).json({ error: error.message }); }
    });

    app.get('/api/wallet/paypal/config', auth, async (req, res) => {
        try {
            const config = paypalConfig({ requireRate: true });
            res.json({ clientId: config.clientId, mode: config.mode, currency: 'USD', kesToUsdRate: config.kesToUsdRate });
        } catch (error) { res.status(error.status || 503).json({ error: error.message }); }
    });

    app.post('/api/wallet/paypal/deposits/order', auth, async (req, res, next) => {
        const cents = amountCents(req.body?.amount);
        const idempotencyKey = text(req.body?.idempotencyKey, 80);
        if (!cents) return res.status(400).json({ error: 'Enter a wallet deposit amount from KES 0.01 to KES 1,000,000.00.' });
        if (!/^[A-Za-z0-9-]{16,80}$/.test(idempotencyKey)) return res.status(400).json({ error: 'Refresh the page and try the PayPal deposit again.' });
        try {
            await getActiveWallet(req.user.id);
            const prior = await store.get('SELECT id, kind, amount_cents, status, channel, details_json, payment_reference, created_at FROM wallet_operations WHERE idempotency_key = ? AND user_id = ?', [idempotencyKey, req.user.id]);
            if (prior) {
                const priorDetails = JSON.parse(prior.details_json || '{}');
                if (prior.kind !== 'deposit' || prior.channel !== 'paypal' || Number(prior.amount_cents) !== cents) return res.status(409).json({ error: 'This deposit attempt was already used for a different request. Refresh and try again.' });
                if (prior.status === 'completed') return res.json({ operation: { id: prior.id, status: prior.status, amount: cents / 100, captureReference: prior.payment_reference || '' } });
                if (prior.status !== 'processing') return res.status(409).json({ error: 'This PayPal deposit is no longer active. Refresh the wallet and try again.' });
                if (priorDetails.paypalOrderId) return res.json({ operation: { id: prior.id, status: prior.status, amount: cents / 100, orderId: priorDetails.paypalOrderId, quote: { currency: 'USD', amount: priorDetails.paypalDepositAmountUsd, rate: priorDetails.paypalKesToUsdRate } } });
            }
            const config = paypalConfig({ requireRate: true });
            const priorDetails = prior ? JSON.parse(prior.details_json || '{}') : null;
            const quote = priorDetails?.paypalDepositAmountUsd
                ? { currency: 'USD', amount: String(priorDetails.paypalDepositAmountUsd), rate: Number(priorDetails.paypalKesToUsdRate) }
                : paypalQuote(cents, config.kesToUsdRate);
            const pending = await store.get("SELECT COUNT(*) AS total FROM wallet_operations WHERE user_id = ? AND kind = 'deposit' AND status IN ('pending', 'processing')", [req.user.id]);
            if (!prior && Number(pending.total) >= 5) return res.status(429).json({ error: 'You have several deposits awaiting review or PayPal confirmation. Resolve those first.' });
            const id = prior?.id || idempotencyKey;
            const now = new Date().toISOString();
            const details = prior ? priorDetails : {
                paypalDepositAmountUsd: quote.amount,
                paypalKesToUsdRate: quote.rate
            };
            if (!prior) {
                await store.run(`INSERT INTO wallet_operations
                    (id, user_id, kind, amount_cents, fee_cents, currency, channel, details_json, status, idempotency_key, created_at, updated_at)
                    VALUES (?, ?, 'deposit', ?, 0, 'KES', 'paypal', ?, 'processing', ?, ?, ?)`,
                [id, req.user.id, cents, JSON.stringify(details), idempotencyKey, now, now]);
            }
            let order;
            try {
                order = await paypalRequest('/v2/checkout/orders', {
                    method: 'POST', config, requestId: id,
                    body: {
                        intent: 'CAPTURE',
                        purchase_units: [{
                            reference_id: id,
                            custom_id: id,
                            description: 'KITUI FARM wallet deposit',
                            amount: { currency_code: 'USD', value: quote.amount }
                        }],
                        application_context: { shipping_preference: 'NO_SHIPPING', user_action: 'PAY_NOW' }
                    }
                });
            } catch (error) {
                // A retry with the same PayPal-Request-Id returns the same order,
                // so a lost response cannot create an extra charge.
                console.error('PayPal wallet deposit order creation failed', id, error.message);
                return res.status(502).json({ error: 'PayPal could not start checkout. Retry this deposit; the same safe request will be reused.' });
            }
            if (!order.id) throw walletError('PayPal did not return a checkout order ID.', 502);
            details.paypalOrderId = order.id;
            await store.run(`UPDATE wallet_operations SET amount_cents = ?, details_json = ?, payment_reference = ?, updated_at = ? WHERE id = ? AND user_id = ? AND status = 'processing'`,
                [cents, JSON.stringify(details), order.id, new Date().toISOString(), id, req.user.id]);
            res.status(201).json({ operation: { id, status: 'processing', amount: cents / 100, orderId: order.id, quote } });
        } catch (error) {
            if (error.status) return res.status(error.status).json({ error: error.message });
            next(error);
        }
    });

    app.post('/api/wallet/paypal/deposits/:id/capture', auth, async (req, res, next) => {
        try {
            const operation = await store.get("SELECT * FROM wallet_operations WHERE id = ? AND user_id = ? AND kind = 'deposit' AND channel = 'paypal'", [text(req.params.id, 80), req.user.id]);
            if (!operation) throw walletError('PayPal wallet deposit not found.', 404);
            if (operation.status === 'completed') return res.json({ operation: { id: operation.id, status: 'completed', amount: Number(operation.amount_cents) / 100, captureReference: operation.payment_reference || '' } });
            if (operation.status !== 'processing') throw walletError('This PayPal deposit is no longer awaiting capture.', 409);
            const details = JSON.parse(operation.details_json || '{}');
            const orderId = text(req.body?.orderId, 80);
            if (!orderId || orderId !== details.paypalOrderId || orderId !== operation.payment_reference) throw walletError('The PayPal order does not match this wallet deposit.', 400);
            const config = paypalConfig();
            let capture;
            try {
                const captureRequestId = `c${operation.id.replaceAll('-', '')}`;
                capture = await paypalRequest(`/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`, { method: 'POST', config, requestId: captureRequestId, body: {} });
            } catch (error) {
                // The payer may have completed checkout even if the first capture
                // response was lost. Read the authoritative order before retrying.
                const order = await paypalRequest(`/v2/checkout/orders/${encodeURIComponent(orderId)}`, { config }).catch(() => null);
                if (order?.status === 'COMPLETED') capture = order;
                else throw error;
            }
            const capturedUnit = capture.purchase_units?.find(unit => unit.reference_id === operation.id || unit.custom_id === operation.id) || capture.purchase_units?.[0];
            const capturedPayment = capturedUnit?.payments?.captures?.find(item => item.status === 'COMPLETED') || capturedUnit?.payments?.captures?.[0];
            const capturedAmount = capturedPayment?.amount;
            if (capture.status !== 'COMPLETED' || capturedPayment?.status !== 'COMPLETED') {
                return res.status(202).json({ operation: { id: operation.id, status: 'processing', providerStatus: capture.status || capturedPayment?.status || 'PENDING' }, message: 'PayPal is still processing this payment. The wallet has not been credited yet.' });
            }
            if (capturedAmount?.currency_code !== 'USD' || Number(capturedAmount?.value) !== Number(details.paypalDepositAmountUsd)) {
                throw walletError('The captured PayPal amount does not match the wallet deposit. The wallet was not credited; contact customer service.', 409);
            }
            const now = new Date().toISOString();
            await store.transaction(async () => {
                const completed = await store.run(`UPDATE wallet_operations SET status = 'completed', payment_reference = ?, updated_at = ? WHERE id = ? AND user_id = ? AND status = 'processing'`, [capturedPayment.id || orderId, now, operation.id, req.user.id]);
                if (!completed.changes) {
                    const existing = await store.get("SELECT status FROM wallet_operations WHERE id = ?", [operation.id]);
                    if (existing?.status === 'completed') return;
                    throw walletError('The PayPal deposit could not be finalized. Contact customer service.', 409);
                }
                const credited = await store.run(`UPDATE wallet_accounts SET balance_cents = balance_cents + ?, updated_at = ? WHERE user_id = ? AND status = 'active' AND balance_cents <= ?`, [operation.amount_cents, now, req.user.id, 2147483647 - operation.amount_cents]);
                if (!credited.changes) throw walletError('The PayPal payment succeeded, but the wallet could not accept the funds. Contact customer service.', 409);
                await store.run(`INSERT INTO wallet_transactions
                    (id, user_id, kind, event_type, amount_cents, reference_key, payment_reference, description, created_by, created_at, status, channel, operation_id)
                    VALUES (?, ?, 'credit', 'deposit', ?, ?, ?, ?, ?, ?, 'completed', 'paypal', ?)`,
                [crypto.randomUUID(), req.user.id, operation.amount_cents, `wallet-deposit:${operation.id}`, capturedPayment.id || orderId, 'Wallet deposit via PayPal', req.user.id, now, operation.id]);
            });
            res.json({ operation: { id: operation.id, status: 'completed', amount: Number(operation.amount_cents) / 100, captureReference: capturedPayment.id || orderId } });
        } catch (error) {
            if (error.status) return res.status(error.status).json({ error: error.message });
            next(error);
        }
    });

    app.post('/api/wallet/paypal/deposits/:id/cancel', auth, async (req, res, next) => {
        try {
            const operation = await store.get("SELECT * FROM wallet_operations WHERE id = ? AND user_id = ? AND kind = 'deposit' AND channel = 'paypal'", [text(req.params.id, 80), req.user.id]);
            if (!operation) throw walletError('PayPal wallet deposit not found.', 404);
            if (operation.status !== 'processing') return res.json({ operation: { id: operation.id, status: operation.status } });
            const details = JSON.parse(operation.details_json || '{}');
            if (!details.paypalOrderId) {
                await store.run(`UPDATE wallet_operations SET status = 'failed', updated_at = ? WHERE id = ? AND user_id = ? AND status = 'processing'`, [new Date().toISOString(), operation.id, req.user.id]);
                return res.json({ operation: { id: operation.id, status: 'failed' } });
            }
            const order = await paypalRequest(`/v2/checkout/orders/${encodeURIComponent(details.paypalOrderId)}`);
            if (order.status !== 'CREATED') throw walletError('PayPal has already advanced this payment. The deposit was left open to protect your payment.', 409);
            await store.run(`UPDATE wallet_operations SET status = 'failed', updated_at = ? WHERE id = ? AND user_id = ? AND status = 'processing'`, [new Date().toISOString(), operation.id, req.user.id]);
            res.json({ operation: { id: operation.id, status: 'failed' } });
        } catch (error) {
            if (error.status) return res.status(error.status).json({ error: error.message });
            next(error);
        }
    });

    app.post('/api/wallet/withdrawals', auth, async (req, res, next) => {
        const cents = amountCents(req.body?.amount);
        const methodId = text(req.body?.paymentMethodId, 80);
        let channel = '';
        let b2cConfig = null;
        const idempotencyKey = text(req.body?.idempotencyKey, 80);
        if (!cents) return res.status(400).json({ error: 'Enter an amount from KES 0.01 to KES 1,000,000.00.' });
        if (!/^[A-Za-z0-9-]{16,80}$/.test(idempotencyKey)) return res.status(400).json({ error: 'Refresh the page and try the withdrawal request again.' });
        try {
            const prior = await store.get('SELECT id, kind, amount_cents, fee_cents, status, channel, created_at FROM wallet_operations WHERE idempotency_key = ? AND user_id = ?', [idempotencyKey, req.user.id]);
            if (prior) return res.json({ operation: { id: prior.id, type: prior.kind, amount: Number(prior.amount_cents) / 100, fee: Number(prior.fee_cents) / 100, status: prior.status, channel: prior.channel, automatic: prior.channel === 'mpesa_b2c' && ['processing', 'completed'].includes(prior.status), createdAt: prior.created_at } });
            await getActiveWallet(req.user.id);
            const method = await ownedPaymentMethod(req.user.id, methodId, 'withdrawal');
            channel = method.kind;
            const details = JSON.parse(method.details_json || '{}');
            if (channel === 'mpesa') {
                if (cents % 100 !== 0) return res.status(400).json({ error: 'M-Pesa payouts must be a whole KES amount.' });
                try { b2cConfig = mpesaB2CConfig(); } catch { /* Leave the request for admin processing until B2C is configured. */ }
                if (b2cConfig && (cents < 1000 || cents > 25_000_000)) return res.status(400).json({ error: 'Automatic M-Pesa payouts must be between KES 10 and KES 250,000 per transaction.' });
                if (b2cConfig) details.mpesaB2CRecipientPhone = details.phone;
            }
            if (channel === 'paypal') {
                const config = paypalConfig({ requireRate: true });
                const quote = paypalQuote(cents, config.kesToUsdRate);
                details.paypalPayoutAmountUsd = quote.amount;
                details.paypalKesToUsdRate = quote.rate;
            }
            const pending = await store.get("SELECT COUNT(*) AS total FROM wallet_operations WHERE user_id = ? AND kind = 'withdrawal' AND status IN ('pending', 'processing')", [req.user.id]);
            if (Number(pending.total) >= 5) return res.status(429).json({ error: 'You have several withdrawals awaiting review. Wait for those to be resolved first.' });
            const id = crypto.randomUUID();
            const now = new Date().toISOString();
            const description = `Withdrawal request via ${channel === 'mpesa' ? 'M-Pesa' : channel === 'airtel' ? 'Airtel Money' : channel === 'paypal' ? 'PayPal' : 'bank transfer'}`;
            const operationChannel = b2cConfig ? 'mpesa_b2c' : channel;
            await store.transaction(async () => {
                const debited = await store.run(`
                    UPDATE wallet_accounts SET balance_cents = balance_cents - ?, updated_at = ?
                    WHERE user_id = ? AND status = 'active' AND balance_cents >= ?
                `, [cents, now, req.user.id, cents]);
                if (!debited.changes) throw walletError('Your available balance is too low for this withdrawal.', 402);
                await store.run(`
                    INSERT INTO wallet_operations
                        (id, user_id, kind, amount_cents, fee_cents, currency, channel, details_json, status, idempotency_key, created_at, updated_at)
                    VALUES (?, ?, 'withdrawal', ?, 0, 'KES', ?, ?, 'pending', ?, ?, ?)
                `, [id, req.user.id, cents, operationChannel, JSON.stringify(details), idempotencyKey, now, now]);
                await store.run(`
                    INSERT INTO wallet_transactions
                        (id, user_id, kind, event_type, amount_cents, reference_key, description, created_at, status, channel, operation_id)
                    VALUES (?, ?, 'debit', 'withdrawal', ?, ?, ?, ?, 'pending', ?, ?)
                `, [crypto.randomUUID(), req.user.id, cents, `wallet-withdrawal:${id}`, description, now, operationChannel, id]);
            });
            if (b2cConfig) {
                const originatorId = `KF${crypto.randomBytes(8).toString('hex').toUpperCase()}`;
                details.mpesaB2COriginatorConversationId = originatorId;
                await store.run("UPDATE wallet_operations SET status = 'processing', payment_reference = ?, details_json = ?, updated_at = ? WHERE id = ? AND status = 'pending'", [originatorId, JSON.stringify(details), new Date().toISOString(), id]);
                try {
                    const result = await mpesaRequest('/mpesa/b2c/v3/paymentrequest', { config: b2cConfig, method: 'POST', body: {
                        InitiatorName: b2cConfig.initiatorName,
                        SecurityCredential: b2cConfig.securityCredential,
                        CommandID: b2cConfig.commandId,
                        Amount: cents / 100,
                        PartyA: b2cConfig.partyA,
                        PartyB: details.phone,
                        Remarks: `KITUI FARM wallet withdrawal ${id.slice(0, 8)}`,
                        QueueTimeOutURL: b2cConfig.timeoutUrl,
                        ResultURL: b2cConfig.resultUrl,
                        Occassion: 'KITUI FARM wallet payout',
                        OriginatorConversationID: originatorId
                    }});
                    details.mpesaB2CResponseDescription = text(result.ResponseDescription, 240);
                    details.mpesaB2CConversationId = text(result.ConversationID, 120);
                    if (String(result.ResponseCode) !== '0') {
                        details.mpesaB2CInitiationError = text(result.ResponseDescription || result.errorMessage, 240);
                        await store.run("UPDATE wallet_operations SET status = 'pending', details_json = ?, updated_at = ? WHERE id = ? AND status = 'processing'", [JSON.stringify(details), new Date().toISOString(), id]);
                        return res.status(201).json({ operation: { id, type: 'withdrawal', amount: cents / 100, fee: 0, status: 'pending', channel: operationChannel, automatic: false, createdAt: now } });
                    }
                    await store.run("UPDATE wallet_operations SET details_json = ?, updated_at = ? WHERE id = ? AND status = 'processing'", [JSON.stringify(details), new Date().toISOString(), id]);
                    return res.status(201).json({ operation: { id, type: 'withdrawal', amount: cents / 100, fee: 0, status: 'processing', channel: operationChannel, automatic: true, createdAt: now } });
                } catch (error) {
                    // The request may have reached Safaricom even if our HTTP call timed out.
                    // Keep funds reserved and wait for Daraja callback/admin reconciliation.
                    details.mpesaB2CSubmissionNote = text(error.message, 240);
                    await store.run("UPDATE wallet_operations SET details_json = ?, updated_at = ? WHERE id = ? AND status = 'processing'", [JSON.stringify(details), new Date().toISOString(), id]);
                    return res.status(201).json({ operation: { id, type: 'withdrawal', amount: cents / 100, fee: 0, status: 'processing', channel: operationChannel, automatic: true, createdAt: now } });
                }
            }
            res.status(201).json({ operation: { id, type: 'withdrawal', amount: cents / 100, fee: 0, status: 'pending', channel, automatic: false, createdAt: now } });
        } catch (error) {
            if (error.errcode === 2067) {
                const prior = await store.get('SELECT id, kind, amount_cents, fee_cents, status, channel, created_at FROM wallet_operations WHERE idempotency_key = ? AND user_id = ?', [idempotencyKey, req.user.id]);
                if (prior) return res.json({ operation: { id: prior.id, type: prior.kind, amount: Number(prior.amount_cents) / 100, fee: Number(prior.fee_cents) / 100, status: prior.status, channel: prior.channel, automatic: prior.channel === 'mpesa_b2c' && ['processing', 'completed'].includes(prior.status), createdAt: prior.created_at } });
            }
            if (error.status) return res.status(error.status).json({ error: error.message });
            next(error);
        }
    });

    app.post('/api/wallet/close', auth, async (req, res, next) => {
        if (req.body?.confirmation !== 'CLOSE') return res.status(400).json({ error: 'Type CLOSE to confirm wallet closure.' });
        if (typeof req.body?.password !== 'string' || !req.body.password || req.body.password.length > 128) return res.status(400).json({ error: 'Enter your account password to close the wallet.' });
        try {
            const user = await store.get('SELECT * FROM users WHERE id = ?', [req.user.id]);
            const actual = crypto.scryptSync(req.body.password, Buffer.from(user.password_salt, 'hex'), 64,
                { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
            const expected = Buffer.from(user.password_hash, 'hex');
            if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) return res.status(401).json({ error: 'The password is incorrect.' });
            const changed = await store.run(`
                UPDATE wallet_accounts SET status = 'closed', updated_at = ?
                WHERE user_id = ? AND status = 'active' AND balance_cents = 0
                    AND NOT EXISTS (SELECT 1 FROM wallet_operations WHERE user_id = ? AND status IN ('pending', 'processing'))
            `, [new Date().toISOString(), req.user.id, req.user.id]);
            if (!changed.changes) return res.status(409).json({ error: 'Wallet closure requires a zero balance and no pending deposits or withdrawals.' });
            res.json({ status: 'closed', message: 'Your wallet is closed. Contact customer service if you need it reopened.' });
        } catch (error) { next(error); }
    });

    app.get('/api/wallet/admin/operations', auth, walletAdmin, async (req, res, next) => {
        try {
            const rows = await store.all(`
                SELECT wallet_operations.*, users.name, users.email, users.phone, wallet_accounts.wallet_id
                FROM wallet_operations
                JOIN users ON users.id = wallet_operations.user_id
                JOIN wallet_accounts ON wallet_accounts.user_id = wallet_operations.user_id
                WHERE wallet_operations.status = 'pending'
                   OR (wallet_operations.status = 'processing' AND wallet_operations.kind = 'withdrawal' AND wallet_operations.channel IN ('paypal', 'mpesa_b2c'))
                ORDER BY wallet_operations.created_at ASC LIMIT 100
            `);
            res.json({ requests: rows.map(row => ({
                id: row.id, type: row.kind, amount: Number(row.amount_cents) / 100, fee: Number(row.fee_cents) / 100,
                currency: row.currency, channel: row.channel, details: JSON.parse(row.details_json || '{}'),
                paymentReference: row.payment_reference || '', status: row.status, createdAt: row.created_at,
                name: row.name, email: row.email, phone: row.phone, walletId: row.wallet_id
            })) });
        } catch (error) { next(error); }
    });

    app.post('/api/wallet/admin/operations/:id/review', auth, walletAdmin, async (req, res, next) => {
        const decision = text(req.body?.decision, 12);
        if (!['approve', 'reject'].includes(decision)) return res.status(400).json({ error: 'Choose approve or reject.' });
        try {
            const current = await store.get('SELECT * FROM wallet_operations WHERE id = ?', [req.params.id]);
            if (!current) throw walletError('Wallet request not found.', 404);
            if (current.kind === 'withdrawal' && current.channel === 'paypal' && decision === 'approve') {
                // Validate credentials before changing state. Once claimed, a timed-out
                // provider request stays processing and is safely recoverable by batch ID.
                paypalConfig();
                const now = new Date().toISOString();
                const claimed = await store.run(`UPDATE wallet_operations SET status = 'processing', reviewed_by = ?, reviewed_at = ?, updated_at = ? WHERE id = ? AND status = 'pending'`, [req.user.id, now, now, current.id]);
                if (!claimed.changes) throw walletError('This wallet request has already been reviewed.', 409);
                try {
                    const payout = await createOrRecoverPayPalPayout(current);
                    const batchId = payout.batch_header?.payout_batch_id || payout.payout_batch_id || '';
                    if (batchId) await store.run(`UPDATE wallet_operations SET payment_reference = ?, updated_at = ? WHERE id = ? AND status = 'processing'`, [batchId, new Date().toISOString(), current.id]);
                    return res.json({ operation: { id: current.id, type: current.kind, status: 'processing', paymentReference: batchId, providerStatus: payout.batch_header?.batch_status || 'PENDING' } });
                } catch (error) {
                    console.error('PayPal payout submission failed for wallet operation', current.id, error.message);
                    if (isDefinitivePayPalRejection(error)) {
                        await store.run(`UPDATE wallet_operations SET status = 'pending', reviewed_by = NULL, reviewed_at = NULL, updated_at = ? WHERE id = ? AND status = 'processing' AND payment_reference IS NULL`, [new Date().toISOString(), current.id]);
                        return res.status(502).json({ error: 'PayPal rejected the payout before accepting it. The request is back in the pending list so you can fix the PayPal setup or reject and refund it.' });
                    }
                    return res.status(502).json({ error: 'PayPal has not confirmed the payout request. It remains in processing so an administrator can safely retry or check its status.' });
                }
            }
            let reviewedOperation;
            await store.transaction(async () => {
                const operation = await store.get('SELECT * FROM wallet_operations WHERE id = ?', [req.params.id]);
                if (!operation) throw walletError('Wallet request not found.', 404);
                if (operation.status !== 'pending') throw walletError('This wallet request has already been reviewed.', 409);
                const now = new Date().toISOString();
                const claimed = await store.run(`UPDATE wallet_operations SET status = 'processing', reviewed_by = ?, reviewed_at = ?, updated_at = ? WHERE id = ? AND status = 'pending'`, [req.user.id, now, now, operation.id]);
                if (!claimed.changes) throw walletError('This wallet request has already been reviewed.', 409);
                if (operation.kind === 'deposit' && decision === 'approve') {
                    const credited = await store.run(`
                        UPDATE wallet_accounts SET balance_cents = balance_cents + ?, updated_at = ?
                        WHERE user_id = ? AND status = 'active' AND balance_cents <= ?
                    `, [operation.amount_cents, now, operation.user_id, 2147483647 - operation.amount_cents]);
                    if (!credited.changes) throw walletError('This wallet is closed or cannot accept the deposit.', 409);
                    await store.run(`
                        INSERT INTO wallet_transactions
                            (id, user_id, kind, event_type, amount_cents, reference_key, payment_reference, description, created_by, created_at, status, channel, operation_id)
                        VALUES (?, ?, 'credit', 'deposit', ?, ?, ?, ?, ?, ?, 'completed', ?, ?)
                    `, [crypto.randomUUID(), operation.user_id, operation.amount_cents, `wallet-deposit:${operation.id}`, operation.payment_reference,
                        `Wallet deposit approved (${operation.channel})`, req.user.id, now, operation.channel, operation.id]);
                } else if (operation.kind === 'withdrawal' && decision === 'approve') {
                    const finalized = await store.run(`
                        UPDATE wallet_transactions SET status = 'completed' WHERE operation_id = ? AND event_type = 'withdrawal' AND status = 'pending'
                    `, [operation.id]);
                    if (!finalized.changes) throw walletError('The withdrawal ledger could not be finalized.', 409);
                } else if (operation.kind === 'withdrawal' && decision === 'reject') {
                    const credited = await store.run(`
                        UPDATE wallet_accounts SET balance_cents = balance_cents + ?, updated_at = ?
                        WHERE user_id = ? AND status = 'active' AND balance_cents <= ?
                    `, [operation.amount_cents, now, operation.user_id, 2147483647 - operation.amount_cents]);
                    if (!credited.changes) throw walletError('Could not refund the rejected withdrawal to this wallet.', 409);
                    await store.run("UPDATE wallet_transactions SET status = 'rejected' WHERE operation_id = ? AND event_type = 'withdrawal'", [operation.id]);
                    await store.run(`
                        INSERT INTO wallet_transactions
                            (id, user_id, kind, event_type, amount_cents, reference_key, description, created_by, created_at, status, channel, operation_id)
                        VALUES (?, ?, 'credit', 'refund', ?, ?, ?, ?, ?, 'completed', 'internal', ?)
                    `, [crypto.randomUUID(), operation.user_id, operation.amount_cents, `wallet-withdrawal-refund:${operation.id}`,
                        'Refund for rejected wallet withdrawal', req.user.id, now, operation.id]);
                }
                const status = decision === 'reject' ? 'rejected' : 'completed';
                await store.run(`UPDATE wallet_operations SET status = ?, updated_at = ? WHERE id = ? AND status = 'processing'`, [status, now, operation.id]);
                reviewedOperation = { id: operation.id, type: operation.kind, status };
            });
            res.json({ operation: reviewedOperation });
        } catch (error) {
            if (error.status) return res.status(error.status).json({ error: error.message });
            next(error);
        }
    });

    app.post('/api/wallet/admin/operations/:id/sync-paypal', auth, walletAdmin, async (req, res, next) => {
        try {
            const operation = await store.get("SELECT * FROM wallet_operations WHERE id = ? AND kind = 'withdrawal' AND channel = 'paypal'", [req.params.id]);
            if (!operation) throw walletError('PayPal withdrawal request not found.', 404);
            if (operation.status !== 'processing') throw walletError('This PayPal payout is not awaiting confirmation.', 409);
            let payout;
            const knownBatchId = operation.payment_reference;
            if (knownBatchId) {
                payout = await paypalRequest(`/v1/payments/payouts/${encodeURIComponent(knownBatchId)}`);
            } else {
                payout = await createOrRecoverPayPalPayout(operation);
                const batchId = payout.batch_header?.payout_batch_id || payout.payout_batch_id;
                if (!batchId) throw walletError('PayPal has not returned a payout batch ID yet. Try checking again shortly.', 502);
                await store.run(`UPDATE wallet_operations SET payment_reference = ?, updated_at = ? WHERE id = ? AND status = 'processing'`, [batchId, new Date().toISOString(), operation.id]);
                payout = await paypalRequest(`/v1/payments/payouts/${encodeURIComponent(batchId)}`);
            }
            const header = payout.batch_header || {};
            const item = (payout.items || []).find(candidate => candidate.payout_item?.sender_item_id === operation.id || candidate.sender_item_id === operation.id) || payout.items?.[0];
            const providerStatus = String(item?.transaction_status || header.batch_status || 'PENDING').toUpperCase();
            if (providerStatus === 'SUCCESS') {
                await store.transaction(async () => {
                    const changed = await store.run(`UPDATE wallet_operations SET status = 'completed', updated_at = ? WHERE id = ? AND status = 'processing'`, [new Date().toISOString(), operation.id]);
                    if (changed.changes) await store.run(`UPDATE wallet_transactions SET status = 'completed', payment_reference = ? WHERE operation_id = ? AND event_type = 'withdrawal' AND status = 'pending'`, [header.payout_batch_id || operation.payment_reference, operation.id]);
                });
                return res.json({ operation: { id: operation.id, status: 'completed', providerStatus, paymentReference: header.payout_batch_id || operation.payment_reference } });
            }
            const failed = ['FAILED', 'RETURNED', 'BLOCKED', 'REFUNDED', 'CANCELED'].includes(providerStatus) || ['DENIED', 'CANCELED'].includes(header.batch_status);
            if (failed) {
                await store.transaction(async () => {
                    const now = new Date().toISOString();
                    const changed = await store.run(`UPDATE wallet_operations SET status = 'failed', updated_at = ? WHERE id = ? AND status = 'processing'`, [now, operation.id]);
                    if (!changed.changes) return;
                    const credited = await store.run(`UPDATE wallet_accounts SET balance_cents = balance_cents + ?, updated_at = ? WHERE user_id = ? AND status = 'active' AND balance_cents <= ?`, [operation.amount_cents, now, operation.user_id, 2147483647 - operation.amount_cents]);
                    if (!credited.changes) throw walletError('The PayPal payout failed, but the wallet could not be refunded automatically. Contact support.', 409);
                    await store.run("UPDATE wallet_transactions SET status = 'failed' WHERE operation_id = ? AND event_type = 'withdrawal' AND status = 'pending'", [operation.id]);
                    await store.run(`INSERT INTO wallet_transactions (id, user_id, kind, event_type, amount_cents, reference_key, payment_reference, description, created_by, created_at, status, channel, operation_id) VALUES (?, ?, 'credit', 'refund', ?, ?, ?, ?, ?, ?, 'completed', 'internal', ?)`, [crypto.randomUUID(), operation.user_id, operation.amount_cents, `wallet-withdrawal-refund:${operation.id}`, header.payout_batch_id || operation.payment_reference, 'Automatic wallet refund after PayPal payout failure', req.user.id, now, operation.id]);
                });
                return res.json({ operation: { id: operation.id, status: 'failed', providerStatus, paymentReference: header.payout_batch_id || operation.payment_reference } });
            }
            res.json({ operation: { id: operation.id, status: 'processing', providerStatus, paymentReference: header.payout_batch_id || operation.payment_reference } });
        } catch (error) {
            if (isDefinitivePayPalRejection(error)) {
                const pendingOperation = await store.get("SELECT id FROM wallet_operations WHERE id = ? AND kind = 'withdrawal' AND channel = 'paypal' AND status = 'processing' AND payment_reference IS NULL", [req.params.id]).catch(() => null);
                if (pendingOperation) await store.run(`UPDATE wallet_operations SET status = 'pending', reviewed_by = NULL, reviewed_at = NULL, updated_at = ? WHERE id = ? AND status = 'processing' AND payment_reference IS NULL`, [new Date().toISOString(), pendingOperation.id]).catch(() => {});
            }
            if (error.status) return res.status(error.status).json({ error: error.message });
            next(error);
        }
    });

    app.get('/api/admin/overview', auth, walletAdmin, async (req, res, next) => {
        try {
            const [users, farmers, buyers, listings, orders, topups, admins] = await Promise.all([
                store.get('SELECT COUNT(*) AS total FROM users WHERE NOT EXISTS (SELECT 1 FROM wallet_admins WHERE wallet_admins.user_id = users.id)'),
                store.get("SELECT COUNT(*) AS total FROM users WHERE role = 'farmer' AND NOT EXISTS (SELECT 1 FROM wallet_admins WHERE wallet_admins.user_id = users.id)"),
                store.get("SELECT COUNT(*) AS total FROM users WHERE role = 'buyer' AND NOT EXISTS (SELECT 1 FROM wallet_admins WHERE wallet_admins.user_id = users.id)"),
                store.get(`SELECT COUNT(*) AS total FROM listings
                    WHERE quantity > 0 AND EXISTS (SELECT 1 FROM users WHERE users.id = listings.farmer_id AND users.role = 'farmer')`),
                store.get('SELECT COUNT(*) AS total FROM orders'),
                store.get("SELECT COUNT(*) AS total FROM wallet_operations WHERE status IN ('pending', 'processing')"),
                store.get('SELECT COUNT(*) AS total FROM wallet_admins')
            ]);
            res.json({ overview: {
                accounts: Number(users.total), farmers: Number(farmers.total), buyers: Number(buyers.total),
                activeListings: Number(listings.total), orders: Number(orders.total), pendingWalletOperations: Number(topups.total),
                admins: Number(admins.total)
            } });
        } catch (error) { next(error); }
    });

    app.get('/api/admin/accounts', auth, walletAdmin, async (req, res, next) => {
        try {
            const rows = await store.all(`
                SELECT id, name, email, phone, role, location, gender, profile_photo, created_at
                FROM users
                WHERE NOT EXISTS (SELECT 1 FROM wallet_admins WHERE wallet_admins.user_id = users.id)
                ORDER BY created_at DESC LIMIT 500
            `);
            res.json({ accounts: rows.map(row => ({ ...publicUser(row), createdAt: row.created_at })) });
        } catch (error) { next(error); }
    });

    app.delete('/api/admin/accounts/:id', auth, walletAdmin, async (req, res, next) => {
        const reason = text(req.body?.reason, 1000);
        if (reason.length < 5) return res.status(400).json({ error: 'Provide a deletion reason of at least 5 characters.' });
        try {
            const account = await store.get(`SELECT users.* FROM users
                WHERE users.id = ? AND NOT EXISTS (SELECT 1 FROM wallet_admins WHERE wallet_admins.user_id = users.id)`, [req.params.id]);
            if (!account) return res.status(404).json({ error: 'That farmer or customer account could not be found.' });

            await store.transaction(async () => {
                await store.run('UPDATE wallet_operations SET reviewed_by = NULL WHERE reviewed_by = ?', [account.id]);
                await store.run('UPDATE wallet_transactions SET created_by = NULL WHERE created_by = ?', [account.id]);
                if (account.role === 'buyer') {
                    await store.run(`DELETE FROM order_items WHERE order_id IN
                        (SELECT id FROM orders WHERE buyer_id = ?)`, [account.id]);
                    await store.run('DELETE FROM orders WHERE buyer_id = ?', [account.id]);
                    await store.run('DELETE FROM checkout_requests WHERE buyer_id = ?', [account.id]);
                } else {
                    await store.run('DELETE FROM listings WHERE farmer_id = ?', [account.id]);
                    await store.run(`UPDATE order_items SET farmer_id = '', seller_name = 'Deleted farmer', location = ''
                        WHERE farmer_id = ?`, [account.id]);
                }
                await store.run('DELETE FROM sessions WHERE user_id = ?', [account.id]);
                const deleted = await store.run('DELETE FROM users WHERE id = ?', [account.id]);
                if (!deleted.changes) throw new Error('The account could not be deleted.');
            });

            let emailSent = true;
            try {
                await sendAdminDeletionEmail({ email: account.email, name: account.name, reason });
            } catch (emailError) {
                emailSent = false;
                console.error('[account-deletion-email] Admin-deletion notice could not be sent', {
                    name: emailError.name || 'Error', status: emailError.status || 0
                });
            }
            res.json({ deleted: true, emailSent });
        } catch (error) { next(error); }
    });

    app.get('/api/admin/admins', auth, walletAdmin, async (req, res, next) => {
        try {
            const rows = await store.all(`
                SELECT users.id, users.name, users.email, users.phone, users.location, users.gender, users.profile_photo,
                    wallet_admins.created_at AS enabled_at
                FROM wallet_admins JOIN users ON users.id = wallet_admins.user_id
                ORDER BY wallet_admins.created_at DESC LIMIT 200
            `);
            res.json({ admins: rows.map(row => ({
                id: row.id, name: row.name, email: row.email, phone: row.phone, location: row.location,
                gender: row.gender || '', profilePhoto: row.profile_photo || '',
                enabledAt: row.enabled_at
            })) });
        } catch (error) { next(error); }
    });

    app.get('/api/admin/listings', auth, walletAdmin, async (req, res, next) => {
        try {
            const rows = await store.all(`
                SELECT listings.id, listings.farmer_id, listings.seller_name, listings.name, listings.category,
                    listings.quantity, listings.minimum_order, listings.price, listings.location, listings.created_at
                FROM listings WHERE EXISTS (
                    SELECT 1 FROM users WHERE users.id = listings.farmer_id AND users.role = 'farmer'
                ) ORDER BY listings.created_at DESC LIMIT 500
            `);
            res.json({ listings: rows.map(publicListing) });
        } catch (error) { next(error); }
    });

    app.get('/api/admin/orders', auth, walletAdmin, async (req, res, next) => {
        try {
            const rows = await store.all('SELECT * FROM orders ORDER BY created_at DESC LIMIT 200');
            res.json({ orders: await Promise.all(rows.map(row => publicOrder(store, row))) });
        } catch (error) { next(error); }
    });

    app.get('/api/admin/receipts', auth, walletAdmin, async (req, res, next) => {
        try {
            const rows = await store.all(`SELECT orders.*, users.email AS buyer_email
                FROM orders JOIN users ON users.id = orders.buyer_id
                WHERE orders.payment_method = 'KITUI FARM Wallet'
                ORDER BY orders.created_at DESC LIMIT 500`);
            res.json({ receipts: await Promise.all(rows.map(async row => ({
                ...(await publicOrder(store, row)), buyerEmail: row.buyer_email
            }))) });
        } catch (error) { next(error); }
    });

    app.post('/api/admin/receipts/:id/resend', auth, walletAdmin, async (req, res, next) => {
        try {
            const row = await store.get(`SELECT orders.*, users.email AS buyer_email, users.name AS account_name
                FROM orders JOIN users ON users.id = orders.buyer_id WHERE orders.id = ?`, [req.params.id]);
            if (!row) return res.status(404).json({ error: 'The paid order could not be found.' });
            if (row.payment_method !== 'KITUI FARM Wallet') {
                return res.status(409).json({ error: 'A payment receipt is only available for an order paid with the KITUI FARM Wallet.' });
            }
            const order = await publicOrder(store, row);
            await sendOrderReceiptEmail({ email:row.buyer_email, name:row.account_name || row.buyer_name, order, baseUrl:appBaseUrl(req) });
            res.json({ message:`Receipt sent to ${row.buyer_email}.`, email:row.buyer_email, orderId:order.id });
        } catch (error) {
            if (error.status) return res.status(error.status).json({ error:error.message });
            next(error);
        }
    });

    app.get('/api/admin/deliveries', auth, walletAdmin, async (req, res, next) => {
        try {
            const rows = await store.all("SELECT * FROM orders WHERE status NOT IN ('Cancelled', 'Refunded') ORDER BY created_at DESC LIMIT 500");
            res.json({ deliveries: await Promise.all(rows.map(row => publicOrder(store, row))) });
        } catch (error) { next(error); }
    });

    app.patch('/api/admin/orders/:id/delivery', auth, walletAdmin, async (req, res, next) => {
        const note = text(req.body?.note, 500) || 'Admin confirmed that the product arrived at its delivery address.';
        try {
            let updatedOrder;
            await store.transaction(async () => {
                const order = await store.get('SELECT * FROM orders WHERE id = ?', [req.params.id]);
                if (!order) throw walletError('Order not found.', 404);
                if (['Cancelled', 'Refunded', 'Completed'].includes(order.status)) {
                    throw walletError('This order is already closed and its delivery status cannot be changed.', 409);
                }
                const changed = await store.run("UPDATE orders SET status = 'Delivered' WHERE id = ? AND status = ?", [order.id, order.status]);
                if (!changed.changes) throw walletError('The order changed while you were updating it. Refresh and try again.', 409);
                await addDeliveryUpdate(order.id, 'Delivered', note, req.user.id);
                updatedOrder = await store.get('SELECT * FROM orders WHERE id = ?', [order.id]);
            });
            res.json({ order: await publicOrder(store, updatedOrder) });
        } catch (error) {
            if (error.status) return res.status(error.status).json({ error: error.message });
            next(error);
        }
    });

    app.get('/api/admin/wallets', auth, walletAdmin, async (req, res, next) => {
        try {
            const rows = await store.all(`
                SELECT wallet_accounts.wallet_id, wallet_accounts.balance_cents, wallet_accounts.currency,
                    wallet_accounts.status, wallet_accounts.created_at, wallet_accounts.updated_at,
                    users.id AS user_id, users.name, users.email, users.phone, users.role
                FROM wallet_accounts JOIN users ON users.id = wallet_accounts.user_id
                WHERE NOT EXISTS (SELECT 1 FROM wallet_admins WHERE wallet_admins.user_id = users.id)
                ORDER BY wallet_accounts.created_at DESC LIMIT 1000
            `);
            res.json({ wallets: rows.map(row => ({
                walletId: row.wallet_id, balance: Number(row.balance_cents) / 100, currency: row.currency,
                status: row.status, createdAt: row.created_at, updatedAt: row.updated_at,
                userId: row.user_id, name: row.name, email: row.email, phone: row.phone, role: row.role
            })) });
        } catch (error) { next(error); }
    });

    app.get('/api/admin/wallet-transactions', auth, walletAdmin, async (req, res, next) => {
        try {
            const rows = await store.all(`
                SELECT wallet_transactions.id, wallet_transactions.kind, wallet_transactions.event_type,
                    wallet_transactions.amount_cents, wallet_transactions.reference_key,
                    wallet_transactions.payment_reference, wallet_transactions.description,
                    wallet_transactions.status, wallet_transactions.channel,
                    wallet_transactions.counterparty_wallet_id, wallet_transactions.operation_id,
                    wallet_transactions.created_at, users.name, users.email, users.role,
                    wallet_accounts.wallet_id
                FROM wallet_transactions
                JOIN users ON users.id = wallet_transactions.user_id
                LEFT JOIN wallet_accounts ON wallet_accounts.user_id = wallet_transactions.user_id
                WHERE NOT EXISTS (SELECT 1 FROM wallet_admins WHERE wallet_admins.user_id = users.id)
                ORDER BY wallet_transactions.created_at DESC LIMIT 1000
            `);
            res.json({ transactions: rows.map(row => ({
                id: row.id, type: row.event_type, direction: row.kind, amount: Number(row.amount_cents) / 100,
                reference: row.payment_reference || row.reference_key, description: row.description,
                status: row.status, channel: row.channel, counterpartyWalletId: row.counterparty_wallet_id || '',
                operationId: row.operation_id || '', createdAt: row.created_at,
                name: row.name, email: row.email, role: row.role, walletId: row.wallet_id || '—'
            })) });
        } catch (error) { next(error); }
    });

    async function chatIsAdmin(userId) {
        return Boolean(await store.get('SELECT user_id FROM wallet_admins WHERE user_id = ?', [userId]));
    }

    app.post('/api/chat/presence', auth, async (req, res) => {
        if (!['buyer', 'farmer'].includes(req.user.role) || await chatIsAdmin(req.user.id)) {
            return res.status(403).json({ error: 'Online status is available to farmer and customer accounts.' });
        }
        await store.run(`INSERT INTO chat_presence (user_id, last_seen) VALUES (?, ?)
            ON CONFLICT (user_id) DO UPDATE SET last_seen = excluded.last_seen`, [req.user.id, new Date().toISOString()]);
        res.status(204).end();
    });

    app.get('/api/chat/presence', auth, async (req, res) => {
        if (!['buyer', 'farmer'].includes(req.user.role) || await chatIsAdmin(req.user.id)) {
            return res.status(403).json({ error: 'Online status is available to farmer and customer accounts.' });
        }
        const cutoff = new Date(Date.now() - 90_000).toISOString();
        const rows = await store.all('SELECT user_id FROM chat_presence WHERE user_id <> ? AND last_seen >= ?', [req.user.id, cutoff]);
        res.json({ onlineIds: rows.map(row => row.user_id) });
    });

    async function canReadConversation(user, conversation) {
        if (!conversation) return false;
        if (conversation.buyer_id === user.id || conversation.farmer_id === user.id) return true;
        return chatIsAdmin(user.id);
    }

    async function chatConversationRows(scope, userId) {
        const participantWhere = scope === 'admin' ? ''
            : scope === 'farmer' ? 'AND chat_conversations.farmer_id = ?'
                : 'AND chat_conversations.buyer_id = ?';
        const params = scope === 'admin' ? [userId, userId] : [userId, userId, userId];
        return store.all(`
            SELECT chat_conversations.id, chat_conversations.buyer_id, chat_conversations.farmer_id,
                chat_conversations.listing_id, chat_conversations.created_at, chat_conversations.last_message_at,
                (SELECT last_seen FROM chat_presence WHERE user_id = chat_conversations.buyer_id) AS buyer_last_seen,
                (SELECT last_seen FROM chat_presence WHERE user_id = chat_conversations.farmer_id) AS farmer_last_seen,
                buyers.name AS buyer_name, farmers.name AS farmer_name, listings.name AS listing_name,
                (SELECT body FROM chat_messages WHERE conversation_id = chat_conversations.id
                    AND created_at > COALESCE(cs.cleared_at, '') ORDER BY created_at DESC LIMIT 1) AS last_message,
                (SELECT COUNT(*) FROM chat_messages unread WHERE unread.conversation_id = chat_conversations.id
                    AND unread.sender_id <> ? AND unread.read_at IS NULL AND unread.deleted_at IS NULL
                    AND unread.created_at > COALESCE(cs.cleared_at, '')) AS unread_count
            FROM chat_conversations
            JOIN users AS buyers ON buyers.id = chat_conversations.buyer_id
            JOIN users AS farmers ON farmers.id = chat_conversations.farmer_id
            LEFT JOIN listings ON listings.id = chat_conversations.listing_id
            LEFT JOIN chat_conversation_states cs ON cs.conversation_id = chat_conversations.id AND cs.user_id = ?
            WHERE (cs.deleted_at IS NULL) ${participantWhere}
            ORDER BY chat_conversations.last_message_at DESC LIMIT 200
        `, params);
    }

    function publicConversation(row, user) {
        const isAdmin = row.buyer_id !== user.id && row.farmer_id !== user.id;
        const peerName = isAdmin ? `${row.buyer_name} · ${row.farmer_name}`
            : row.buyer_id === user.id ? row.farmer_name : row.buyer_name;
        return {
            id: row.id,
            peerId: row.buyer_id === user.id ? row.farmer_id : row.buyer_id,
            peerOnline: Boolean((row.buyer_id === user.id ? row.farmer_last_seen : row.buyer_last_seen)
                && Date.now() - new Date(row.buyer_id === user.id ? row.farmer_last_seen : row.buyer_last_seen).getTime() <= 90_000),
            buyerId: row.buyer_id,
            farmerId: row.farmer_id,
            listingId: row.listing_id,
            listingName: row.listing_name || (row.listing_id?.startsWith('direct:') ? 'Direct message' : 'Product order'),
            buyerName: row.buyer_name,
            farmerName: row.farmer_name,
            peerName,
            lastMessage: row.last_message || '',
            unreadCount: Number(row.unread_count) || 0,
            updatedAt: row.last_message_at,
            createdAt: row.created_at
        };
    }

    app.get('/api/chat/conversations', auth, async (req, res) => {
        if (!['buyer', 'farmer'].includes(req.user.role)) return res.status(403).json({ error: 'Buyer or farmer account required.' });
        const rows = await chatConversationRows(req.user.role, req.user.id);
        res.json({ conversations: rows.map(row => publicConversation(row, req.user)) });
    });

    app.get('/api/chat/people', auth, async (req, res, next) => {
        try {
            if (!['buyer', 'farmer'].includes(req.user.role) || await chatIsAdmin(req.user.id)) {
                return res.status(403).json({ error: 'User directory is available to farmer and customer accounts.' });
            }
            const requestedRole = text(req.query.role, 20);
            if (requestedRole && !['buyer', 'farmer'].includes(requestedRole)) {
                return res.status(400).json({ error: 'Choose Farmers or Customers.' });
            }
            const roleClause = requestedRole ? 'AND users.role = ?' : '';
            const params = requestedRole ? [req.user.id, requestedRole] : [req.user.id];
            const rows = await store.all(`
                SELECT users.id, users.name, users.role, users.location, users.profile_photo,
                    users.created_at,
                    (SELECT last_seen FROM chat_presence WHERE user_id = users.id) AS last_seen,
                    (SELECT COUNT(*) FROM listings WHERE listings.farmer_id = users.id AND listings.quantity > 0) AS product_count
                FROM users
                WHERE users.id <> ? ${roleClause}
                    AND NOT EXISTS (SELECT 1 FROM wallet_admins WHERE wallet_admins.user_id = users.id)
                ORDER BY users.role ASC, lower(users.name) ASC LIMIT 500
            `, params);
            res.json({ people: rows.map(row => ({
                id: row.id, name: row.name, role: row.role, location: row.location,
                profilePhoto: row.profile_photo || '', productCount: Number(row.product_count), joinedAt: row.created_at,
                online: Boolean(row.last_seen && Date.now() - new Date(row.last_seen).getTime() <= 90_000)
            })) });
        } catch (error) {
            next(error);
        }
    });

    app.get('/api/chat/people/:id', auth, async (req, res) => {
        if (!['buyer', 'farmer'].includes(req.user.role) || await chatIsAdmin(req.user.id)) {
            return res.status(403).json({ error: 'User profiles are available to farmer and customer accounts.' });
        }
        const person = await store.get(`
            SELECT users.id, users.name, users.role, users.location, users.profile_photo, users.created_at
            FROM users WHERE users.id = ?
                AND NOT EXISTS (SELECT 1 FROM wallet_admins WHERE wallet_admins.user_id = users.id)
        `, [req.params.id]);
        if (!person) return res.status(404).json({ error: 'This profile is not available.' });
        const listings = person.role === 'farmer'
            ? await store.all('SELECT * FROM listings WHERE farmer_id = ? AND quantity > 0 ORDER BY created_at DESC LIMIT 100', [person.id])
            : [];
        res.json({ person: {
            id: person.id, name: person.name, role: person.role, location: person.location,
            profilePhoto: person.profile_photo || '', joinedAt: person.created_at,
            listings: listings.map(publicListing)
        } });
    });

    app.post('/api/chat/conversations', auth, async (req, res, next) => {
        if (!['buyer', 'farmer'].includes(req.user.role)) return res.status(403).json({ error: 'Buyer or farmer account required.' });
        let listingId = text(req.body?.listingId, 100);
        const personId = text(req.body?.personId, 100);
        if (!listingId && !personId) return res.status(400).json({ error: 'Choose a person or product before starting a chat.' });
        try {
            let buyerId;
            let farmerId;
            if (personId) {
                if (await chatIsAdmin(req.user.id)) return res.status(403).json({ error: 'Admin accounts cannot start user conversations here.' });
                const person = await store.get(`
                    SELECT users.id, users.role FROM users WHERE users.id = ?
                        AND NOT EXISTS (SELECT 1 FROM wallet_admins WHERE wallet_admins.user_id = users.id)
                `, [personId]);
                if (!person) return res.status(404).json({ error: 'This account is not available for chat.' });
                if (person.role === req.user.role) return res.status(400).json({ error: 'You can start a chat with an account of the other type.' });
                buyerId = req.user.role === 'buyer' ? req.user.id : person.id;
                farmerId = req.user.role === 'farmer' ? req.user.id : person.id;
                listingId = `direct:${buyerId}:${farmerId}`;
            } else if (req.user.role === 'buyer') {
                const listing = await store.get("SELECT id, farmer_id FROM listings WHERE id = ? AND quantity > 0", [listingId]);
                if (!listing) return res.status(404).json({ error: 'This product is no longer available.' });
                const farmer = await store.get("SELECT id FROM users WHERE id = ? AND role = 'farmer'", [listing.farmer_id]);
                if (!farmer) return res.status(404).json({ error: 'This farmer is not available for chat.' });
                buyerId = req.user.id;
                farmerId = farmer.id;
            } else {
                const buyerIdInput = text(req.body?.buyerId, 100);
                const orderId = text(req.body?.orderId, 100);
                const orderItem = await store.get(`
                    SELECT orders.buyer_id, order_items.farmer_id
                    FROM orders JOIN order_items ON order_items.order_id = orders.id
                    WHERE orders.id = ? AND orders.buyer_id = ? AND order_items.product_id = ?
                `, [orderId, buyerIdInput, listingId]);
                if (!orderItem || orderItem.farmer_id !== req.user.id) {
                    return res.status(403).json({ error: 'You can start a chat with a buyer from one of your orders.' });
                }
                buyerId = orderItem.buyer_id;
                farmerId = req.user.id;
            }
            let conversation = await store.get(`
                SELECT id FROM chat_conversations WHERE buyer_id = ? AND farmer_id = ? AND listing_id = ?
            `, [buyerId, farmerId, listingId]);
            if (!conversation) {
                const id = crypto.randomUUID();
                const createdAt = new Date().toISOString();
                try {
                    await store.run(`
                        INSERT INTO chat_conversations (id, buyer_id, farmer_id, listing_id, created_at, last_message_at)
                        VALUES (?, ?, ?, ?, ?, ?)
                    `, [id, buyerId, farmerId, listingId, createdAt, createdAt]);
                    conversation = { id };
                } catch (error) {
                    if (error.errcode !== 2067) throw error;
                    conversation = await store.get(`
                        SELECT id FROM chat_conversations WHERE buyer_id = ? AND farmer_id = ? AND listing_id = ?
                    `, [buyerId, farmerId, listingId]);
                }
            }
            const row = (await chatConversationRows(req.user.role, req.user.id))
                .find(item => item.id === conversation.id);
            res.status(201).json({ conversation: row ? publicConversation(row, req.user) : { id: conversation.id } });
        } catch (error) { next(error); }
    });

    app.get('/api/admin/chat/conversations', auth, walletAdmin, async (req, res) => {
        const rows = await chatConversationRows('admin', req.user.id);
        res.json({ conversations: rows.map(row => publicConversation(row, req.user)) });
    });

    app.get('/api/chat/conversations/:id/messages', auth, async (req, res) => {
        const conversation = await store.get('SELECT * FROM chat_conversations WHERE id = ?', [req.params.id]);
        if (!await canReadConversation(req.user, conversation)) return res.status(404).json({ error: 'Conversation not found.' });
        const now = new Date().toISOString();
        // Admin monitoring must not mark a buyer/farmer message as read on their behalf.
        if (!await chatIsAdmin(req.user.id)) {
            await store.run(`UPDATE chat_messages SET read_at = ? WHERE conversation_id = ? AND sender_id <> ? AND read_at IS NULL`,
                [now, conversation.id, req.user.id]);
        }
        const state = await store.get('SELECT cleared_at FROM chat_conversation_states WHERE conversation_id = ? AND user_id = ?',
            [conversation.id, req.user.id]);
        const rows = await store.all(`
            SELECT recent.id, recent.sender_id, recent.body, recent.created_at, recent.read_at,
                recent.attachment_json, recent.pinned, recent.deleted_for, recent.deleted_at, recent.forwarded_from,
                users.name AS sender_name, users.role AS sender_role, wallet_admins.user_id AS admin_id
            FROM (
                SELECT id, sender_id, body, created_at, read_at, attachment_json, pinned, deleted_for, deleted_at, forwarded_from
                FROM chat_messages WHERE conversation_id = ? AND created_at > ? ORDER BY created_at DESC LIMIT 200
            ) AS recent
            JOIN users ON users.id = recent.sender_id
            LEFT JOIN wallet_admins ON wallet_admins.user_id = users.id
            ORDER BY recent.created_at ASC
        `, [req.params.id, state?.cleared_at || '']);
        const messages = rows.filter(row => {
            try { return !JSON.parse(row.deleted_for || '[]').includes(req.user.id); } catch { return true; }
        }).map(row => ({
            id: row.id,
            senderId: row.sender_id,
            senderName: row.admin_id ? 'KITUI FARM Support' : row.sender_name,
            senderRole: row.admin_id ? 'admin' : row.sender_role,
            body: row.deleted_at ? '' : row.body,
            createdAt: row.created_at,
            isRead: Boolean(row.read_at),
            pinned: Boolean(row.pinned),
            deleted: Boolean(row.deleted_at),
            forwarded: Boolean(row.forwarded_from),
            attachments: row.deleted_at ? [] : (() => {
                try { return JSON.parse(row.attachment_json || '[]').map(({ name, type, size }, index) => ({ name, type, size, index })); }
                catch { return []; }
            })()
        }));
        res.json({ messages });
    });

    app.post('/api/chat/conversations/:id/messages', auth, async (req, res, next) => {
        const conversation = await store.get('SELECT * FROM chat_conversations WHERE id = ?', [req.params.id]);
        if (!await canReadConversation(req.user, conversation)) return res.status(404).json({ error: 'Conversation not found.' });
        const body = text(req.body?.body, 2000);
        const incomingAttachments = Array.isArray(req.body?.attachments) ? req.body.attachments : [];
        if (!body && !incomingAttachments.length) return res.status(400).json({ error: 'Write a message or attach a file before sending.' });
        if (incomingAttachments.length > 5) return res.status(400).json({ error: 'Attach up to five files per message.' });
        let attachments;
        try {
            attachments = incomingAttachments.map(file => {
                const name = text(file?.name, 180) || 'Attachment';
                const type = text(file?.type, 100).toLowerCase();
                const dataUrl = typeof file?.dataUrl === 'string' ? file.dataUrl : '';
                const match = /^data:(image\/(?:jpeg|png|gif|webp)|video\/(?:mp4|webm|quicktime)|application\/(?:pdf|msword|vnd\.openxmlformats-officedocument\.wordprocessingml\.document|vnd\.ms-excel|vnd\.openxmlformats-officedocument\.spreadsheetml\.sheet)|text\/plain);base64,([A-Za-z0-9+/]+={0,2})$/i.exec(dataUrl);
                if (!match || match[1].toLowerCase() !== type) throw new Error('Use images, MP4/WebM videos, PDF, Word, Excel, or text files.');
                const size = Buffer.from(match[2], 'base64').length;
                return { name, type, size, dataUrl };
            });
            if (attachments.reduce((sum, file) => sum + file.size, 0) > 5 * 1024 * 1024) {
                return res.status(413).json({ error: 'Attachments must total 5 MB or less per message.' });
            }
        } catch (error) { return res.status(400).json({ error: error.message || 'One of the attachments is not supported.' }); }
        try {
            const id = crypto.randomUUID();
            const createdAt = new Date().toISOString();
            await store.transaction(async () => {
                await store.run(`
                    INSERT INTO chat_messages (id, conversation_id, sender_id, body, created_at, attachment_json)
                    VALUES (?, ?, ?, ?, ?, ?)
                `, [id, conversation.id, req.user.id, body, createdAt, JSON.stringify(attachments)]);
                await store.run('UPDATE chat_conversations SET last_message_at = ? WHERE id = ?', [createdAt, conversation.id]);
                await store.run('UPDATE chat_conversation_states SET deleted_at = NULL WHERE conversation_id = ? AND user_id <> ?',
                    [conversation.id, req.user.id]);
                for (const userId of [conversation.buyer_id, conversation.farmer_id]) {
                    if (userId !== req.user.id) {
                        await store.run(`INSERT INTO chat_conversation_states (conversation_id, user_id, deleted_at)
                            VALUES (?, ?, NULL) ON CONFLICT (conversation_id, user_id) DO UPDATE SET deleted_at = NULL`,
                        [conversation.id, userId]);
                    }
                }
            });
            const admin = await chatIsAdmin(req.user.id);
            res.status(201).json({ message: {
                id, senderId: req.user.id, senderName: admin ? 'KITUI FARM Support' : req.user.name,
                senderRole: admin ? 'admin' : req.user.role, body, createdAt, isRead: false,
                attachments: attachments.map(({ name, type, size }, index) => ({ name, type, size, index }))
            } });
        } catch (error) { next(error); }
    });

    app.get('/api/chat/conversations/:id/messages/:messageId/attachments/:index', auth, async (req, res) => {
        const conversation = await store.get('SELECT * FROM chat_conversations WHERE id = ?', [req.params.id]);
        if (!await canReadConversation(req.user, conversation)) return res.status(404).json({ error: 'Conversation not found.' });
        const message = await store.get('SELECT attachment_json, deleted_at, deleted_for FROM chat_messages WHERE id = ? AND conversation_id = ?',
            [req.params.messageId, conversation.id]);
        if (!message || message.deleted_at) return res.status(404).json({ error: 'Attachment not found.' });
        try {
            if (JSON.parse(message.deleted_for || '[]').includes(req.user.id)) return res.status(404).json({ error: 'Attachment not found.' });
            const file = JSON.parse(message.attachment_json || '[]')[Number(req.params.index)];
            if (!file) return res.status(404).json({ error: 'Attachment not found.' });
            res.json({ attachment: file });
        } catch { res.status(404).json({ error: 'Attachment not found.' }); }
    });

    app.patch('/api/chat/conversations/:id/messages/:messageId/pin', auth, async (req, res) => {
        if (await chatIsAdmin(req.user.id)) return res.status(403).json({ error: 'Admin monitoring accounts cannot alter user messages.' });
        const conversation = await store.get('SELECT * FROM chat_conversations WHERE id = ?', [req.params.id]);
        if (!await canReadConversation(req.user, conversation)) return res.status(404).json({ error: 'Conversation not found.' });
        const message = await store.get('SELECT id, deleted_at FROM chat_messages WHERE id = ? AND conversation_id = ?', [req.params.messageId, conversation.id]);
        if (!message || message.deleted_at) return res.status(404).json({ error: 'Message not found.' });
        const pinned = req.body?.pinned === true;
        await store.run('UPDATE chat_messages SET pinned = ? WHERE id = ?', [pinned ? 1 : 0, message.id]);
        res.json({ pinned });
    });

    app.patch('/api/chat/conversations/:id/messages/:messageId/delete', auth, async (req, res) => {
        if (await chatIsAdmin(req.user.id)) return res.status(403).json({ error: 'Admin monitoring accounts cannot delete user messages.' });
        const conversation = await store.get('SELECT * FROM chat_conversations WHERE id = ?', [req.params.id]);
        if (!await canReadConversation(req.user, conversation)) return res.status(404).json({ error: 'Conversation not found.' });
        const message = await store.get('SELECT id, sender_id, deleted_for FROM chat_messages WHERE id = ? AND conversation_id = ?', [req.params.messageId, conversation.id]);
        if (!message) return res.status(404).json({ error: 'Message not found.' });
        if (req.body?.scope === 'everyone') {
            if (message.sender_id !== req.user.id && !await chatIsAdmin(req.user.id)) return res.status(403).json({ error: 'Only the sender or an administrator can delete this message for everyone.' });
            await store.run("UPDATE chat_messages SET body = '', attachment_json = '[]', pinned = 0, deleted_at = ? WHERE id = ?", [new Date().toISOString(), message.id]);
        } else if (req.body?.scope === 'me') {
            let deletedFor = [];
            try { deletedFor = JSON.parse(message.deleted_for || '[]'); } catch { deletedFor = []; }
            if (!deletedFor.includes(req.user.id)) deletedFor.push(req.user.id);
            await store.run('UPDATE chat_messages SET deleted_for = ? WHERE id = ?', [JSON.stringify(deletedFor), message.id]);
        } else return res.status(400).json({ error: 'Choose delete for me or delete for everyone.' });
        res.json({ deleted: true });
    });

    app.post('/api/chat/messages/:id/forward', auth, async (req, res, next) => {
        if (await chatIsAdmin(req.user.id)) return res.status(403).json({ error: 'Admin monitoring accounts cannot forward user messages.' });
        const source = await store.get('SELECT * FROM chat_messages WHERE id = ?', [req.params.id]);
        const sourceConversation = source && await store.get('SELECT * FROM chat_conversations WHERE id = ?', [source.conversation_id]);
        if (!source || !await canReadConversation(req.user, sourceConversation) || source.deleted_at) return res.status(404).json({ error: 'Message not available to forward.' });
        let deletedFor = [];
        try { deletedFor = JSON.parse(source.deleted_for || '[]'); } catch { deletedFor = []; }
        if (deletedFor.includes(req.user.id)) return res.status(404).json({ error: 'Message not available to forward.' });
        const target = await store.get('SELECT * FROM chat_conversations WHERE id = ?', [text(req.body?.conversationId, 100)]);
        if (!await canReadConversation(req.user, target)) return res.status(404).json({ error: 'Destination chat not found.' });
        try {
            const id = crypto.randomUUID(); const createdAt = new Date().toISOString();
            await store.transaction(async () => {
                await store.run(`INSERT INTO chat_messages (id, conversation_id, sender_id, body, created_at, attachment_json, forwarded_from)
                    VALUES (?, ?, ?, ?, ?, ?, ?)`, [id, target.id, req.user.id, source.body, createdAt, source.attachment_json || '[]', source.id]);
                await store.run('UPDATE chat_conversations SET last_message_at = ? WHERE id = ?', [createdAt, target.id]);
                await store.run('UPDATE chat_conversation_states SET deleted_at = NULL WHERE conversation_id = ? AND user_id <> ?',
                    [target.id, req.user.id]);
                for (const userId of [target.buyer_id, target.farmer_id]) if (userId !== req.user.id) {
                    await store.run(`INSERT INTO chat_conversation_states (conversation_id, user_id, deleted_at) VALUES (?, ?, NULL)
                        ON CONFLICT (conversation_id, user_id) DO UPDATE SET deleted_at = NULL`, [target.id, userId]);
                }
            });
            res.status(201).json({ messageId: id });
        } catch (error) { next(error); }
    });

    app.delete('/api/chat/conversations/:id', auth, async (req, res) => {
        if (await chatIsAdmin(req.user.id)) return res.status(403).json({ error: 'Admin monitoring accounts cannot clear or delete user conversations.' });
        const conversation = await store.get('SELECT * FROM chat_conversations WHERE id = ?', [req.params.id]);
        if (!await canReadConversation(req.user, conversation)) return res.status(404).json({ error: 'Conversation not found.' });
        const action = req.body?.action;
        if (!['clear', 'delete'].includes(action)) return res.status(400).json({ error: 'Choose clear or delete.' });
        const now = new Date().toISOString();
        const column = action === 'clear' ? 'cleared_at' : 'deleted_at';
        await store.run(`INSERT INTO chat_conversation_states (conversation_id, user_id, ${column}) VALUES (?, ?, ?)
            ON CONFLICT (conversation_id, user_id) DO UPDATE SET ${column} = excluded.${column}`,
        [conversation.id, req.user.id, now]);
        res.json({ success: true, action });
    });

    app.get('/api/listings/:id/video', auth, async (req, res, next) => {
        try {
            const row = await store.get('SELECT farmer_id, quantity, image FROM listings WHERE id = ?', [req.params.id]);
            const match = row && /^data:(video\/(?:mp4|webm|quicktime));base64,([A-Za-z0-9+/]+={0,2})$/i.exec(row.image || '');
            if (!match || (row.quantity <= 0 && row.farmer_id !== req.user.id)) {
                return res.status(404).json({ error: 'Product video not found.' });
            }
            const video = Buffer.from(match[2], 'base64');
            res.setHeader('Content-Type', match[1]);
            res.setHeader('Content-Length', String(video.length));
            res.setHeader('Cache-Control', 'private, max-age=300');
            res.end(video);
        } catch (error) {
            next(error);
        }
    });

    app.get('/api/farmers/:id/store', auth, async (req, res) => {
        if (req.user.role !== 'buyer' && !(req.user.role === 'farmer' && req.user.id === req.params.id)) {
            return res.status(403).json({ error: 'A buyer account is required to view farmer stores.' });
        }
        const farmer = await store.get(
            "SELECT id, name, location, profile_photo FROM users WHERE id = ? AND role = 'farmer'",
            [req.params.id]
        );
        if (!farmer) return res.status(404).json({ error: 'This farmer account is no longer active.' });
        const listings = await store.all(
            'SELECT * FROM listings WHERE farmer_id = ? AND quantity > 0 ORDER BY created_at DESC',
            [req.params.id]
        );
        res.json({
            farmer: {
                id: req.params.id,
                name: farmer.name,
                location: farmer.location || '',
                profilePhoto: farmer.profile_photo || ''
            },
            listings: listings.map(publicListing)
        });
    });

    app.get('/api/listing-draft', auth, role('farmer'), async (req, res) => {
        const row = await store.get('SELECT draft_json, updated_at FROM listing_drafts WHERE farmer_id = ?', [req.user.id]);
        if (!row) return res.json({ draft: null });
        try {
            res.json({ draft: { ...JSON.parse(row.draft_json), updatedAt: row.updated_at } });
        } catch {
            await store.run('DELETE FROM listing_drafts WHERE farmer_id = ?', [req.user.id]);
            res.json({ draft: null });
        }
    });
    app.put('/api/listing-draft', auth, role('farmer'), async (req, res) => {
        const input = req.body?.draft;
        if (!input || typeof input !== 'object' || Array.isArray(input)) {
            return res.status(400).json({ error: 'Listing draft details are required.' });
        }
        const editingId = input.editingId ? text(input.editingId, 100) : '';
        if (editingId) {
            const listing = await store.get('SELECT id FROM listings WHERE id = ? AND farmer_id = ?', [editingId, req.user.id]);
            if (!listing) return res.status(404).json({ error: 'The listing being edited could not be found.' });
        }
        let image = typeof input.image === 'string' ? input.image : '';
        if (!Object.prototype.hasOwnProperty.call(input, 'image') && input.photoRemoved !== true) {
            const previousDraft = await store.get('SELECT draft_json FROM listing_drafts WHERE farmer_id = ?', [req.user.id]);
            if (previousDraft) {
                try {
                    const previous = JSON.parse(previousDraft.draft_json);
                    if ((previous.editingId || null) === (editingId || null)) image = previous.image || '';
                } catch { /* Replace an unreadable older draft with the new fields. */ }
            }
        }
        if (image) {
            const invalidImage = validateListing({ image }, true);
            if (typeof invalidImage === 'string') return res.status(400).json({ error: invalidImage });
        }
        const draft = {
            editingId: editingId || null,
            name: text(input.name, 60),
            category: CATEGORIES.has(input.category) ? input.category : '',
            quantity: text(input.quantity, 20),
            minimumOrder: text(input.minimumOrder, 20),
            price: text(input.price, 20),
            location: text(input.location, 80),
            image,
            photoRemoved: input.photoRemoved === true
        };
        const encoded = JSON.stringify(draft);
        if (Buffer.byteLength(encoded, 'utf8') > 7_500_000) {
            return res.status(413).json({ error: 'This draft is too large to save. Remove the selected media and try again.' });
        }
        const updatedAt = new Date().toISOString();
        await store.run(`
            INSERT INTO listing_drafts (farmer_id, draft_json, updated_at) VALUES (?, ?, ?)
            ON CONFLICT (farmer_id) DO UPDATE SET draft_json = excluded.draft_json, updated_at = excluded.updated_at
        `, [req.user.id, encoded, updatedAt]);
        res.json({ saved: true, updatedAt });
    });
    app.delete('/api/listing-draft', auth, role('farmer'), async (req, res) => {
        await store.run('DELETE FROM listing_drafts WHERE farmer_id = ?', [req.user.id]);
        res.status(204).end();
    });

    app.get('/api/listings', auth, async (req, res) => {
        if (req.query.scope === 'mine' && req.user.role !== 'farmer') return res.status(403).json({ error: 'A farmer account is required.' });
        const rows = req.query.scope === 'mine'
            ? await store.all('SELECT * FROM listings WHERE farmer_id = ? ORDER BY created_at DESC', [req.user.id])
            : await store.all(`SELECT listings.* FROM listings
                WHERE listings.quantity > 0 AND EXISTS (
                    SELECT 1 FROM users WHERE users.id = listings.farmer_id AND users.role = 'farmer'
                ) ORDER BY listings.created_at DESC`);
        res.json({ listings: rows.map(publicListing) });
    });
    app.get('/api/wishlist', auth, role('buyer'), async (req, res) => {
        const rows = await store.all('SELECT listing_id FROM wishlist_items WHERE user_id = ? ORDER BY created_at DESC', [req.user.id]);
        res.json({ listingIds: rows.map(row => row.listing_id) });
    });
    app.post('/api/wishlist/:listingId', auth, role('buyer'), async (req, res) => {
        const listing = await store.get(`SELECT listings.id FROM listings WHERE listings.id = ? AND listings.quantity > 0
            AND EXISTS (SELECT 1 FROM users WHERE users.id = listings.farmer_id AND users.role = 'farmer')`, [req.params.listingId]);
        if (!listing) return res.status(404).json({ error: 'This product is no longer available.' });
        await store.run(`
            INSERT INTO wishlist_items (user_id, listing_id, created_at) VALUES (?, ?, ?)
            ON CONFLICT (user_id, listing_id) DO NOTHING
        `, [req.user.id, listing.id, new Date().toISOString()]);
        res.status(201).json({ listingId: listing.id, saved: true });
    });
    app.delete('/api/wishlist/:listingId', auth, role('buyer'), async (req, res) => {
        await store.run('DELETE FROM wishlist_items WHERE user_id = ? AND listing_id = ?', [req.user.id, req.params.listingId]);
        res.status(204).end();
    });
    app.post('/api/listings', auth, role('farmer'), async (req, res) => {
        const listing = validateListing(req.body);
        if (typeof listing === 'string') return res.status(400).json({ error: listing });
        if (listing.quantity < listing.minimumOrder) return res.status(400).json({ error: 'Stock must meet the minimum order quantity.' });
        const id = crypto.randomUUID();
        await store.run(`
            INSERT INTO listings (id, farmer_id, seller_name, name, category, quantity, minimum_order, price, location, image, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [id, req.user.id, req.user.name, listing.name, listing.category, listing.quantity,
            listing.minimumOrder, listing.price, listing.location, listing.image, new Date().toISOString()]);
        res.status(201).json({ listing: publicListing(await store.get('SELECT * FROM listings WHERE id = ?', [id])) });
    });
    app.patch('/api/listings/:id', auth, role('farmer'), async (req, res) => {
        const current = await store.get('SELECT * FROM listings WHERE id = ? AND farmer_id = ?', [req.params.id, req.user.id]);
        if (!current) return res.status(404).json({ error: 'Listing not found.' });
        const patch = validateListing(req.body, true);
        if (typeof patch === 'string') return res.status(400).json({ error: patch });
        const listing = { ...publicListing(current), image: current.image || '', ...patch };
        if (listing.quantity > 0 && listing.quantity < listing.minimumOrder) return res.status(400).json({ error: 'Stock must meet the minimum order quantity.' });
        await store.run(`
            UPDATE listings SET name = ?, category = ?, quantity = ?, minimum_order = ?, price = ?, location = ?, image = ?
            WHERE id = ? AND farmer_id = ?
        `, [listing.name, listing.category, listing.quantity, listing.minimumOrder, listing.price,
            listing.location, listing.image, req.params.id, req.user.id]);
        res.json({ listing: publicListing(await store.get('SELECT * FROM listings WHERE id = ?', [req.params.id])) });
    });
    app.delete('/api/listings/:id', auth, role('farmer'), async (req, res) => {
        const result = await store.run('DELETE FROM listings WHERE id = ? AND farmer_id = ?', [req.params.id, req.user.id]);
        if (!result.changes) return res.status(404).json({ error: 'Listing not found.' });
        res.status(204).end();
    });

    app.get('/api/orders', auth, async (req, res) => {
        const rows = req.user.role === 'buyer'
            ? await store.all('SELECT * FROM orders WHERE buyer_id = ? AND buyer_hidden = false ORDER BY created_at DESC', [req.user.id])
            : await store.all(`
                SELECT DISTINCT orders.* FROM orders JOIN order_items ON order_items.order_id = orders.id
                WHERE order_items.farmer_id = ? ORDER BY orders.created_at DESC
            `, [req.user.id]);
        res.json({ orders: await Promise.all(rows.map(row => publicOrder(store, row))) });
    });
    app.get('/api/orders/purchases', auth, async (req, res) => {
        if (!['buyer', 'farmer'].includes(req.user.role) || await chatIsAdmin(req.user.id)) {
            return res.status(403).json({ error: 'Marketplace purchases are available to farmer and customer accounts.' });
        }
        const rows = await store.all('SELECT * FROM orders WHERE buyer_id = ? AND buyer_hidden = false ORDER BY created_at DESC', [req.user.id]);
        res.json({ orders: await Promise.all(rows.map(row => publicOrder(store, row))) });
    });

    app.get('/api/community/purchases', auth, async (req, res) => {
        if (!['buyer', 'farmer'].includes(req.user.role) || await chatIsAdmin(req.user.id)) {
            return res.status(403).json({ error: 'Community activity is available to farmer and customer accounts.' });
        }
        const rows = await store.all(`
            SELECT order_items.name AS product_name, order_items.quantity, order_items.seller_name,
                order_items.location, orders.created_at
            FROM order_items
            JOIN orders ON orders.id = order_items.order_id
            WHERE orders.buyer_id <> ? AND orders.status <> 'Cancelled'
                AND NOT EXISTS (SELECT 1 FROM wallet_admins WHERE wallet_admins.user_id = orders.buyer_id)
            ORDER BY orders.created_at DESC LIMIT 30
        `, [req.user.id]);
        res.json({ purchases: rows.map(row => ({ productName: row.product_name, quantity: Number(row.quantity),
            farmerName: row.seller_name, location: row.location || '', createdAt: row.created_at })) });
    });

    app.post('/api/orders', auth, async (req, res, next) => {
        if (!['buyer', 'farmer'].includes(req.user.role) || await chatIsAdmin(req.user.id)) {
            return res.status(403).json({ error: 'A farmer or customer account is required to place a marketplace order.' });
        }
        const lines = req.body?.items;
        const address = text(req.body?.address, 300);
        const paymentMethod = req.body?.paymentMethod;
        if (!Array.isArray(lines) || lines.length < 1 || lines.length > 50) return res.status(400).json({ error: 'Add between 1 and 50 order items.' });
        if (!address) return res.status(400).json({ error: 'A delivery address is required.' });
        if (!PAYMENT_METHODS.has(paymentMethod)) return res.status(400).json({ error: 'Marketplace orders must be paid using your KITUI FARM Wallet.' });
        const checkoutKey = req.body?.checkoutId;
        if (typeof checkoutKey !== 'string'
            || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(checkoutKey)) {
            return res.status(400).json({ error: 'A valid checkout ID is required.' });
        }
        const uniqueLines = new Map();
        for (const line of lines) {
            if (!line || typeof line.productId !== 'string' || !Number.isSafeInteger(Number(line.quantity)) || Number(line.quantity) <= 0) {
                return res.status(400).json({ error: 'Each order item must have a valid product and whole-number quantity.' });
            }
            if (uniqueLines.has(line.productId)) return res.status(400).json({ error: 'Each product may only appear once in an order.' });
            uniqueLines.set(line.productId, Number(line.quantity));
        }
        const payloadHash = crypto.createHash('sha256')
            .update(JSON.stringify({ items: [...uniqueLines], address, paymentMethod }))
            .digest('hex');
        try {
            const result = await store.transaction(async () => {
                const previousRequest = await store.get('SELECT * FROM checkout_requests WHERE checkout_key = ?', [checkoutKey]);
                if (previousRequest) {
                    if (previousRequest.buyer_id !== req.user.id || previousRequest.payload_hash !== payloadHash) {
                        const error = new Error('This checkout ID was already used for a different request.');
                        error.status = 409;
                        throw error;
                    }
                    return {
                        replayed: true,
                        orders: await store.all('SELECT * FROM orders WHERE checkout_key = ? ORDER BY id', [checkoutKey])
                    };
                }
                await store.run(`
                    INSERT INTO checkout_requests (checkout_key, buyer_id, payload_hash, created_at)
                    VALUES (?, ?, ?, ?)
                `, [checkoutKey, req.user.id, payloadHash, new Date().toISOString()]);
                const byFarmer = new Map();
                for (const [productId, quantity] of uniqueLines) {
                    const listing = await store.get(`SELECT listings.* FROM listings WHERE listings.id = ?
                        AND EXISTS (SELECT 1 FROM users WHERE users.id = listings.farmer_id AND users.role = 'farmer')`, [productId]);
                    if (listing?.farmer_id === req.user.id) {
                        const error = new Error('You cannot purchase your own farm listing.');
                        error.status = 400;
                        throw error;
                    }
                    if (!listing || listing.quantity < quantity || quantity < listing.minimum_order) {
                        const error = new Error('A cart item is no longer available in the requested quantity.');
                        error.status = 409;
                        throw error;
                    }
                    const stockUpdate = await store.run('UPDATE listings SET quantity = quantity - ? WHERE id = ? AND quantity >= ?',
                        [quantity, productId, quantity]);
                    if (!stockUpdate.changes) {
                        const error = new Error('A cart item is no longer available in the requested quantity.');
                        error.status = 409;
                        throw error;
                    }
                    const item = {
                        productId, farmerId: listing.farmer_id, name: listing.name, quantity, price: listing.price
                    };
                    const farmerItems = byFarmer.get(listing.farmer_id) || [];
                    farmerItems.push(item);
                    byFarmer.set(listing.farmer_id, farmerItems);
                }
                const createdAt = new Date().toISOString();
                if (paymentMethod === 'KITUI FARM Wallet') {
                    const totalCents = [...byFarmer.values()].flat().reduce((sum, item) => sum + Math.round(item.quantity * item.price * 100), 0);
                    if (!Number.isSafeInteger(totalCents) || totalCents <= 0) throw walletError('Could not calculate the order total.', 400);
                    const buyerWallet = await getActiveWallet(req.user.id);
                    const debited = await store.run(`
                        UPDATE wallet_accounts SET balance_cents = balance_cents - ?, updated_at = ?
                        WHERE user_id = ? AND status = 'active' AND balance_cents >= ?
                    `, [totalCents, createdAt, req.user.id, totalCents]);
                    if (!debited.changes) throw walletError('Your wallet balance is too low. Add funds, then try again.', 402);
                    await store.run(`
                        INSERT INTO wallet_transactions
                            (id, user_id, kind, event_type, amount_cents, reference_key, description, created_at, status, channel)
                        VALUES (?, ?, 'debit', 'purchase', ?, ?, ?, ?, 'completed', 'wallet')
                    `, [crypto.randomUUID(), req.user.id, totalCents, `checkout:${checkoutKey}`, 'Marketplace order payment', createdAt]);

                    for (const [farmerId, items] of byFarmer) {
                        const saleCents = items.reduce((sum, item) => sum + Math.round(item.quantity * item.price * 100), 0);
                        if (!Number.isSafeInteger(saleCents) || saleCents <= 0) {
                            throw walletError('Could not calculate a farmer’s sale total.', 400);
                        }
                        // A farmer can receive their first paid order without having opened
                        // the wallet page yet. Closed wallets remain closed and must be reopened.
                        await createWallet(farmerId);
                        const credited = await store.run(`
                            UPDATE wallet_accounts SET balance_cents = balance_cents + ?, updated_at = ?
                            WHERE user_id = ? AND status = 'active' AND balance_cents <= ?
                        `, [saleCents, createdAt, farmerId, 2147483647 - saleCents]);
                        if (!credited.changes) throw walletError('A farmer wallet could not accept this payment. Ask the farmer to check their wallet.', 409);
                        await store.run(`
                            INSERT INTO wallet_transactions
                                (id, user_id, kind, event_type, amount_cents, reference_key, description, created_at,
                                 status, channel, counterparty_wallet_id)
                            VALUES (?, ?, 'credit', 'sale', ?, ?, ?, ?, 'completed', 'wallet', ?)
                        `, [crypto.randomUUID(), farmerId, saleCents, `checkout:${checkoutKey}:seller:${farmerId}`,
                            'Marketplace sale proceeds', createdAt, buyerWallet.wallet_id]);
                    }
                }
                const status = 'Processing';
                const createdOrders = [];
                for (const items of byFarmer.values()) {
                    const id = `KF-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
                    const total = items.reduce((sum, item) => sum + Math.round(item.quantity * item.price * 100), 0) / 100;
                    await store.run(`
                        INSERT INTO orders
                            (id, buyer_id, buyer_name, address, payment_method, status, total, checkout_key, created_at)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                    `, [id, req.user.id, req.user.name, address, paymentMethod, status, total, checkoutKey, createdAt]);
                    await addDeliveryUpdate(id, status, 'Payment confirmed. The farmer is preparing your order.', req.user.id);
                    for (const item of items) {
                        const listing = await store.get('SELECT seller_name, location FROM listings WHERE id = ?', [item.productId]);
                        await store.run(`
                            INSERT INTO order_items (order_id, product_id, farmer_id, name, seller_name, location, quantity, price)
                            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                        `, [id, item.productId, item.farmerId, item.name, listing.seller_name, listing.location, item.quantity, item.price]);
                    }
                    createdOrders.push(await store.get('SELECT * FROM orders WHERE id = ?', [id]));
                }
                return { replayed: false, orders: createdOrders };
            });
            if (!result.replayed && paymentMethod === 'KITUI FARM Wallet') {
                for (const row of result.orders) {
                    const receipt = await publicOrder(store, row);
                    sendOrderReceiptEmail({ email:req.user.email, name:req.user.name, order:receipt, baseUrl:appBaseUrl(req) })
                        .catch(error => console.error('[order-receipt] Automatic receipt email failed', {
                            orderId:row.id, status:Number.isInteger(error.status) ? error.status : 'delivery_error'
                        }));
                }
            }
            res.status(result.replayed ? 200 : 201)
                .json({ orders: await Promise.all(result.orders.map(row => publicOrder(store, row))) });
        } catch (error) {
            if (error.status) return res.status(error.status).json({ error: error.message });
            next(error);
        }
    });
    app.get('/api/orders/:id/returns/photo', auth, async (req, res, next) => {
        try {
            const order = await store.get('SELECT id, buyer_id FROM orders WHERE id = ?', [req.params.id]);
            if (!order) return res.status(404).json({ error: 'Order not found.' });
            const isBuyer = order.buyer_id === req.user.id;
            const isSeller = Boolean(await store.get('SELECT 1 FROM order_items WHERE order_id = ? AND farmer_id = ? LIMIT 1', [order.id, req.user.id]));
            if (!isBuyer && !isSeller && !await chatIsAdmin(req.user.id)) return res.status(403).json({ error: 'You cannot view this return photo.' });
            const request = await store.get('SELECT photo_data FROM order_return_requests WHERE order_id = ?', [order.id]);
            const match = request?.photo_data?.match(/^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/]+={0,2})$/i);
            if (!match) return res.status(404).json({ error: 'No return photo is available.' });
            const type = match[1].toLowerCase() === 'jpg' ? 'jpeg' : match[1].toLowerCase();
            res.set('Cache-Control', 'private, no-store').set('X-Content-Type-Options', 'nosniff').type(`image/${type}`)
                .send(Buffer.from(match[2], 'base64'));
        } catch (error) { next(error); }
    });

    app.post('/api/orders/:id/returns', auth, async (req, res, next) => {
        if (!['buyer', 'farmer'].includes(req.user.role) || await chatIsAdmin(req.user.id)) {
            return res.status(403).json({ error: 'A customer account is required to request a return or refund.' });
        }
        const reason = text(req.body?.reason, 1000);
        const photo = typeof req.body?.photo === 'string' ? req.body.photo : '';
        if (reason.length < 10) return res.status(400).json({ error: 'Explain the return or refund reason in at least 10 characters.' });
        if (photo && (photo.length > 3500000 || !/^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/i.test(photo))) {
            return res.status(400).json({ error: 'Attach a JPG, PNG, or WebP photo smaller than 2.5 MB.' });
        }
        try {
            const order = await store.get('SELECT * FROM orders WHERE id = ? AND buyer_id = ? AND buyer_hidden = false', [req.params.id, req.user.id]);
            if (!order) return res.status(404).json({ error: 'Order not found in your account.' });
            if (!['Delivered', 'Completed'].includes(order.status)) {
                return res.status(409).json({ error: 'You can request a return or refund after the order is marked delivered.' });
            }
            if (order.payment_method !== 'KITUI FARM Wallet') {
                return res.status(409).json({ error: 'This order does not have a refundable KITUI FARM Wallet payment.' });
            }
            const now = new Date().toISOString();
            await store.run(`INSERT INTO order_return_requests
                (id, order_id, buyer_id, reason, photo_data, status, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`,
            [crypto.randomUUID(), order.id, req.user.id, reason, photo, now, now]);
            res.status(201).json({ order: await publicOrder(store, await store.get('SELECT * FROM orders WHERE id = ?', [order.id])) });
        } catch (error) {
            if (error.errcode === 2067) return res.status(409).json({ error: 'A return or refund request has already been submitted for this order.' });
            next(error);
        }
    });

    app.post('/api/orders/:id/returns/review', auth, role('farmer'), async (req, res, next) => {
        const decision = req.body?.decision;
        const response = text(req.body?.response, 1000);
        if (!['approve', 'reject'].includes(decision)) return res.status(400).json({ error: 'Choose approve or reject.' });
        try {
            const order = await store.get('SELECT * FROM orders WHERE id = ?', [req.params.id]);
            if (!order) return res.status(404).json({ error: 'Order not found.' });
            const ownsItems = await store.get('SELECT 1 FROM order_items WHERE order_id = ? AND farmer_id = ? LIMIT 1', [order.id, req.user.id]);
            if (!ownsItems) return res.status(403).json({ error: 'Only the seller can review this return request.' });
            let result;
            await store.transaction(async () => {
                const request = await store.get("SELECT * FROM order_return_requests WHERE order_id = ? AND status = 'pending'", [order.id]);
                if (!request) throw walletError('There is no pending return or refund request for this order.', 409);
                const now = new Date().toISOString();
                if (decision === 'approve') {
                    await reverseWalletSale(order, req.user.id);
                    const changedOrder = await store.run('UPDATE orders SET status = ? WHERE id = ? AND status IN (?, ?)',
                        ['Refunded', order.id, 'Delivered', 'Completed']);
                    if (!changedOrder.changes) throw walletError('This order can no longer be refunded.', 409);
                    await addDeliveryUpdate(order.id, 'Refunded', response || 'Seller approved the return and refunded the wallet payment.', req.user.id);
                }
                const changedRequest = await store.run(`UPDATE order_return_requests SET status = ?, response = ?, reviewed_by = ?, updated_at = ?
                    WHERE id = ? AND status = 'pending'`,
                [decision === 'approve' ? 'approved' : 'rejected', response, req.user.id, now, request.id]);
                if (!changedRequest.changes) throw walletError('This return request has already been reviewed.', 409);
                result = await store.get('SELECT * FROM orders WHERE id = ?', [order.id]);
            });
            res.json({ order: await publicOrder(store, result) });
        } catch (error) {
            if (error.status) return res.status(error.status).json({ error: error.message });
            next(error);
        }
    });

    app.patch('/api/orders/:id/status', auth, async (req, res, next) => {
        try {
            const order = await store.get('SELECT * FROM orders WHERE id = ?', [req.params.id]);
            if (!order) return res.status(404).json({ error: 'Order not found.' });
            const status = req.body?.status;
            const validStatuses = new Set(['Processing', 'Packed', 'Dispatched', 'Out for delivery', 'Delivered', 'Completed', 'Cancelled']);
            if (!validStatuses.has(status)) return res.status(400).json({ error: 'Choose a valid order status.' });
            const isFarmerOrder = Boolean(await store.get('SELECT 1 FROM order_items WHERE order_id = ? AND farmer_id = ?',
                [order.id, req.user.id]));
            const canCancel = ['buyer', 'farmer'].includes(req.user.role) && order.buyer_id === req.user.id && status === 'Cancelled'
                && ['Pending', 'Cash on delivery', 'Payment pending (demo)', 'Paid with wallet', 'Processing', 'Packed'].includes(order.status);
            const canPack = req.user.role === 'farmer' && isFarmerOrder && status === 'Packed'
                && ['Cash on delivery', 'Paid', 'Paid with wallet', 'Payment pending (demo)'].includes(order.status);
            const canProcess = req.user.role === 'farmer' && isFarmerOrder && status === 'Processing'
                && ['Paid with wallet', 'Paid', 'Cash on delivery', 'Payment pending (demo)'].includes(order.status);
            const canDispatch = req.user.role === 'farmer' && isFarmerOrder && status === 'Dispatched'
                && ['Processing', 'Packed'].includes(order.status);
            const canOutForDelivery = req.user.role === 'farmer' && isFarmerOrder && status === 'Out for delivery'
                && order.status === 'Dispatched';
            const canDeliver = req.user.role === 'farmer' && isFarmerOrder && status === 'Delivered'
                && ['Dispatched', 'Out for delivery'].includes(order.status);
            const canComplete = req.user.id === order.buyer_id && ['buyer', 'farmer'].includes(req.user.role)
                && status === 'Completed' && order.status === 'Delivered';
            if (!canCancel && !canPack && !canProcess && !canDispatch && !canOutForDelivery && !canDeliver && !canComplete) {
                return res.status(403).json({ error: 'You cannot make that order status change.' });
            }
            await store.transaction(async () => {
                const changed = await store.run('UPDATE orders SET status = ? WHERE id = ? AND status = ?', [status, order.id, order.status]);
                if (!changed.changes) throw walletError('This order has already changed. Refresh and try again.', 409);
                if (status === 'Cancelled') {
                    const items = await store.all('SELECT product_id, farmer_id, quantity FROM order_items WHERE order_id = ?', [order.id]);
                    for (const item of items) {
                        await store.run('UPDATE listings SET quantity = quantity + ? WHERE id = ? AND farmer_id = ?',
                            [item.quantity, item.product_id, item.farmer_id]);
                    }
                    if (order.payment_method === 'KITUI FARM Wallet') {
                        await getActiveWallet(order.buyer_id);
                        await reverseWalletSale(order, req.user.id);
                    }
                }
                const notes = {
                    Processing: 'The farmer is preparing your order.',
                    Packed: 'The farmer has packed your order.',
                    Dispatched: 'The order has left the farm.',
                    'Out for delivery': 'The order is on its way to your delivery address.',
                    Delivered: 'The product has arrived at the delivery address.',
                    Completed: 'The buyer confirmed receipt of the order.',
                    Cancelled: 'The order was cancelled and the wallet payment was refunded.'
                };
                await addDeliveryUpdate(order.id, status, req.body?.note || notes[status] || '', req.user.id);
            });
            res.json({ order: await publicOrder(store, await store.get('SELECT * FROM orders WHERE id = ?', [order.id])) });
        } catch (error) {
            if (error.status) return res.status(error.status).json({ error: error.message });
            next(error);
        }
    });

    app.delete('/api/orders/:id', auth, async (req, res, next) => {
        try {
            if (!['buyer', 'farmer'].includes(req.user.role) || await chatIsAdmin(req.user.id)) {
                return res.status(403).json({ error: 'A farmer or customer account is required.' });
            }
            const order = await store.get('SELECT * FROM orders WHERE id = ? AND buyer_id = ?', [req.params.id, req.user.id]);
            if (!order || order.buyer_hidden === true || order.buyer_hidden === 1) return res.status(404).json({ error: 'Order not found.' });
            await store.transaction(async () => {
                if (['Pending', 'Cash on delivery', 'Payment pending (demo)', 'Paid with wallet', 'Processing', 'Packed'].includes(order.status)) {
                    const changed = await store.run('UPDATE orders SET status = ?, buyer_hidden = true WHERE id = ? AND status = ?',
                        ['Cancelled', order.id, order.status]);
                    if (!changed.changes) throw walletError('This order has already changed. Refresh and try again.', 409);
                    const items = await store.all('SELECT product_id, farmer_id, quantity FROM order_items WHERE order_id = ?', [order.id]);
                    for (const item of items) {
                        await store.run('UPDATE listings SET quantity = quantity + ? WHERE id = ? AND farmer_id = ?',
                            [item.quantity, item.product_id, item.farmer_id]);
                    }
                    await addDeliveryUpdate(order.id, 'Cancelled', 'The buyer cancelled the order before dispatch.', req.user.id);
                } else {
                    await store.run('UPDATE orders SET buyer_hidden = true WHERE id = ?', [order.id]);
                }
                if (order.payment_method === 'KITUI FARM Wallet' && ['Pending', 'Cash on delivery', 'Payment pending (demo)', 'Paid with wallet', 'Processing', 'Packed'].includes(order.status)) {
                    await getActiveWallet(order.buyer_id);
                    await reverseWalletSale(order, req.user.id);
                }
            });
            res.status(204).end();
        } catch (error) {
            if (error.status) return res.status(error.status).json({ error: error.message });
            next(error);
        }
    });

    app.post('/api/auth/password-reset', async (req, res, next) => {
        const email = text(req.body?.email, 254).toLowerCase();
        if (!emailIsValid(email)) return res.status(400).json({ error: 'Enter a valid @gmail.com address.' });
        const now = Date.now();
        const attempt = passwordResetAttempts.get(req.ip) || { count: 0, resetAt: now + 15 * 60 * 1000 };
        if (attempt.resetAt <= now) { attempt.count = 0; attempt.resetAt = now + 15 * 60 * 1000; }
        if (attempt.count >= 5) return res.status(429).json({ error: 'Too many reset requests. Try again in 15 minutes.' });
        attempt.count++;
        passwordResetAttempts.set(req.ip, attempt);
        try {
            await store.run('DELETE FROM password_reset_codes WHERE expires_at <= ?', [now]);
            const user = await store.get('SELECT id, email, name FROM users WHERE email = ?', [email]);
            if (user) {
                const existingCode = await store.get('SELECT created_at FROM password_reset_codes WHERE user_id = ?', [user.id]);
                const sentAt = existingCode ? Date.parse(existingCode.created_at) : 0;
                if (!existingCode || !Number.isFinite(sentAt) || now - sentAt >= 60000) {
                    const code = crypto.randomInt(0, 1000000).toString().padStart(6, '0');
                    const salt = crypto.randomBytes(16);
                    const codeHash = crypto.scryptSync(code, salt, 64,
                        { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }).toString('hex');
                    const createdAt = new Date(now).toISOString();
                    await store.run(`
                        INSERT INTO password_reset_codes (user_id, code_salt, code_hash, attempts, expires_at, created_at)
                        VALUES (?, ?, ?, 0, ?, ?)
                        ON CONFLICT (user_id) DO UPDATE SET
                            code_salt = excluded.code_salt,
                            code_hash = excluded.code_hash,
                            attempts = 0,
                            expires_at = excluded.expires_at,
                            created_at = excluded.created_at
                    `, [user.id, salt.toString('hex'), codeHash, now + 10 * 60 * 1000, createdAt]);
                    try {
                        await sendPasswordResetEmail({
                            email: user.email,
                            name: user.name,
                            code,
                            baseUrl: appBaseUrl(req)
                        });
                    } catch (error) {
                        await store.run('DELETE FROM password_reset_codes WHERE user_id = ?', [user.id]);
                        console.error('[password-reset] Code delivery failed', {
                            status: Number.isInteger(error.status) ? error.status : 502
                        });
                    }
                }
            }
            res.status(202).json({ message: 'If an account exists for that email, a reset code has been sent.' });
        } catch (error) {
            next(error);
        }
    });

    app.post('/api/auth/password-reset/confirm', async (req, res, next) => {
        const email = text(req.body?.email, 254).toLowerCase();
        const code = text(req.body?.code, 7);
        const password = req.body?.password;
        if (!emailIsValid(email)) return res.status(400).json({ error: 'Enter a valid @gmail.com address.' });
        if (!/^\d{6}$/.test(code)) return res.status(400).json({ error: 'Enter the 6-digit code from your email.' });
        if (typeof password !== 'string' || password.length < 8 || password.length > 128) {
            return res.status(400).json({ error: 'Your new password must be 8 to 128 characters.' });
        }
        try {
            const user = await store.get('SELECT id FROM users WHERE email = ?', [email]);
            if (!user) return res.status(400).json({ error: 'The code is invalid or expired. Request a new code and try again.' });
            const reset = await store.get('SELECT * FROM password_reset_codes WHERE user_id = ?', [user.id]);
            const now = Date.now();
            if (!reset || reset.expires_at <= now) {
                if (reset) await store.run('DELETE FROM password_reset_codes WHERE user_id = ?', [user.id]);
                return res.status(400).json({ error: 'The code is invalid or expired. Request a new code and try again.' });
            }
            if (reset.attempts >= 5) {
                await store.run('DELETE FROM password_reset_codes WHERE user_id = ?', [user.id]);
                return res.status(400).json({ error: 'Too many incorrect attempts. Request a new reset code.' });
            }
            const actualCodeHash = crypto.scryptSync(code, Buffer.from(reset.code_salt, 'hex'), 64,
                { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
            const expectedCodeHash = Buffer.from(reset.code_hash, 'hex');
            if (actualCodeHash.length !== expectedCodeHash.length || !crypto.timingSafeEqual(actualCodeHash, expectedCodeHash)) {
                await store.run('UPDATE password_reset_codes SET attempts = attempts + 1 WHERE user_id = ? AND attempts < 5', [user.id]);
                return res.status(400).json({ error: 'The code is invalid or expired. Request a new code and try again.' });
            }
            const salt = crypto.randomBytes(16);
            const passwordHash = crypto.scryptSync(password, salt, 64,
                { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
            await store.transaction(async () => {
                const consumed = await store.run(`
                    DELETE FROM password_reset_codes
                    WHERE user_id = ? AND code_hash = ? AND expires_at > ? AND attempts < 5
                `, [user.id, reset.code_hash, Date.now()]);
                if (!consumed.changes) throw walletError('The code is invalid or expired. Request a new code and try again.', 400);
                await store.run('UPDATE users SET password_salt = ?, password_hash = ? WHERE id = ?',
                    [salt.toString('hex'), passwordHash.toString('hex'), user.id]);
                await store.run('DELETE FROM sessions WHERE user_id = ?', [user.id]);
            });
            let confirmationEmailSent = false;
            try {
                const account = await store.get('SELECT name, email FROM users WHERE id = ?', [user.id]);
                await sendPasswordChangedEmail({
                    email: account.email,
                    name: account.name,
                    baseUrl: appBaseUrl(req)
                });
                confirmationEmailSent = true;
            } catch (emailError) {
                console.error('[password-reset] Confirmation email delivery failed', {
                    status: Number.isInteger(emailError.status) ? emailError.status : 502
                });
            }
            res.json({
                message: confirmationEmailSent
                    ? 'Password changed. A confirmation email was sent. Sign in with your new password.'
                    : 'Password changed. Sign in with your new password; we could not send the confirmation email.',
                confirmationEmailSent
            });
        } catch (error) {
            if (error.status) return res.status(error.status).json({ error: error.message });
            next(error);
        }
    });

    app.get('/', (req, res) => res.sendFile(path.join(ROOT, 'login.html')));
    app.get('/wallet.html', (req, res) => {
        res.setHeader('Cache-Control', 'no-store');
        res.sendFile(path.join(ROOT, 'wallet.html'));
    });
    app.get('/admin.html', adminPageAuth, (req, res) => {
        res.setHeader('Cache-Control', 'no-store, private');
        res.setHeader('X-Robots-Tag', 'noindex, nofollow');
        res.sendFile(path.join(ROOT, 'admin.html'));
    });
    app.get('/admin-chat.html', adminPageAuth, (req, res) => {
        res.setHeader('Cache-Control', 'no-store, private');
        res.setHeader('X-Robots-Tag', 'noindex, nofollow');
        res.sendFile(path.join(ROOT, 'chat.html'));
    });
    app.get('/admin-profile.html', adminPageAuth, (req, res) => {
        res.setHeader('Cache-Control', 'no-store, private');
        res.setHeader('X-Robots-Tag', 'noindex, nofollow');
        res.sendFile(path.join(ROOT, 'admin-profile.html'));
    });
    app.get('/wallet-admin.html', adminPageAuth, (req, res) => res.redirect('/admin.html#wallet-approvals'));
    for (const page of PAGES) app.get(`/${page}`, (req, res) => res.sendFile(path.join(ROOT, page)));
    app.get('/site-only.js', (req, res) => res.sendFile(path.join(ROOT, 'site-only.js')));
    app.get('/api-base.js', (req, res) => res.sendFile(path.join(ROOT, 'api-base.js')));

    app.use('/api', (req, res) => res.status(404).json({ error: 'API endpoint not found.' }));
    app.use((error, req, res, next) => {
        if (res.headersSent) return next(error);
        if (error instanceof SyntaxError && 'body' in error) return res.status(400).json({ error: 'Request body must contain valid JSON.' });
        if (error.type === 'entity.too.large') return res.status(413).json({ error: 'Request body is too large.' });
        console.error(error);
        res.status(500).json({ error: 'An unexpected server error occurred.' });
    });
    return { app, db: store, store };
}

if (require.main === module) {
    const { app } = createApp();
    const port = Number(process.env.PORT) || 3000;
    const host = process.env.HOST || '127.0.0.1';
    app.listen(port, host, () => console.log(`Kitui Farm API running at http://${host}:${port}`));
}

module.exports = { createApp, createPostgresStore };
