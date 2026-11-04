'use strict';

// The Postgres store is exercised through a fake pg Pool: there is no Postgres
// server in this project's local setup, so these tests pin the adapter
// behaviour that the routes depend on (placeholders, row shape, transaction
// routing, and unique-violation mapping) without a database.

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createPostgresStore } = require('../server');

const CONNECTION = 'postgresql://postgres:secret@db.example.com:5432/postgres';

function createFakePool() {
    const log = [];
    const record = (sql, params, pooled) => log.push({ sql: String(sql).trim(), params, pooled });
    const result = sql => {
        const select = /^select/i.test(String(sql).trim());
        const rows = select ? [{ id: 'row' }] : [];
        return { rows, rowCount: select ? rows.length : 2 };
    };
    class Pool {
        async query(sql, params) {
            record(sql, params, true);
            return result(sql);
        }
        async connect() {
            return {
                async query(sql, params) {
                    record(sql, params, false);
                    return result(sql);
                },
                release() {
                    log.push({ event: 'release' });
                }
            };
        }
        async end() {}
    }
    return { Pool, log, steps: () => log.map(entry => entry.event || entry.sql) };
}

test('converts ? placeholders to $n and returns rows and change counts', async () => {
    const { Pool, log } = createFakePool();
    const store = createPostgresStore(CONNECTION, { Pool });

    const row = await store.get('SELECT * FROM users WHERE email = ? AND phone = ?', ['a@b.c', '+254700000000']);
    assert.equal(row.id, 'row');
    assert.equal(log[0].sql, 'SELECT * FROM users WHERE email = $1 AND phone = $2');
    assert.deepEqual(log[0].params, ['a@b.c', '+254700000000']);

    const update = await store.run('UPDATE listings SET quantity = quantity - ? WHERE id = ?', [2, 'x']);
    assert.equal(update.changes, 2);
    assert.equal(log[1].sql, 'UPDATE listings SET quantity = quantity - $1 WHERE id = $2');
});

test('runs a transaction on a single client and commits', async () => {
    const { Pool, log, steps } = createFakePool();
    const store = createPostgresStore(CONNECTION, { Pool });

    await store.transaction(async () => {
        await store.run('UPDATE listings SET quantity = quantity - ? WHERE id = ?', [1, 'listing-1']);
        await store.get('SELECT * FROM listings WHERE id = ?', ['listing-1']);
    });

    assert.deepEqual(steps(), [
        'BEGIN',
        'UPDATE listings SET quantity = quantity - $1 WHERE id = $2',
        'SELECT * FROM listings WHERE id = $1',
        'COMMIT',
        'release'
    ]);
    assert.ok(log.filter(entry => 'pooled' in entry).every(entry => entry.pooled === false));
});

test('rolls back and releases the client when a transaction throws', async () => {
    const { Pool, steps } = createFakePool();
    const store = createPostgresStore(CONNECTION, { Pool });

    await assert.rejects(store.transaction(async () => { throw new Error('boom'); }), /boom/);
    assert.deepEqual(steps(), ['BEGIN', 'ROLLBACK', 'release']);
});

test('maps a Postgres unique violation to the errcode the routes check', async () => {
    class FailingPool {
        async query() {
            const error = new Error('duplicate key value violates unique constraint');
            error.code = '23505';
            throw error;
        }
        async connect() {
            return { async query() { return {}; }, release() {} };
        }
        async end() {}
    }
    const store = createPostgresStore(CONNECTION, { Pool: FailingPool });

    await assert.rejects(
        store.run('INSERT INTO users (id) VALUES (?)', ['duplicate']),
        error => error.errcode === 2067
    );
});
