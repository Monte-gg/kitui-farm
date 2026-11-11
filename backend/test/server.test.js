'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { afterEach, beforeEach, test } = require('node:test');
const { createApp } = require('../server');

let app;
let db;
let server;
let baseUrl;

beforeEach(async () => {
    ({ app, db } = createApp({ dbPath: ':memory:' }));
    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterEach(async () => {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    db.close();
});

async function request(path, { method = 'GET', body, cookie } = {}) {
    const headers = {};
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (cookie) headers.cookie = cookie;
    const response = await fetch(`${baseUrl}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body)
    });
    const result = {
        status: response.status,
        headers: response.headers,
        data: response.status === 204 ? null : await response.json(),
        cookie: response.headers.get('set-cookie')?.split(';', 1)[0]
    };
    return result;
}

async function signup(role, index) {
    const name = `${role} user ${index}`;
    const email = `${role}${index}@gmail.com`;
    const phone = `+254${role === 'farmer' ? '7' : '1'}${String(index).padStart(8, '0')}`;
    const salt = crypto.randomBytes(16);
    const passwordHash = crypto.scryptSync('StrongPass123', salt, 64,
        { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
    const id = crypto.randomUUID();
    await db.run(`INSERT INTO users (id, name, email, phone, role, password_salt, password_hash, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, name, email, phone, role, salt.toString('hex'), passwordHash.toString('hex'), new Date().toISOString()]);
    const response = await request('/api/auth/login', {
        method: 'POST', body: { identifier: email, password: 'StrongPass123' }
    });
    assert.equal(response.status, 200);
    return { ...response.data.user, cookie: response.cookie };
}

async function fundWallet(user, balance = 100000) {
    const created = await request('/api/wallet/create', { method: 'POST', cookie: user.cookie, body: {} });
    assert.equal(created.status, 201);
    await db.run('UPDATE wallet_accounts SET balance_cents = ? WHERE user_id = ?', [balance, user.id]);
    return created.data.wallet;
}

test('serves the health endpoint and existing app pages', async () => {
    assert.deepEqual((await request('/api/health')).data, { status: 'ok' });
    assert.equal((await fetch(`${baseUrl}/signup.html`)).status, 200);
});

test('authenticates users, rejects duplicate identities, and uses an HTTP-only cookie', async () => {
    const created = await signup('buyer', 1);
    assert.ok(created.cookie.startsWith('kitui_farm_session='));
    assert.equal(created.passwordHash, undefined);
    assert.equal((await request('/api/auth/me', { cookie: created.cookie })).data.user.id, created.id);

    const duplicate = await request('/api/auth/signup', {
        method: 'POST',
        body: {
            name: 'Another Buyer',
            email: 'buyer1@gmail.com',
            phone: '+254712345679',
            role: 'buyer',
            password: 'StrongPass123'
        }
    });
    assert.equal(duplicate.status, 409);

    const login = await request('/api/auth/login', {
        method: 'POST',
        body: { identifier: 'buyer1@gmail.com', password: 'StrongPass123' }
    });
    assert.equal(login.status, 200);
    assert.equal(login.data.user.id, created.id);
    assert.match(login.headers.get('set-cookie'), /HttpOnly/);

    const badLogin = await request('/api/auth/login', {
        method: 'POST',
        body: { identifier: 'buyer1@gmail.com', password: 'not-the-password' }
    });
    assert.equal(badLogin.status, 401);
});

test('persists profile and settings updates and rejects unauthenticated access', async () => {
    const buyer = await signup('buyer', 2);
    assert.equal((await request('/api/settings')).status, 401);
    const profile = await request('/api/profile', {
        method: 'PATCH',
        cookie: buyer.cookie,
        body: { name: 'Updated Buyer', location: 'Kitui Central' }
    });
    assert.equal(profile.data.user.name, 'Updated Buyer');
    assert.equal(profile.data.user.location, 'Kitui Central');

    const settings = { theme: 'dark', density: 'compact', confirmDeletes: false };
    assert.deepEqual((await request('/api/settings', {
        method: 'PUT', cookie: buyer.cookie, body: settings
    })).data.settings, settings);
    assert.deepEqual((await request('/api/settings', { cookie: buyer.cookie })).data.settings, settings);
});

test('enforces listing ownership, validates input, and completes an atomic order', async () => {
    const farmer = await signup('farmer', 3);
    const buyer = await signup('buyer', 3);
    const listingResponse = await request('/api/listings', {
        method: 'POST',
        cookie: farmer.cookie,
        body: {
            name: 'Fresh Cowpeas',
            category: 'Grains & Pulses',
            quantity: 25,
            minimumOrder: 5,
            price: 70,
            location: 'Kitui',
            image: ''
        }
    });
    assert.equal(listingResponse.status, 201);
    const listing = listingResponse.data.listing;
    assert.equal(listing.farmerId, farmer.id);
    assert.equal((await request('/api/listings', { cookie: buyer.cookie, method: 'POST', body: {} })).status, 403);
    assert.equal((await request(`/api/listings/${listing.id}`, {
        method: 'DELETE', cookie: buyer.cookie
    })).status, 403);

    await fundWallet(buyer);
    const checkoutId = crypto.randomUUID();
    const checkout = {
        checkoutId,
        items: [{ productId: listing.id, quantity: 10 }],
        address: 'Kitui Central',
        paymentMethod: 'KITUI FARM Wallet'
    };
    const orderResponse = await request('/api/orders', {
        method: 'POST',
        cookie: buyer.cookie,
        body: checkout
    });
    assert.equal(orderResponse.status, 201);
    assert.equal(orderResponse.data.orders[0].total, 700);
    assert.equal(orderResponse.data.orders[0].status, 'Processing');
    assert.equal(orderResponse.data.orders[0].paymentStatus, 'Paid with wallet');
    assert.equal((await request('/api/listings?scope=mine', { cookie: farmer.cookie })).data.listings[0].quantity, 15);
    assert.equal((await request('/api/orders', { cookie: farmer.cookie })).data.orders[0].id, orderResponse.data.orders[0].id);

    const replay = await request('/api/orders', { method: 'POST', cookie: buyer.cookie, body: checkout });
    assert.equal(replay.status, 200);
    assert.equal(replay.data.orders[0].id, orderResponse.data.orders[0].id);
    assert.equal((await request('/api/listings?scope=mine', { cookie: farmer.cookie })).data.listings[0].quantity, 15);

    const overOrder = await request('/api/orders', {
        method: 'POST',
        cookie: buyer.cookie,
        body: {
            checkoutId: crypto.randomUUID(),
            items: [{ productId: listing.id, quantity: 20 }],
            address: 'Kitui Central',
            paymentMethod: 'KITUI FARM Wallet'
        }
    });
    assert.equal(overOrder.status, 409);
    assert.equal((await request('/api/listings?scope=mine', { cookie: farmer.cookie })).data.listings[0].quantity, 15);
    assert.equal((await request('/api/orders', { cookie: buyer.cookie })).data.orders.length, 1);

    assert.equal((await request(`/api/orders/${orderResponse.data.orders[0].id}`, {
        method: 'DELETE', cookie: buyer.cookie
    })).status, 204);
    assert.equal((await request('/api/listings?scope=mine', { cookie: farmer.cookie })).data.listings[0].quantity, 25);
    assert.equal((await request('/api/orders', { cookie: buyer.cookie })).data.orders.length, 0);
    assert.equal((await request('/api/orders', { cookie: farmer.cookie })).data.orders[0].status, 'Cancelled');
    assert.equal((await request('/api/wallet', { cookie: buyer.cookie })).data.wallet.balance, 1000);
    assert.equal((await request('/api/wallet', { cookie: farmer.cookie })).data.wallet.balance, 0);
});

test('wallet checkout debits the buyer and credits each farmer exactly once', async () => {
    const farmer = await signup('farmer', 30);
    const buyer = await signup('buyer', 30);
    const buyerWallet = await fundWallet(buyer);

    const listingResponse = await request('/api/listings', {
        method: 'POST',
        cookie: farmer.cookie,
        body: {
            name: 'Wallet Checkout Maize', category: 'Grains & Pulses', quantity: 20,
            minimumOrder: 5, price: 70, location: 'Kitui', image: ''
        }
    });
    assert.equal(listingResponse.status, 201);
    const checkout = {
        checkoutId: crypto.randomUUID(),
        items: [{ productId: listingResponse.data.listing.id, quantity: 5 }],
        address: 'Kitui',
        paymentMethod: 'KITUI FARM Wallet'
    };
    const response = await request('/api/orders', { method: 'POST', cookie: buyer.cookie, body: checkout });
    assert.equal(response.status, 201);
    assert.equal(response.data.orders[0].status, 'Processing');
    assert.equal(response.data.orders[0].paymentStatus, 'Paid with wallet');

    const buyerWalletAfter = (await request('/api/wallet', { cookie: buyer.cookie })).data;
    const farmerWalletAfter = (await request('/api/wallet', { cookie: farmer.cookie })).data;
    assert.equal(buyerWalletAfter.wallet.balance, 650);
    assert.equal(farmerWalletAfter.wallet.balance, 350);
    assert.equal(buyerWalletAfter.transactions.filter(row => row.type === 'purchase' && row.status === 'completed').length, 1);
    const sale = farmerWalletAfter.transactions.find(row => row.type === 'sale');
    assert.equal(sale.amount, 350);
    assert.equal(sale.counterpartyWalletId, buyerWallet.id);

    const replay = await request('/api/orders', { method: 'POST', cookie: buyer.cookie, body: checkout });
    assert.equal(replay.status, 200);
    assert.equal((await request('/api/wallet', { cookie: buyer.cookie })).data.wallet.balance, 650);
    assert.equal((await request('/api/wallet', { cookie: farmer.cookie })).data.wallet.balance, 350);
});

test('wallet-to-wallet transfers credit the recipient once and debit the sender', async () => {
    const sender = await signup('buyer', 31);
    const recipient = await signup('farmer', 31);
    await fundWallet(sender, 100000);
    const recipientWallet = await fundWallet(recipient, 0);
    const idempotencyKey = crypto.randomUUID();
    const body = { recipient: recipientWallet.id, amount: 100, idempotencyKey };

    const transfer = await request('/api/wallet/transfers', { method: 'POST', cookie: sender.cookie, body });
    assert.equal(transfer.status, 201);
    assert.equal(transfer.data.transfer.status, 'completed');
    assert.equal((await request('/api/wallet', { cookie: sender.cookie })).data.wallet.balance, 900);
    const recipientWalletAfter = (await request('/api/wallet', { cookie: recipient.cookie })).data;
    assert.equal(recipientWalletAfter.wallet.balance, 100);
    assert.equal(recipientWalletAfter.transactions.filter(row => row.type === 'transfer' && row.direction === 'credit').length, 1);

    const replay = await request('/api/wallet/transfers', { method: 'POST', cookie: sender.cookie, body });
    assert.equal(replay.status, 200);
    assert.equal((await request('/api/wallet', { cookie: sender.cookie })).data.wallet.balance, 900);
    assert.equal((await request('/api/wallet', { cookie: recipient.cookie })).data.wallet.balance, 100);
});

test('splits multi-farmer checkouts so each farmer controls only their own order', async () => {
    const firstFarmer = await signup('farmer', 5);
    const secondFarmer = await signup('farmer', 6);
    const buyer = await signup('buyer', 5);
    const addListing = async (farmer, name) => {
        const response = await request('/api/listings', {
            method: 'POST',
            cookie: farmer.cookie,
            body: {
                name,
                category: 'Fruits',
                quantity: 40,
                minimumOrder: 5,
                price: 20,
                location: 'Kitui',
                image: ''
            }
        });
        assert.equal(response.status, 201);
        return response.data.listing;
    };
    const buyerWallet = await fundWallet(buyer);
    assert.ok(buyerWallet.id);
    const firstListing = await addListing(firstFarmer, 'Mangoes');
    const secondListing = await addListing(secondFarmer, 'Oranges');
    const checkout = await request('/api/orders', {
        method: 'POST',
        cookie: buyer.cookie,
        body: {
            checkoutId: crypto.randomUUID(),
            items: [
                { productId: firstListing.id, quantity: 5 },
                { productId: secondListing.id, quantity: 10 }
            ],
            address: 'Kitui',
            paymentMethod: 'KITUI FARM Wallet'
        }
    });
    assert.equal(checkout.status, 201);
    assert.equal(checkout.data.orders.length, 2);

    const firstOrders = (await request('/api/orders', { cookie: firstFarmer.cookie })).data.orders;
    const secondOrders = (await request('/api/orders', { cookie: secondFarmer.cookie })).data.orders;
    assert.equal(firstOrders.length, 1);
    assert.equal(secondOrders.length, 1);
    assert.equal(firstOrders[0].items[0].productId, firstListing.id);
    assert.equal(secondOrders[0].items[0].productId, secondListing.id);

    assert.equal((await request(`/api/orders/${firstOrders[0].id}/status`, {
        method: 'PATCH', cookie: firstFarmer.cookie, body: { status: 'Packed' }
    })).status, 200);
    const untouchedFarmerOrder = (await request('/api/orders', { cookie: secondFarmer.cookie })).data.orders[0];
    assert.equal(untouchedFarmerOrder.status, 'Processing');
    assert.equal(untouchedFarmerOrder.paymentStatus, 'Paid with wallet');
});

test('rejects cross-origin state changes and expires sessions on logout', async () => {
    const buyer = await signup('buyer', 4);
    const foreign = await fetch(`${baseUrl}/api/settings`, {
        method: 'PUT',
        headers: {
            cookie: buyer.cookie,
            origin: 'https://attacker.example',
            'content-type': 'application/json'
        },
        body: JSON.stringify({ theme: 'dark', density: 'compact', confirmDeletes: true })
    });
    assert.equal(foreign.status, 403);

    assert.equal((await request('/api/auth/logout', { method: 'POST', cookie: buyer.cookie })).status, 204);
    assert.equal((await request('/api/auth/me', { cookie: buyer.cookie })).status, 401);
});

test('returns reserved stock when a buyer cancels through the status endpoint', async () => {
    const farmer = await signup('farmer', 7);
    const buyer = await signup('buyer', 7);
    const listingResponse = await request('/api/listings', {
        method: 'POST',
        cookie: farmer.cookie,
        body: {
            name: 'Sweet Potatoes',
            category: 'Roots & Tubers',
            quantity: 30,
            minimumOrder: 5,
            price: 40,
            location: 'Kitui',
            image: ''
        }
    });
    assert.equal(listingResponse.status, 201);
    const listing = listingResponse.data.listing;
    await fundWallet(buyer);
    const checkout = await request('/api/orders', {
        method: 'POST',
        cookie: buyer.cookie,
        body: {
            checkoutId: crypto.randomUUID(),
            items: [{ productId: listing.id, quantity: 10 }],
            address: 'Kitui',
            paymentMethod: 'KITUI FARM Wallet'
        }
    });
    assert.equal(checkout.status, 201);
    const orderId = checkout.data.orders[0].id;
    const stock = async () => (await request('/api/listings?scope=mine', { cookie: farmer.cookie })).data.listings[0].quantity;
    assert.equal(await stock(), 20);

    const cancel = await request(`/api/orders/${orderId}/status`, {
        method: 'PATCH', cookie: buyer.cookie, body: { status: 'Cancelled' }
    });
    assert.equal(cancel.status, 200);
    assert.equal(cancel.data.order.status, 'Cancelled');
    assert.equal(await stock(), 30);
    assert.equal((await request('/api/wallet', { cookie: buyer.cookie })).data.wallet.balance, 1000);
    assert.equal((await request('/api/wallet', { cookie: farmer.cookie })).data.wallet.balance, 0);

    assert.equal((await request(`/api/orders/${orderId}/status`, {
        method: 'PATCH', cookie: buyer.cookie, body: { status: 'Cancelled' }
    })).status, 403);
    assert.equal(await stock(), 30);
});

// ---------------------------------------------------------------------------
// Daraja M-Pesa deposits and withdrawals
// ---------------------------------------------------------------------------

const MPESA_ENV_KEYS = ['MPESA_ENV', 'MPESA_CONSUMER_KEY', 'MPESA_CONSUMER_SECRET', 'MPESA_SHORTCODE',
    'MPESA_PASSKEY', 'MPESA_CALLBACK_SECRET', 'MPESA_CALLBACK_BASE_URL', 'MPESA_TRANSACTION_TYPE',
    'DARAJA_ENV', 'DARAJA_CONSUMER_KEY', 'DARAJA_CONSUMER_SECRET', 'DARAJA_INITIATOR_NAME',
    'DARAJA_SECURITY_CREDENTIAL', 'DARAJA_SHORTCODE', 'DARAJA_CALLBACK_SECRET', 'DARAJA_AUTO_PAYOUT',
    'RENDER_EXTERNAL_URL'];

function useMpesaEnv(overrides = {}) {
    const previous = Object.fromEntries(MPESA_ENV_KEYS.map(key => [key, process.env[key]]));
    for (const key of MPESA_ENV_KEYS) delete process.env[key];
    Object.assign(process.env, {
        MPESA_ENV: 'sandbox',
        MPESA_CONSUMER_KEY: 'test-consumer-key',
        MPESA_CONSUMER_SECRET: 'test-consumer-secret',
        MPESA_SHORTCODE: '174379',
        MPESA_PASSKEY: 'test-passkey',
        MPESA_CALLBACK_SECRET: 'c'.repeat(40),
        MPESA_CALLBACK_BASE_URL: 'https://kitui-farm.onrender.com',
        MPESA_TRANSACTION_TYPE: 'CustomerPayBillOnline'
    }, overrides);
    return () => {
        for (const key of MPESA_ENV_KEYS) {
            if (previous[key] === undefined) delete process.env[key];
            else process.env[key] = previous[key];
        }
    };
}

function stubDaraja(routes) {
    const realFetch = global.fetch;
    const calls = [];
    global.fetch = async (url, options = {}) => {
        const target = String(url);
        if (target.startsWith('https://sandbox.safaricom.co.ke') || target.startsWith('https://api.safaricom.co.ke')) {
            const body = options.body ? JSON.parse(options.body) : null;
            calls.push({ target, body });
            if (target.includes('/oauth/v1/generate')) return jsonResponse({ access_token: 'test-token', expires_in: '3599' });
            for (const [fragment, reply] of routes) {
                if (target.includes(fragment)) return jsonResponse(reply, 200);
            }
            return jsonResponse({ errorMessage: `Unexpected Daraja call to ${target}` }, 404);
        }
        return realFetch(url, options);
    };
    return { calls, restore: () => { global.fetch = realFetch; } };
}

function jsonResponse(body, status = 200) {
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function stkCallback({ checkoutId, resultCode = 0, resultDesc = 'The service request is processed successfully.', amount = 250, receipt = 'QAB12CD34E', phone = 254712345678 }) {
    return {
        Body: {
            stkCallback: {
                MerchantRequestID: 'MR-1', CheckoutRequestID: checkoutId, ResultCode: resultCode, ResultDesc: resultDesc,
                ...(resultCode === 0 ? { CallbackMetadata: { Item: [
                    { Name: 'Amount', Value: amount },
                    { Name: 'MpesaReceiptNumber', Value: receipt },
                    { Name: 'TransactionDate', Value: 20261111134455 },
                    { Name: 'PhoneNumber', Value: phone }
                ] } } : {})
            }
        }
    };
}

test('reports Daraja M-Pesa availability without leaking credentials', async () => {
    const restore = useMpesaEnv({ MPESA_CONSUMER_KEY: '' });
    try {
        const buyer = await signup('buyer', 40);
        const config = await request('/api/wallet/mpesa/config', { cookie: buyer.cookie });
        assert.equal(config.data.stkEnabled, false);
        assert.equal(config.data.provider, 'daraja');
        const deposit = await request('/api/wallet/mpesa/deposits/stk', {
            method: 'POST', cookie: buyer.cookie,
            body: { amount: 100, phone: '0712345678', idempotencyKey: crypto.randomUUID() }
        });
        assert.equal(deposit.status, 503);
        assert.match(deposit.data.error, /M-Pesa STK Push is not configured/);
        assert.equal(JSON.stringify(config.data).includes('test-consumer-key'), false);
    } finally { restore(); }
});

test('starts a Daraja STK Push deposit and credits the wallet exactly once', async () => {
    const buyer = await signup('buyer', 41);
    await fundWallet(buyer, 0);
    const restoreEnv = useMpesaEnv();
    const daraja = stubDaraja([['/mpesa/stkpush/v1/processrequest', {
        MerchantRequestID: 'MR-1', CheckoutRequestID: 'ws_CO_DEPOSIT_1', ResponseCode: '0',
        ResponseDescription: 'Success. Request accepted for processing',
        CustomerMessage: 'Success. Request accepted for processing'
    }]]);
    try {
        const deposit = await request('/api/wallet/mpesa/deposits/stk', {
            method: 'POST', cookie: buyer.cookie,
            body: { amount: 250, phone: '0712 345 678', idempotencyKey: crypto.randomUUID() }
        });
        assert.equal(deposit.status, 202);
        assert.equal(deposit.data.operation.status, 'processing');
        const push = daraja.calls.find(call => call.target.includes('/processrequest'));
        assert.equal(push.body.Amount, 250);
        assert.equal(push.body.PhoneNumber, '254712345678');
        assert.equal(push.body.BusinessShortCode, '174379');
        assert.equal(push.body.CallBackURL, `https://kitui-farm.onrender.com/api/payments/mpesa/callback/${'c'.repeat(40)}`);
        assert.match(push.body.Timestamp, /^\d{14}$/);
        assert.equal(Buffer.from(push.body.Password, 'base64').toString(), `174379test-passkey${push.body.Timestamp}`);

        const callback = await request(`/api/payments/mpesa/callback/${'c'.repeat(40)}`, {
            method: 'POST', body: stkCallback({ checkoutId: 'ws_CO_DEPOSIT_1' })
        });
        assert.equal(callback.status, 200);
        let wallet = (await request('/api/wallet', { cookie: buyer.cookie })).data;
        assert.equal(wallet.wallet.balance, 250);
        assert.equal(wallet.transactions.filter(row => row.type === 'deposit').length, 1);

        await request(`/api/payments/mpesa/callback/${'c'.repeat(40)}`, { method: 'POST', body: stkCallback({ checkoutId: 'ws_CO_DEPOSIT_1' }) });
        wallet = (await request('/api/wallet', { cookie: buyer.cookie })).data;
        assert.equal(wallet.wallet.balance, 250);
        assert.equal(wallet.transactions.filter(row => row.type === 'deposit').length, 1);

        const status = await request(`/api/wallet/mpesa/deposits/${deposit.data.operation.id}`, { cookie: buyer.cookie });
        assert.equal(status.data.operation.status, 'completed');
        assert.equal(status.data.operation.receipt, 'QAB12CD34E');
    } finally { daraja.restore(); restoreEnv(); }
});

test('records a cancelled M-Pesa prompt as a failed deposit without touching the balance', async () => {
    const buyer = await signup('buyer', 42);
    await fundWallet(buyer, 0);
    const restoreEnv = useMpesaEnv();
    const daraja = stubDaraja([['/mpesa/stkpush/v1/processrequest', {
        MerchantRequestID: 'MR-2', CheckoutRequestID: 'ws_CO_CANCEL_1', ResponseCode: '0',
        ResponseDescription: 'Success. Request accepted for processing'
    }]]);
    try {
        const deposit = await request('/api/wallet/mpesa/deposits/stk', {
            method: 'POST', cookie: buyer.cookie,
            body: { amount: 100, phone: '0712345678', idempotencyKey: crypto.randomUUID() }
        });
        assert.equal(deposit.status, 202);
        await request(`/api/payments/mpesa/callback/${'c'.repeat(40)}`, {
            method: 'POST', body: stkCallback({ checkoutId: 'ws_CO_CANCEL_1', resultCode: 1032, resultDesc: 'Request cancelled by user' })
        });
        const status = await request(`/api/wallet/mpesa/deposits/${deposit.data.operation.id}`, { cookie: buyer.cookie });
        assert.equal(status.data.operation.status, 'failed');
        assert.match(status.data.operation.message, /cancelled/i);
        assert.equal((await request('/api/wallet', { cookie: buyer.cookie })).data.wallet.balance, 0);
    } finally { daraja.restore(); restoreEnv(); }
});

test('reserves withdrawal funds, validates the M-Pesa number, and refunds a rejected request', async () => {
    const buyer = await signup('buyer', 43);
    await fundWallet(buyer, 100000);
    const admin = await signup('buyer', 44);
    await db.run('INSERT INTO wallet_admins (user_id, created_at) VALUES (?, ?)', [admin.id, new Date().toISOString()]);
    const restoreEnv = useMpesaEnv({ DARAJA_AUTO_PAYOUT: 'false' });
    try {
        const tooSmall = await request('/api/wallet/withdrawals', {
            method: 'POST', cookie: buyer.cookie,
            body: { amount: 5, phone: '0712345678', idempotencyKey: crypto.randomUUID() }
        });
        assert.equal(tooSmall.status, 400);
        const noPhone = await request('/api/wallet/withdrawals', {
            method: 'POST', cookie: buyer.cookie,
            body: { amount: 400, phone: '12345', idempotencyKey: crypto.randomUUID() }
        });
        assert.equal(noPhone.status, 400);

        const withdrawal = await request('/api/wallet/withdrawals', {
            method: 'POST', cookie: buyer.cookie,
            body: { amount: 400, phone: '0712 345 678', idempotencyKey: crypto.randomUUID() }
        });
        assert.equal(withdrawal.status, 202);
        assert.equal(withdrawal.data.operation.status, 'pending');
        assert.equal((await request('/api/wallet', { cookie: buyer.cookie })).data.wallet.balance, 600);

        const tooMuch = await request('/api/wallet/withdrawals', {
            method: 'POST', cookie: buyer.cookie,
            body: { amount: 5000, phone: '0712345678', idempotencyKey: crypto.randomUUID() }
        });
        assert.equal(tooMuch.status, 402);

        const requests = await request('/api/wallet/admin/operations', { cookie: admin.cookie });
        assert.equal(requests.data.requests.length, 1);
        assert.equal(requests.data.requests[0].details.phone, '+254712345678');
        const rejected = await request(`/api/wallet/admin/operations/${withdrawal.data.operation.id}/review`, {
            method: 'POST', cookie: admin.cookie, body: { decision: 'reject' }
        });
        assert.equal(rejected.status, 200);
        assert.equal((await request('/api/wallet', { cookie: buyer.cookie })).data.wallet.balance, 1000);
    } finally { restoreEnv(); }
});

test('pays a withdrawal through Daraja B2C automatically when DARAJA_AUTO_PAYOUT is on', async () => {
    const buyer = await signup('buyer', 45);
    await fundWallet(buyer, 100000);
    const restoreEnv = useMpesaEnv({
        DARAJA_ENV: 'sandbox',
        DARAJA_CONSUMER_KEY: 'b2c-key',
        DARAJA_CONSUMER_SECRET: 'b2c-secret',
        DARAJA_INITIATOR_NAME: 'testapi',
        DARAJA_SECURITY_CREDENTIAL: 'credential',
        DARAJA_SHORTCODE: '600000',
        DARAJA_CALLBACK_SECRET: 'd'.repeat(40),
        DARAJA_AUTO_PAYOUT: 'true',
        RENDER_EXTERNAL_URL: 'https://kitui-farm.onrender.com'
    });
    const daraja = stubDaraja([['/mpesa/b2c/v3/paymentrequest', {
        ConversationID: 'AG_20261111_1', OriginatorConversationID: 'ORIG_1', ResponseCode: '0',
        ResponseDescription: 'Accept the service request successfully.'
    }]]);
    try {
        const withdrawal = await request('/api/wallet/withdrawals', {
            method: 'POST', cookie: buyer.cookie,
            body: { amount: 400, phone: '0712345678', idempotencyKey: crypto.randomUUID() }
        });
        assert.equal(withdrawal.status, 202);
        assert.equal(withdrawal.data.operation.status, 'processing');
        const payout = daraja.calls.find(call => call.target.includes('/mpesa/b2c/v3/paymentrequest'));
        assert.equal(payout.body.Amount, '400');
        assert.equal(payout.body.PartyB, '254712345678');
        assert.equal(payout.body.PartyA, '600000');
        assert.match(payout.body.ResultURL, /\/api\/v1\/payments\/b2c-callback\?token=/);
        assert.equal((await request('/api/wallet', { cookie: buyer.cookie })).data.wallet.balance, 600);

        const wallet = (await request('/api/wallet', { cookie: buyer.cookie })).data;
        const details = wallet.operations[0].details;
        const callback = await request(`/api/v1/payments/b2c-callback?token=${'d'.repeat(40)}`, {
            method: 'POST',
            body: { Result: {
                ResultType: 0, ResultCode: 0, ResultDesc: 'The service request is processed successfully.',
                OriginatorConversationID: details.darajaOriginatorConversationID,
                ConversationID: 'AG_20261111_1', TransactionID: 'QCD33EFGHI',
                ResultParameters: { ResultParameter: [{ Key: 'TransactionAmount', Value: 400 }] }
            } }
        });
        assert.equal(callback.status, 200);
        const after = (await request('/api/wallet', { cookie: buyer.cookie })).data;
        assert.equal(after.wallet.balance, 1000, 'sandbox payouts return the reserved funds');
        assert.equal(after.operations[0].status, 'completed');
        assert.equal(after.operations[0].paymentReference, 'QCD33EFGHI');
        assert.ok(after.transactions.some(row => row.type === 'refund'));
    } finally { daraja.restore(); restoreEnv(); }
});

test('lets an administrator start a Daraja B2C payout from the admin console', async () => {
    const buyer = await signup('buyer', 46);
    await fundWallet(buyer, 100000);
    const admin = await signup('buyer', 47);
    await db.run('INSERT INTO wallet_admins (user_id, created_at) VALUES (?, ?)', [admin.id, new Date().toISOString()]);
    const restoreEnv = useMpesaEnv({
        DARAJA_CONSUMER_KEY: 'b2c-key', DARAJA_CONSUMER_SECRET: 'b2c-secret',
        DARAJA_INITIATOR_NAME: 'testapi', DARAJA_SECURITY_CREDENTIAL: 'credential',
        DARAJA_SHORTCODE: '600000', DARAJA_CALLBACK_SECRET: 'e'.repeat(40),
        DARAJA_AUTO_PAYOUT: 'false', RENDER_EXTERNAL_URL: 'https://kitui-farm.onrender.com'
    });
    const daraja = stubDaraja([['/mpesa/b2c/v3/paymentrequest', {
        ConversationID: 'AG_20261111_2', OriginatorConversationID: 'ORIG_2', ResponseCode: '0',
        ResponseDescription: 'Accept the service request successfully.'
    }]]);
    try {
        const withdrawal = await request('/api/wallet/withdrawals', {
            method: 'POST', cookie: buyer.cookie,
            body: { amount: 300, phone: '0712345678', idempotencyKey: crypto.randomUUID() }
        });
        assert.equal(withdrawal.data.operation.status, 'pending');

        const forbidden = await request(`/api/wallet/admin/operations/${withdrawal.data.operation.id}/daraja-payout`, {
            method: 'POST', cookie: buyer.cookie, body: {}
        });
        assert.equal(forbidden.status, 403);

        const payout = await request(`/api/wallet/admin/operations/${withdrawal.data.operation.id}/daraja-payout`, {
            method: 'POST', cookie: admin.cookie, body: {}
        });
        assert.equal(payout.status, 202);
        assert.equal(payout.data.operation.status, 'processing');
        const call = daraja.calls.find(item => item.target.includes('/mpesa/b2c/v3/paymentrequest'));
        assert.equal(call.body.Amount, '300');
        assert.equal(call.body.PartyB, '254712345678');
        assert.match(call.body.OriginatorConversationID, /^[A-Z0-9]{1,19}$/);

        const again = await request(`/api/wallet/admin/operations/${withdrawal.data.operation.id}/daraja-payout`, {
            method: 'POST', cookie: admin.cookie, body: {}
        });
        assert.equal(again.status, 409, 'a started payout cannot be sent twice');
        assert.equal((await request('/api/wallet', { cookie: buyer.cookie })).data.wallet.balance, 700);
    } finally { daraja.restore(); restoreEnv(); }
});
