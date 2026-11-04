'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const express = require('express');

const ROOT = path.resolve(__dirname, '..');
const COOKIE = 'kitui_farm_session';
const SESSION_MS = 30 * 24 * 60 * 60 * 1000;
const DEFAULT_SETTINGS = { theme: 'system', density: 'comfortable', confirmDeletes: true };
const CATEGORIES = new Set(['Fruits', 'Vegetables', 'Grains & Pulses', 'Roots & Tubers']);
const PAYMENT_METHODS = new Set([
    'Cash on delivery', 'M-PESA (demo)', 'Airtel Money (demo)', 'Bank transfer (demo)'
]);
const PAGES = [
    'buyer-dashboard.html', 'farmer-dashboard.html', 'forgot-password.html', 'login.html',
    'payment.html', 'profile.html', 'settings.html', 'signup.html'
];

function createDatabase(dbPath) {
    if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const db = new DatabaseSync(dbPath);
    db.exec(`
        PRAGMA foreign_keys = ON;
        PRAGMA journal_mode = WAL;
        CREATE TABLE IF NOT EXISTS users (
            id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL COLLATE NOCASE UNIQUE,
            phone TEXT NOT NULL UNIQUE, role TEXT NOT NULL CHECK (role IN ('buyer', 'farmer')),
            password_salt TEXT NOT NULL, password_hash TEXT NOT NULL, location TEXT NOT NULL DEFAULT '',
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
        CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions(expires_at);
        CREATE INDEX IF NOT EXISTS idx_listings_farmer ON listings(farmer_id);
        CREATE INDEX IF NOT EXISTS idx_orders_buyer ON orders(buyer_id);
        CREATE INDEX IF NOT EXISTS idx_order_items_farmer ON order_items(farmer_id);
    `);
    seedListings(db);
    return db;
}

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

function publicUser(user) {
    return { id: user.id, name: user.name, email: user.email, phone: user.phone, role: user.role, location: user.location };
}

function publicListing(row) {
    return {
        id: row.id, farmerId: row.farmer_id, sellerName: row.seller_name, name: row.name,
        category: row.category, quantity: row.quantity, minimumOrder: row.minimum_order,
        price: row.price, location: row.location, image: row.image, createdAt: row.created_at
    };
}

function publicOrder(db, row) {
    const items = db.prepare('SELECT product_id, farmer_id, name, seller_name, location, quantity, price FROM order_items WHERE order_id = ?')
        .all(row.id).map(item => ({
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
            if (image.length > 1000000 || (image && !/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(image))) {
                return 'image must be a valid PNG, JPEG, or WebP data URL from an image under 700 KB.';
            }
            result.image = image;
        }
    }
    if (!Object.keys(result).length) return 'At least one listing field must be provided.';
    return result;
}

function createApp(options = {}) {
    const db = options.db || createDatabase(options.dbPath || process.env.DB_PATH || path.join(__dirname, 'data', 'kitui-farm.sqlite'));
    const app = express();
    const attempts = new Map();
    const secureCookie = process.env.NODE_ENV === 'production' ? '; Secure' : '';

    app.disable('x-powered-by');
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
            if (origin !== `${req.protocol}://${req.get('host')}`) {
                return res.status(403).json({ error: 'Cross-origin requests are not allowed.' });
            }
        }
        next();
    });
    app.use('/api', express.json({ limit: '2mb', strict: true }));

    function createSession(user, res, remember) {
        const token = crypto.randomBytes(32).toString('hex');
        const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
        const expiresAt = Date.now() + SESSION_MS;
        db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)')
            .run(tokenHash, user.id, expiresAt);
        const maxAge = remember ? `; Max-Age=${Math.floor(SESSION_MS / 1000)}` : '';
        res.setHeader('Set-Cookie', `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict${secureCookie}${maxAge}`);
    }

    function auth(req, res, next) {
        const token = cookies(req.headers.cookie)[COOKIE];
        if (!token || !/^[a-f0-9]{64}$/.test(token)) return res.status(401).json({ error: 'Please log in to continue.' });
        const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
        const session = db.prepare(`
            SELECT users.*, sessions.token_hash FROM sessions
            JOIN users ON users.id = sessions.user_id
            WHERE sessions.token_hash = ? AND sessions.expires_at > ?
        `).get(tokenHash, Date.now());
        if (!session) {
            db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash);
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

    function transaction(action) {
        db.exec('BEGIN IMMEDIATE');
        try {
            const value = action();
            db.exec('COMMIT');
            return value;
        } catch (error) {
            db.exec('ROLLBACK');
            throw error;
        }
    }

    app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

    app.post('/api/auth/signup', (req, res, next) => {
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
            db.prepare(`
                INSERT INTO users (id, name, email, phone, role, password_salt, password_hash, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            `).run(id, name, email, phone, accountRole, salt.toString('hex'), hash.toString('hex'), new Date().toISOString());
            const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
            createSession(user, res, Boolean(req.body.remember));
            res.status(201).json({ user: publicUser(user) });
        } catch (error) {
            if (error.errcode === 2067) {
                return res.status(409).json({ error: 'An account already exists with this email or phone number.' });
            }
            next(error);
        }
    });

    app.post('/api/auth/login', (req, res) => {
        const now = Date.now();
        const attempt = attempts.get(req.ip) || { count: 0, resetAt: now + 15 * 60 * 1000 };
        if (attempt.resetAt <= now) {
            attempt.count = 0;
            attempt.resetAt = now + 15 * 60 * 1000;
        }
        if (attempt.count >= 20) return res.status(429).json({ error: 'Too many sign-in attempts. Try again in 15 minutes.' });
        const identifier = text(req.body?.identifier, 254);
        const phone = normalizedPhone(identifier);
        const user = db.prepare('SELECT * FROM users WHERE email = ? OR phone = ?')
            .get(identifier.toLowerCase(), phone || identifier);
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
        createSession(user, res, Boolean(req.body.remember));
        res.json({ user: publicUser(user) });
    });

    app.post('/api/auth/logout', auth, (req, res) => {
        db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(req.tokenHash);
        res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secureCookie}`);
        res.status(204).end();
    });
    app.get('/api/auth/me', auth, (req, res) => res.json({ user: publicUser(req.user) }));
    app.get('/api/profile', auth, (req, res) => res.json({ user: publicUser(req.user) }));

    app.patch('/api/profile', auth, (req, res, next) => {
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
        if (!fields.length) return res.status(400).json({ error: 'No supported profile fields were supplied.' });
        try {
            db.prepare(`UPDATE users SET ${fields.join(', ')} WHERE id = ?`).run(...values, req.user.id);
            if (req.user.role === 'farmer' && 'name' in patch) {
                db.prepare('UPDATE listings SET seller_name = ? WHERE farmer_id = ?').run(text(patch.name, 100), req.user.id);
            }
            if (req.user.role === 'farmer' && 'location' in patch) {
                db.prepare('UPDATE listings SET location = ? WHERE farmer_id = ?').run(text(patch.location, 160), req.user.id);
            }
            res.json({ user: publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id)) });
        } catch (error) {
            if (error.errcode === 2067) return res.status(409).json({ error: 'That email or phone number is already in use.' });
            next(error);
        }
    });

    app.get('/api/settings', auth, (req, res) => {
        const row = db.prepare('SELECT settings_json FROM user_settings WHERE user_id = ?').get(req.user.id);
        res.json({ settings: row ? JSON.parse(row.settings_json) : DEFAULT_SETTINGS });
    });
    app.put('/api/settings', auth, (req, res) => {
        const value = req.body;
        if (!value || typeof value !== 'object' || Array.isArray(value)
            || !['system', 'light', 'dark'].includes(value.theme)
            || !['comfortable', 'compact'].includes(value.density)
            || typeof value.confirmDeletes !== 'boolean') {
            return res.status(400).json({ error: 'Settings contain an unsupported value.' });
        }
        const settings = { theme: value.theme, density: value.density, confirmDeletes: value.confirmDeletes };
        db.prepare(`
            INSERT INTO user_settings (user_id, settings_json) VALUES (?, ?)
            ON CONFLICT(user_id) DO UPDATE SET settings_json = excluded.settings_json
        `).run(req.user.id, JSON.stringify(settings));
        res.json({ settings });
    });

    app.get('/api/listings', auth, (req, res) => {
        if (req.query.scope === 'mine' && req.user.role !== 'farmer') return res.status(403).json({ error: 'A farmer account is required.' });
        const rows = req.query.scope === 'mine'
            ? db.prepare('SELECT * FROM listings WHERE farmer_id = ? ORDER BY created_at DESC').all(req.user.id)
            : db.prepare('SELECT * FROM listings WHERE quantity > 0 ORDER BY created_at DESC').all();
        res.json({ listings: rows.map(publicListing) });
    });
    app.post('/api/listings', auth, role('farmer'), (req, res) => {
        const listing = validateListing(req.body);
        if (typeof listing === 'string') return res.status(400).json({ error: listing });
        if (listing.quantity < listing.minimumOrder) return res.status(400).json({ error: 'Stock must meet the minimum order quantity.' });
        const id = crypto.randomUUID();
        db.prepare(`
            INSERT INTO listings (id, farmer_id, seller_name, name, category, quantity, minimum_order, price, location, image, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(id, req.user.id, req.user.name, listing.name, listing.category, listing.quantity,
            listing.minimumOrder, listing.price, listing.location, listing.image, new Date().toISOString());
        res.status(201).json({ listing: publicListing(db.prepare('SELECT * FROM listings WHERE id = ?').get(id)) });
    });
    app.patch('/api/listings/:id', auth, role('farmer'), (req, res) => {
        const current = db.prepare('SELECT * FROM listings WHERE id = ? AND farmer_id = ?').get(req.params.id, req.user.id);
        if (!current) return res.status(404).json({ error: 'Listing not found.' });
        const patch = validateListing(req.body, true);
        if (typeof patch === 'string') return res.status(400).json({ error: patch });
        const listing = { ...publicListing(current), ...patch };
        if (listing.quantity > 0 && listing.quantity < listing.minimumOrder) return res.status(400).json({ error: 'Stock must meet the minimum order quantity.' });
        db.prepare(`
            UPDATE listings SET name = ?, category = ?, quantity = ?, minimum_order = ?, price = ?, location = ?, image = ?
            WHERE id = ? AND farmer_id = ?
        `).run(listing.name, listing.category, listing.quantity, listing.minimumOrder, listing.price,
            listing.location, listing.image, req.params.id, req.user.id);
        res.json({ listing: publicListing(db.prepare('SELECT * FROM listings WHERE id = ?').get(req.params.id)) });
    });
    app.delete('/api/listings/:id', auth, role('farmer'), (req, res) => {
        const result = db.prepare('DELETE FROM listings WHERE id = ? AND farmer_id = ?').run(req.params.id, req.user.id);
        if (!result.changes) return res.status(404).json({ error: 'Listing not found.' });
        res.status(204).end();
    });

    app.get('/api/orders', auth, (req, res) => {
        const rows = req.user.role === 'buyer'
            ? db.prepare('SELECT * FROM orders WHERE buyer_id = ? AND buyer_hidden = 0 ORDER BY created_at DESC').all(req.user.id)
            : db.prepare(`
                SELECT DISTINCT orders.* FROM orders JOIN order_items ON order_items.order_id = orders.id
                WHERE order_items.farmer_id = ? ORDER BY orders.created_at DESC
            `).all(req.user.id);
        res.json({ orders: rows.map(row => publicOrder(db, row)) });
    });
    app.post('/api/orders', auth, role('buyer'), (req, res) => {
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
            const result = transaction(() => {
                const previousRequest = db.prepare('SELECT * FROM checkout_requests WHERE checkout_key = ?').get(checkoutKey);
                if (previousRequest) {
                    if (previousRequest.buyer_id !== req.user.id || previousRequest.payload_hash !== payloadHash) {
                        const error = new Error('This checkout ID was already used for a different request.');
                        error.status = 409;
                        throw error;
                    }
                    return {
                        replayed: true,
                        orders: db.prepare('SELECT * FROM orders WHERE checkout_key = ? ORDER BY id').all(checkoutKey)
                    };
                }
                db.prepare(`
                    INSERT INTO checkout_requests (checkout_key, buyer_id, payload_hash, created_at)
                    VALUES (?, ?, ?, ?)
                `).run(checkoutKey, req.user.id, payloadHash, new Date().toISOString());
                const byFarmer = new Map();
                for (const [productId, quantity] of uniqueLines) {
                    const listing = db.prepare('SELECT * FROM listings WHERE id = ?').get(productId);
                    if (!listing || listing.quantity < quantity || quantity < listing.minimum_order) {
                        const error = new Error('A cart item is no longer available in the requested quantity.');
                        error.status = 409;
                        throw error;
                    }
                    const result = db.prepare('UPDATE listings SET quantity = quantity - ? WHERE id = ? AND quantity >= ?')
                        .run(quantity, productId, quantity);
                    if (!result.changes) {
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
                const status = paymentMethod === 'Cash on delivery' ? 'Cash on delivery' : 'Payment pending (demo)';
                const createdAt = new Date().toISOString();
                const addItem = db.prepare(`
                    INSERT INTO order_items (order_id, product_id, farmer_id, name, seller_name, location, quantity, price)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                `);
                const createdOrders = [];
                for (const items of byFarmer.values()) {
                    const id = `KF-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
                    const total = items.reduce((sum, item) => sum + item.quantity * item.price, 0);
                    db.prepare(`
                        INSERT INTO orders
                            (id, buyer_id, buyer_name, address, payment_method, status, total, checkout_key, created_at)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                    `).run(id, req.user.id, req.user.name, address, paymentMethod, status, total, checkoutKey, createdAt);
                    for (const item of items) {
                        const listing = db.prepare('SELECT seller_name, location FROM listings WHERE id = ?').get(item.productId);
                        addItem.run(id, item.productId, item.farmerId, item.name, listing.seller_name, listing.location, item.quantity, item.price);
                    }
                    createdOrders.push(db.prepare('SELECT * FROM orders WHERE id = ?').get(id));
                }
                return { replayed: false, orders: createdOrders };
            });
            res.status(result.replayed ? 200 : 201)
                .json({ orders: result.orders.map(row => publicOrder(db, row)) });
        } catch (error) {
            if (error.status) return res.status(error.status).json({ error: error.message });
            throw error;
        }
    });
    app.patch('/api/orders/:id/status', auth, (req, res) => {
        const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
        if (!order) return res.status(404).json({ error: 'Order not found.' });
        const status = req.body?.status;
        const validStatuses = new Set(['Packed', 'Dispatched', 'Completed', 'Cancelled']);
        if (!validStatuses.has(status)) return res.status(400).json({ error: 'Choose a valid order status.' });
        const isFarmerOrder = Boolean(db.prepare('SELECT 1 FROM order_items WHERE order_id = ? AND farmer_id = ?')
            .get(order.id, req.user.id));
        const canCancel = req.user.role === 'buyer' && order.buyer_id === req.user.id && status === 'Cancelled'
            && ['Pending', 'Cash on delivery', 'Payment pending (demo)'].includes(order.status);
        const canPack = req.user.role === 'farmer' && isFarmerOrder && status === 'Packed'
            && ['Cash on delivery', 'Paid', 'Payment pending (demo)'].includes(order.status);
        const canDispatch = req.user.role === 'farmer' && isFarmerOrder && status === 'Dispatched' && order.status === 'Packed';
        const canComplete = req.user.role === 'farmer' && isFarmerOrder && status === 'Completed' && order.status === 'Dispatched';
        if (!canCancel && !canPack && !canDispatch && !canComplete) return res.status(403).json({ error: 'You cannot make that order status change.' });
        transaction(() => {
            db.prepare('UPDATE orders SET status = ? WHERE id = ?').run(status, order.id);
            if (status === 'Cancelled') {
                const items = db.prepare('SELECT product_id, farmer_id, quantity FROM order_items WHERE order_id = ?').all(order.id);
                for (const item of items) {
                    db.prepare('UPDATE listings SET quantity = quantity + ? WHERE id = ? AND farmer_id = ?')
                        .run(item.quantity, item.product_id, item.farmer_id);
                }
            }
        });
        res.json({ order: publicOrder(db, db.prepare('SELECT * FROM orders WHERE id = ?').get(order.id)) });
    });

    app.delete('/api/orders/:id', auth, role('buyer'), (req, res) => {
        const order = db.prepare('SELECT * FROM orders WHERE id = ? AND buyer_id = ?').get(req.params.id, req.user.id);
        if (!order || order.buyer_hidden) return res.status(404).json({ error: 'Order not found.' });
        transaction(() => {
            if (['Pending', 'Cash on delivery', 'Payment pending (demo)'].includes(order.status)) {
                const items = db.prepare('SELECT product_id, farmer_id, quantity FROM order_items WHERE order_id = ?').all(order.id);
                for (const item of items) {
                    db.prepare('UPDATE listings SET quantity = quantity + ? WHERE id = ? AND farmer_id = ?')
                        .run(item.quantity, item.product_id, item.farmer_id);
                }
                db.prepare('UPDATE orders SET status = ?, buyer_hidden = 1 WHERE id = ?').run('Cancelled', order.id);
            } else {
                db.prepare('UPDATE orders SET buyer_hidden = 1 WHERE id = ?').run(order.id);
            }
        });
        res.status(204).end();
    });

    app.post('/api/auth/password-reset', (req, res) => {
        const email = text(req.body?.email, 254).toLowerCase();
        if (!emailIsValid(email)) return res.status(400).json({ error: 'Enter a valid @gmail.com address.' });
        res.status(501).json({ error: 'Password reset email delivery is not configured for this local MVP.' });
    });

    app.get('/', (req, res) => res.sendFile(path.join(ROOT, 'login.html')));
    for (const page of PAGES) app.get(`/${page}`, (req, res) => res.sendFile(path.join(ROOT, page)));
    app.use('/api', (req, res) => res.status(404).json({ error: 'API endpoint not found.' }));
    app.use((error, req, res, next) => {
        if (res.headersSent) return next(error);
        if (error instanceof SyntaxError && 'body' in error) return res.status(400).json({ error: 'Request body must contain valid JSON.' });
        if (error.type === 'entity.too.large') return res.status(413).json({ error: 'Request body is too large.' });
        console.error(error);
        res.status(500).json({ error: 'An unexpected server error occurred.' });
    });
    return { app, db };
}

if (require.main === module) {
    const { app } = createApp();
    const port = Number(process.env.PORT) || 3000;
    app.listen(port, '127.0.0.1', () => console.log(`Kitui Farm API running at http://127.0.0.1:${port}`));
}

module.exports = { createApp };
