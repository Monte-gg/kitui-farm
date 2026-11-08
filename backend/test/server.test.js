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
