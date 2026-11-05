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
    'Cash on delivery', 'M-PESA (demo)', 'Airtel Money (demo)', 'Bank transfer (demo)', 'KITUI FARM Wallet'
]);
const PAGES = [
    'about-us.html', 'buyer-dashboard.html', 'customer-service.html', 'farmer-dashboard.html',
    'forgot-password.html', 'index.html', 'login.html', 'payment.html', 'profile.html',
    'settings.html', 'signup.html', 'wallet.html', 'wallet-admin.html'
];

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
    CREATE TABLE IF NOT EXISTS user_settings (
        user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, settings_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS wallet_accounts (
        user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        balance_cents INTEGER NOT NULL DEFAULT 0 CHECK (balance_cents >= 0),
        updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS wallet_transactions (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK (kind IN ('credit', 'debit')),
        amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
        reference_key TEXT NOT NULL UNIQUE, payment_reference TEXT,
        description TEXT NOT NULL, created_by TEXT REFERENCES users(id), created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS wallet_topup_requests (
        id TEXT PRIMARY KEY, buyer_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
        payment_reference TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected')),
        reviewed_by TEXT REFERENCES users(id), reviewed_at TEXT, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS wallet_admins (
        user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions(expires_at);
    CREATE INDEX IF NOT EXISTS idx_listings_farmer ON listings(farmer_id);
    CREATE INDEX IF NOT EXISTS idx_orders_buyer ON orders(buyer_id);
    CREATE INDEX IF NOT EXISTS idx_order_items_farmer ON order_items(farmer_id);
    CREATE INDEX IF NOT EXISTS idx_wallet_transactions_user ON wallet_transactions(user_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_wallet_topup_requests_status ON wallet_topup_requests(status, created_at);
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
                `CREATE TABLE IF NOT EXISTS wallet_accounts (
                user_id text primary key references users(id) on delete cascade,
                balance_cents integer not null default 0 check (balance_cents >= 0),
                updated_at text not null
            )`,
                `CREATE TABLE IF NOT EXISTS wallet_transactions (
                id text primary key, user_id text not null references users(id) on delete cascade,
                kind text not null check (kind in ('credit', 'debit')),
                amount_cents integer not null check (amount_cents > 0),
                reference_key text not null unique, payment_reference text,
                description text not null, created_by text references users(id), created_at text not null
            )`,
                `CREATE TABLE IF NOT EXISTS wallet_topup_requests (
                id text primary key, buyer_id text not null references users(id) on delete cascade,
                amount_cents integer not null check (amount_cents > 0),
                payment_reference text not null unique,
                status text not null check (status in ('pending', 'approved', 'rejected')),
                reviewed_by text references users(id), reviewed_at text, created_at text not null
            )`,
                `CREATE TABLE IF NOT EXISTS wallet_admins (
                user_id text primary key references users(id) on delete cascade,
                created_at text not null
            )`,
                'CREATE INDEX IF NOT EXISTS idx_wallet_transactions_user ON wallet_transactions(user_id, created_at)',
                'CREATE INDEX IF NOT EXISTS idx_wallet_topup_requests_status ON wallet_topup_requests(status, created_at)',
                'ALTER TABLE wallet_accounts ENABLE ROW LEVEL SECURITY',
                'ALTER TABLE wallet_transactions ENABLE ROW LEVEL SECURITY',
                'ALTER TABLE wallet_topup_requests ENABLE ROW LEVEL SECURITY',
                'ALTER TABLE wallet_admins ENABLE ROW LEVEL SECURITY'
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
    const items = (await store.all(
        'SELECT product_id, farmer_id, name, seller_name, location, quantity, price FROM order_items WHERE order_id = ?',
        [row.id]
    )).map(item => ({
        productId: item.product_id, farmerId: item.farmer_id, name: item.name,
        sellerName: item.seller_name, location: item.location, quantity: item.quantity, price: item.price
    }));
    const deliveryDate = new Date(new Date(row.created_at).getTime() + 2 * 24 * 60 * 60 * 1000);
    return {
        id: row.id, buyerId: row.buyer_id, buyerName: row.buyer_name, address: row.address,
        paymentMethod: row.payment_method, status: row.status, total: row.total, createdAt: row.created_at, items,
        paymentStatus: row.payment_method === 'Cash on delivery' ? 'Due on delivery' : 'Not processed (demo)',
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
            'Permissions-Policy': 'camera=(), microphone=(), geolocation=()'
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
    app.use('/api', express.json({ limit: '8mb', strict: true }));

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

    async function ensureWallet(userId) {
        await store.run(`
            INSERT INTO wallet_accounts (user_id, balance_cents, updated_at) VALUES (?, 0, ?)
            ON CONFLICT (user_id) DO NOTHING
        `, [userId, new Date().toISOString()]);
    }

    function walletError(message, status) {
        const error = new Error(message);
        error.status = status;
        return error;
    }

    app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

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
        const id = crypto.randomUUID();
        const salt = crypto.randomBytes(16);
        const hash = crypto.scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
        try {
            await store.run(`
                INSERT INTO users (id, name, email, phone, role, password_salt, password_hash, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            `, [id, name, email, phone, accountRole, salt.toString('hex'), hash.toString('hex'), new Date().toISOString()]);
            const user = await store.get('SELECT * FROM users WHERE id = ?', [id]);
            const token = await createSession(user, res, Boolean(req.body.remember));
            res.status(201).json({ user: publicUser(user), token });
        } catch (error) {
            if (error.errcode === 2067) {
                return res.status(409).json({ error: 'An account already exists with this email or phone number.' });
            }
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

    app.post('/api/auth/logout', auth, async (req, res) => {
        await store.run('DELETE FROM sessions WHERE token_hash = ?', [req.tokenHash]);
        res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secureCookie}`);
        res.status(204).end();
    });
    app.get('/api/auth/me', auth, (req, res) => res.json({ user: publicUser(req.user) }));
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

    app.get('/api/wallet', auth, role('buyer'), async (req, res, next) => {
        try {
            await ensureWallet(req.user.id);
            const [account, transactions, topups, admin] = await Promise.all([
                store.get('SELECT balance_cents FROM wallet_accounts WHERE user_id = ?', [req.user.id]),
                store.all('SELECT id, kind, amount_cents, description, created_at FROM wallet_transactions WHERE user_id = ? ORDER BY created_at DESC LIMIT 50', [req.user.id]),
                store.all('SELECT id, amount_cents, payment_reference, status, created_at FROM wallet_topup_requests WHERE buyer_id = ? ORDER BY created_at DESC LIMIT 20', [req.user.id]),
                store.get('SELECT user_id FROM wallet_admins WHERE user_id = ?', [req.user.id])
            ]);
            res.json({
                balance: Number(account?.balance_cents || 0) / 100,
                transactions: transactions.map(row => ({
                    id: row.id, kind: row.kind, amount: Number(row.amount_cents) / 100,
                    description: row.description, createdAt: row.created_at
                })),
                topupRequests: topups.map(row => ({
                    id: row.id, amount: Number(row.amount_cents) / 100,
                    paymentReference: row.payment_reference, status: row.status, createdAt: row.created_at
                })),
                isAdmin: Boolean(admin)
            });
        } catch (error) { next(error); }
    });

    app.post('/api/wallet/topups', auth, role('buyer'), async (req, res, next) => {
        const cents = amountCents(req.body?.amount);
        if (!cents) return res.status(400).json({ error: 'Enter an amount from KES 0.01 to KES 1,000,000.00.' });
        const paymentReference = text(req.body?.paymentReference, 32).toUpperCase();
        if (!/^[A-Z0-9-]{5,32}$/.test(paymentReference)) {
            return res.status(400).json({ error: 'Enter a valid M-PESA receipt or payment reference.' });
        }
        try {
            const id = crypto.randomUUID();
            const createdAt = new Date().toISOString();
            await store.run(`
                INSERT INTO wallet_topup_requests
                    (id, buyer_id, amount_cents, payment_reference, status, created_at)
                VALUES (?, ?, ?, ?, 'pending', ?)
            `, [id, req.user.id, cents, paymentReference, createdAt]);
            res.status(201).json({ request: { id, amount: cents / 100, paymentReference, status: 'pending', createdAt } });
        } catch (error) {
            if (error.errcode === 2067) return res.status(409).json({ error: 'That payment reference has already been submitted.' });
            next(error);
        }
    });

    app.get('/api/wallet/admin/topups', auth, walletAdmin, async (req, res, next) => {
        try {
            const rows = await store.all(`
                SELECT wallet_topup_requests.id, wallet_topup_requests.amount_cents,
                    wallet_topup_requests.payment_reference, wallet_topup_requests.created_at,
                    users.name, users.email, users.phone
                FROM wallet_topup_requests JOIN users ON users.id = wallet_topup_requests.buyer_id
                WHERE wallet_topup_requests.status = 'pending'
                ORDER BY wallet_topup_requests.created_at ASC LIMIT 100
            `);
            res.json({ requests: rows.map(row => ({
                id: row.id, amount: Number(row.amount_cents) / 100,
                paymentReference: row.payment_reference, createdAt: row.created_at,
                name: row.name, email: row.email, phone: row.phone
            })) });
        } catch (error) { next(error); }
    });

    app.post('/api/wallet/admin/topups/:id/review', auth, walletAdmin, async (req, res, next) => {
        const decision = req.body?.decision;
        if (!['approve', 'reject'].includes(decision)) return res.status(400).json({ error: 'Choose approve or reject.' });
        try {
            const result = await store.transaction(async () => {
                const request = await store.get('SELECT * FROM wallet_topup_requests WHERE id = ?', [req.params.id]);
                if (!request) throw walletError('Top-up request not found.', 404);
                if (request.status !== 'pending') throw walletError('This top-up request has already been reviewed.', 409);
                const reviewedAt = new Date().toISOString();
                const status = decision === 'approve' ? 'approved' : 'rejected';
                const updated = await store.run(`
                    UPDATE wallet_topup_requests SET status = ?, reviewed_by = ?, reviewed_at = ?
                    WHERE id = ? AND status = 'pending'
                `, [status, req.user.id, reviewedAt, request.id]);
                if (!updated.changes) throw walletError('This top-up request has already been reviewed.', 409);
                if (decision === 'approve') {
                    await ensureWallet(request.buyer_id);
                    const credited = await store.run(`
                        UPDATE wallet_accounts SET balance_cents = balance_cents + ?, updated_at = ?
                        WHERE user_id = ? AND balance_cents <= ?
                    `, [request.amount_cents, reviewedAt, request.buyer_id, 2147483647 - request.amount_cents]);
                    if (!credited.changes) throw walletError('This wallet has reached its maximum balance.', 409);
                    await store.run(`
                        INSERT INTO wallet_transactions
                            (id, user_id, kind, amount_cents, reference_key, payment_reference, description, created_by, created_at)
                        VALUES (?, ?, 'credit', ?, ?, ?, ?, ?, ?)
                    `, [crypto.randomUUID(), request.buyer_id, request.amount_cents, `topup:${request.id}`,
                        request.payment_reference, 'Manually verified top-up', req.user.id, reviewedAt]);
                }
                return { id: request.id, status, reviewedAt };
            });
            res.json({ request: result });
        } catch (error) {
            if (error.status) return res.status(error.status).json({ error: error.message });
            next(error);
        }
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

    app.get('/api/listings', auth, async (req, res) => {
        if (req.query.scope === 'mine' && req.user.role !== 'farmer') return res.status(403).json({ error: 'A farmer account is required.' });
        const rows = req.query.scope === 'mine'
            ? await store.all('SELECT * FROM listings WHERE farmer_id = ? ORDER BY created_at DESC', [req.user.id])
            : await store.all('SELECT * FROM listings WHERE quantity > 0 ORDER BY created_at DESC');
        res.json({ listings: rows.map(publicListing) });
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
    app.post('/api/orders', auth, role('buyer'), async (req, res, next) => {
        const lines = req.body?.items;
        const address = text(req.body?.address, 300);
        const paymentMethod = req.body?.paymentMethod;
        if (!Array.isArray(lines) || lines.length < 1 || lines.length > 50) return res.status(400).json({ error: 'Add between 1 and 50 order items.' });
        if (!address) return res.status(400).json({ error: 'A delivery address is required.' });
        if (!PAYMENT_METHODS.has(paymentMethod)) return res.status(400).json({ error: 'Choose a supported payment method.' });
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
                    const listing = await store.get('SELECT * FROM listings WHERE id = ?', [productId]);
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
                    await ensureWallet(req.user.id);
                    const debited = await store.run(`
                        UPDATE wallet_accounts SET balance_cents = balance_cents - ?, updated_at = ?
                        WHERE user_id = ? AND balance_cents >= ?
                    `, [totalCents, createdAt, req.user.id, totalCents]);
                    if (!debited.changes) throw walletError('Your wallet balance is too low. Add funds, then try again.', 402);
                    await store.run(`
                        INSERT INTO wallet_transactions
                            (id, user_id, kind, amount_cents, reference_key, description, created_at)
                        VALUES (?, ?, 'debit', ?, ?, ?, ?)
                    `, [crypto.randomUUID(), req.user.id, totalCents, `checkout:${checkoutKey}`, 'Marketplace order payment', createdAt]);
                }
                const status = paymentMethod === 'Cash on delivery' ? 'Cash on delivery'
                    : paymentMethod === 'KITUI FARM Wallet' ? 'Paid with wallet' : 'Payment pending (demo)';
                const createdOrders = [];
                for (const items of byFarmer.values()) {
                    const id = `KF-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
                    const total = paymentMethod === 'KITUI FARM Wallet'
                        ? items.reduce((sum, item) => sum + Math.round(item.quantity * item.price * 100), 0) / 100
                        : items.reduce((sum, item) => sum + item.quantity * item.price, 0);
                    await store.run(`
                        INSERT INTO orders
                            (id, buyer_id, buyer_name, address, payment_method, status, total, checkout_key, created_at)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                    `, [id, req.user.id, req.user.name, address, paymentMethod, status, total, checkoutKey, createdAt]);
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
            res.status(result.replayed ? 200 : 201)
                .json({ orders: await Promise.all(result.orders.map(row => publicOrder(store, row))) });
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
            const validStatuses = new Set(['Packed', 'Dispatched', 'Completed', 'Cancelled']);
            if (!validStatuses.has(status)) return res.status(400).json({ error: 'Choose a valid order status.' });
            const isFarmerOrder = Boolean(await store.get('SELECT 1 FROM order_items WHERE order_id = ? AND farmer_id = ?',
                [order.id, req.user.id]));
            const canCancel = req.user.role === 'buyer' && order.buyer_id === req.user.id && status === 'Cancelled'
                && ['Pending', 'Cash on delivery', 'Payment pending (demo)', 'Paid with wallet'].includes(order.status);
            const canPack = req.user.role === 'farmer' && isFarmerOrder && status === 'Packed'
                && ['Cash on delivery', 'Paid', 'Paid with wallet', 'Payment pending (demo)'].includes(order.status);
            const canDispatch = req.user.role === 'farmer' && isFarmerOrder && status === 'Dispatched' && order.status === 'Packed';
            const canComplete = req.user.role === 'farmer' && isFarmerOrder && status === 'Completed' && order.status === 'Dispatched';
            if (!canCancel && !canPack && !canDispatch && !canComplete) return res.status(403).json({ error: 'You cannot make that order status change.' });
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
                        await ensureWallet(order.buyer_id);
                        const cents = Math.round(Number(order.total) * 100);
                        const refunded = await store.run(`
                            UPDATE wallet_accounts SET balance_cents = balance_cents + ?, updated_at = ?
                            WHERE user_id = ? AND balance_cents <= ?
                        `, [cents, new Date().toISOString(), order.buyer_id, 2147483647 - cents]);
                        if (!refunded.changes) throw walletError('The wallet cannot accept this refund right now.', 409);
                        await store.run(`
                            INSERT INTO wallet_transactions
                                (id, user_id, kind, amount_cents, reference_key, description, created_by, created_at)
                            VALUES (?, ?, 'credit', ?, ?, ?, ?, ?)
                        `, [crypto.randomUUID(), order.buyer_id, cents, `refund:${order.id}`, `Refund for cancelled order ${order.id}`, req.user.id, new Date().toISOString()]);
                    }
                }
            });
            res.json({ order: await publicOrder(store, await store.get('SELECT * FROM orders WHERE id = ?', [order.id])) });
        } catch (error) {
            if (error.status) return res.status(error.status).json({ error: error.message });
            next(error);
        }
    });

    app.delete('/api/orders/:id', auth, role('buyer'), async (req, res, next) => {
        try {
            const order = await store.get('SELECT * FROM orders WHERE id = ? AND buyer_id = ?', [req.params.id, req.user.id]);
            if (!order || order.buyer_hidden === true || order.buyer_hidden === 1) return res.status(404).json({ error: 'Order not found.' });
            await store.transaction(async () => {
                if (['Pending', 'Cash on delivery', 'Payment pending (demo)', 'Paid with wallet'].includes(order.status)) {
                    const changed = await store.run('UPDATE orders SET status = ?, buyer_hidden = true WHERE id = ? AND status = ?',
                        ['Cancelled', order.id, order.status]);
                    if (!changed.changes) throw walletError('This order has already changed. Refresh and try again.', 409);
                    const items = await store.all('SELECT product_id, farmer_id, quantity FROM order_items WHERE order_id = ?', [order.id]);
                    for (const item of items) {
                        await store.run('UPDATE listings SET quantity = quantity + ? WHERE id = ? AND farmer_id = ?',
                            [item.quantity, item.product_id, item.farmer_id]);
                    }
                } else {
                    await store.run('UPDATE orders SET buyer_hidden = true WHERE id = ?', [order.id]);
                }
                if (order.payment_method === 'KITUI FARM Wallet' && ['Pending', 'Cash on delivery', 'Payment pending (demo)', 'Paid with wallet'].includes(order.status)) {
                    await ensureWallet(order.buyer_id);
                    const cents = Math.round(Number(order.total) * 100);
                    const refunded = await store.run(`
                        UPDATE wallet_accounts SET balance_cents = balance_cents + ?, updated_at = ?
                        WHERE user_id = ? AND balance_cents <= ?
                    `, [cents, new Date().toISOString(), order.buyer_id, 2147483647 - cents]);
                    if (!refunded.changes) throw walletError('The wallet cannot accept this refund right now.', 409);
                    await store.run(`
                        INSERT INTO wallet_transactions
                            (id, user_id, kind, amount_cents, reference_key, description, created_by, created_at)
                        VALUES (?, ?, 'credit', ?, ?, ?, ?, ?)
                    `, [crypto.randomUUID(), order.buyer_id, cents, `refund:${order.id}`, `Refund for cancelled order ${order.id}`, req.user.id, new Date().toISOString()]);
                }
            });
            res.status(204).end();
        } catch (error) {
            if (error.status) return res.status(error.status).json({ error: error.message });
            next(error);
        }
    });

    app.post('/api/auth/password-reset', (req, res) => {
        const email = text(req.body?.email, 254).toLowerCase();
        if (!emailIsValid(email)) return res.status(400).json({ error: 'Enter a valid @gmail.com address.' });
        res.status(501).json({ error: 'Password reset email delivery is not configured for this local MVP.' });
    });

    app.get('/', (req, res) => res.sendFile(path.join(ROOT, 'login.html')));
    app.get('/wallet.html', (req, res) => {
        res.setHeader('Cache-Control', 'no-store');
        res.sendFile(path.join(ROOT, 'wallet.html'));
    });
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
