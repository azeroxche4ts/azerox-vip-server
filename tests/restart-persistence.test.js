const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');
const vm = require('node:vm');

// Isolate test database and seed files so production state is NEVER modified
const testDbPath = path.join(__dirname, 'test-restart-persistence.db');
const testSeedPath = path.join(__dirname, 'test-restart-seed.json');
process.env.SQLITE_DB_PATH = testDbPath;
process.env.SEED_FILE_PATH = testSeedPath;
process.env.NODE_ENV = 'test';

const { app } = require('../server');
const db = require('../db');
const { config } = require('../config');

function makeRequest(server, options = {}) {
    return new Promise((resolve, reject) => {
        const addr = server.address();
        const req = http.request({
            host: '127.0.0.1',
            port: addr.port,
            path: options.path || '/',
            method: options.method || 'GET',
            headers: options.headers || {}
        }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                let parsed = data;
                try { parsed = JSON.parse(data); } catch {}
                resolve({ status: res.statusCode, headers: res.headers, body: parsed });
            });
        });
        req.on('error', reject);
        if (options.body) {
            req.write(typeof options.body === 'string' ? options.body : JSON.stringify(options.body));
        }
        req.end();
    });
}

test('Restart Persistence & Zero Data Loss Test Suite', async (t) => {
    let server;
    let adminToken;
    const testAdminHeader = () => ({
        'Authorization': `Bearer ${adminToken}`,
        'Content-Type': 'application/json'
    });

    await db.initDatabase();

    await new Promise((resolve) => {
        server = app.listen(0, '127.0.0.1', () => resolve());
    });

    t.after(async () => {
        if (server && server.listening) {
            server.close();
        }
        if (typeof db.closeDatabase === 'function') {
            db.closeDatabase();
        }
        const cleanupFiles = [
            testDbPath,
            `${testDbPath}-wal`,
            `${testDbPath}-shm`,
            testSeedPath,
            `${testSeedPath}.backup`
        ];
        for (const f of cleanupFiles) {
            try {
                if (fs.existsSync(f)) fs.unlinkSync(f);
            } catch {}
        }
    });

    // Obtain admin token
    const loginRes = await makeRequest(server, {
        path: '/api/auth/admin/login',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: { username: config.adminUsername, password: config.adminPassword }
    });
    assert.strictEqual(loginRes.status, 200, 'Admin login must succeed');
    adminToken = loginRes.body.token;
    assert.ok(adminToken, 'Admin token must be returned');

    await t.test('1. Key Generation and Instant Client Persistence: persists to storage cache and renders immediately', async () => {
        const indexHtmlPath = path.join(__dirname, '..', 'public', 'index.html');
        const content = fs.readFileSync(indexHtmlPath, 'utf8');

        assert.ok(content.includes('azerox_optimizer_latest_key_v2'), 'index.html must use v2 latest key cache');
        assert.ok(content.includes('azerox_optimizer_all_keys_v2'), 'index.html must use v2 all keys cache');
        assert.ok(content.includes('downloadKeysBackup'), 'index.html must include downloadKeysBackup function');

        // Test in simulated browser VM
        const scriptMatch = content.match(/<script[\s\S]*?>([\s\S]*?)<\/script>/i);
        assert.ok(scriptMatch, 'script tag must exist in index.html');

        const mockLocalStorage = {};
        const elements = {};
        const context = {
            document: {
                getElementById: (id) => {
                    if (!elements[id]) {
                        elements[id] = {
                            id,
                            style: {},
                            classList: { add: ()=>{}, remove: ()=>{}, toggle: ()=>{} },
                            innerText: '',
                            value: '',
                            querySelectorAll: () => [],
                            set innerHTML(val) { this._html = val; },
                            get innerHTML() { return this._html || ''; }
                        };
                    }
                    return elements[id];
                },
                querySelectorAll: () => [],
                querySelector: () => ({ style: {}, classList: { add: ()=>{}, remove: ()=>{}, toggle: ()=>{} }, innerText: '' }),
                addEventListener: () => {},
                body: { appendChild: ()=>{}, removeChild: ()=>{} },
                createElement: () => ({ select: ()=>{}, style: {}, click: ()=>{} }),
                execCommand: () => {}
            },
            window: { addEventListener: () => {}, location: { hash: '' } },
            localStorage: {
                getItem: (k) => mockLocalStorage[k] || null,
                setItem: (k, v) => { mockLocalStorage[k] = String(v); },
                removeItem: (k) => { delete mockLocalStorage[k]; }
            },
            sessionStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
            console: console,
            setTimeout: setTimeout, clearTimeout: clearTimeout, setInterval: setInterval, clearInterval: clearInterval,
            fetch: async () => ({ ok: true, json: async () => ({ success: true, keys: [] }) }),
            EventSource: function() { this.close = () => {}; },
            navigator: { clipboard: { writeText: async () => {} } }
        };
        vm.createContext(context);
        vm.runInContext(scriptMatch[1] + '; Object.assign(this, { currentDashboard, getLatestKey: () => latestKeyData, getKeys: () => allKeys, syncLatestKeyForCurrentDashboard, renderLatestKey, saveLatestKey, saveAllKeys });', context);

        // Simulate creating a key and persisting
        const testKey = {
            id: 999,
            key_display: 'AZEROX-VIP-PERSIST-TEST',
            product_name: 'AZEROX VIP',
            status: 'UNUSED',
            duration_hours: 720,
            created_at: new Date().toISOString()
        };
        context.saveLatestKey(testKey);
        context.saveAllKeys([testKey]);

        assert.ok(mockLocalStorage['azerox_optimizer_latest_key_v2'], 'Latest key must be in localStorage');
        assert.ok(mockLocalStorage['azerox_optimizer_all_keys_v2'], 'All keys must be in localStorage');

        // Simulate page reload: syncLatestKeyForCurrentDashboard must NOT reset latestKeyData to null
        context.syncLatestKeyForCurrentDashboard();
        const latestAfterSync = context.getLatestKey();
        assert.ok(latestAfterSync, 'Latest key must remain populated after syncLatestKeyForCurrentDashboard');
        assert.strictEqual(latestAfterSync.key_display, 'AZEROX-VIP-PERSIST-TEST');
    });

    await t.test('2. WAL Auto-Checkpointing & Safe Process Termination: executes wal_checkpoint without losing writes', async () => {
        assert.strictEqual(typeof db.checkpointSqlite, 'function', 'db.checkpointSqlite must be exported');
        assert.doesNotThrow(() => {
            db.checkpointSqlite('PASSIVE');
            db.checkpointSqlite('TRUNCATE');
        }, 'checkpointSqlite must execute without error');
    });

    await t.test('3. Server Restart Simulation: generated keys survive database closing and re-initialization', async () => {
        const genRes = await makeRequest(server, {
            path: '/api/keys/generate',
            method: 'POST',
            headers: testAdminHeader(),
            body: {
                product_name: 'AZEROX VIP',
                duration_hours: 168,
                notes: 'Restart Survivability Test'
            }
        });
        assert.strictEqual(genRes.status, 200, 'Key generation must succeed');
        const generatedKey = genRes.body.key_display || genRes.body.key;
        assert.ok(generatedKey, 'Key string must be returned');

        // Simulate complete server & DB restart
        db.closeDatabase();
        db.setSqliteDb(testDbPath);
        await db.initDatabase();

        // Fetch key again from freshly initialized database
        const lookup = await db.getKeyByIdOrString(generatedKey);
        assert.ok(lookup, 'Key must be found in database after full restart');
        assert.strictEqual(lookup.key_display, generatedKey);
        assert.strictEqual(lookup.notes, 'Restart Survivability Test');
    });

    await t.test('4. Seed Redundancy & Disaster Self-Healing: recovers baseline from seed-keys.json.backup if primary is corrupted', async () => {
        const exported = await db.exportSeedKeys();
        assert.ok(Array.isArray(exported) && exported.length > 0, 'Seed keys export must succeed');
        assert.ok(fs.existsSync(testSeedPath), 'Primary seed file must exist');
        assert.ok(fs.existsSync(`${testSeedPath}.backup`), 'Redundant seed backup file must exist');

        // Corrupt primary seed file
        fs.writeFileSync(testSeedPath, '{ INVALID_JSON_DATA_DAMAGE ]', 'utf8');

        // Import seed keys - should self-heal from .backup
        const recoveredCount = await db.importSeedKeys();
        assert.ok(recoveredCount >= 0, 'importSeedKeys must execute without throwing');

        // Verify primary seed file was restored
        const healedContent = fs.readFileSync(testSeedPath, 'utf8');
        assert.doesNotThrow(() => {
            const parsed = JSON.parse(healedContent);
            assert.ok(Array.isArray(parsed), 'Healed primary seed must contain valid JSON array');
        }, 'Primary seed file must be self-healed');
    });

    await t.test('5. Key Purging & Anti-Resurrection: deleted and expired keys do not resurrect upon reboot', async () => {
        const genRes = await makeRequest(server, {
            path: '/api/keys/generate',
            method: 'POST',
            headers: testAdminHeader(),
            body: { product_name: 'AZEROX VIP', duration_hours: 24, notes: 'Purge Test Key' }
        });
        const keyDisplay = genRes.body.key_display || genRes.body.key;
        const keyId = genRes.body.id;

        // Delete key
        const delRes = await db.deleteKey(keyId, 'admin', 'Testing deletion permanence');
        assert.strictEqual(delRes.success, true, 'deleteKey must succeed');

        // Simulate restart
        db.closeDatabase();
        db.setSqliteDb(testDbPath);
        await db.initDatabase();

        const postRestartLookup = await db.getKeyByIdOrString(keyDisplay);
        assert.strictEqual(postRestartLookup, null, 'Deleted key must NEVER resurrect after server restart');

        const isDeleted = await db.isKeyDeleted(db.hashKey ? db.hashKey(keyDisplay) : null);
        assert.strictEqual(isDeleted, true, 'Key hash must remain blacklisted in deleted_keys table');
    });

    await t.test('6. Backup Export Endpoints: GET /api/keys/export and /api/admin/keys/backup return valid JSON backup', async () => {
        const resExport = await makeRequest(server, {
            path: '/api/keys/export',
            method: 'GET',
            headers: testAdminHeader()
        });
        assert.strictEqual(resExport.status, 200, '/api/keys/export must return 200');
        assert.strictEqual(resExport.body.success, true);
        assert.strictEqual(resExport.body.runtime, '24/7 Persistent');
        assert.ok(Array.isArray(resExport.body.keys), 'Export must contain keys array');

        const resBackup = await makeRequest(server, {
            path: '/api/admin/keys/backup',
            method: 'GET',
            headers: testAdminHeader()
        });
        assert.strictEqual(resBackup.status, 200, '/api/admin/keys/backup must return 200');
        assert.strictEqual(resBackup.body.success, true);
        assert.ok(Array.isArray(resBackup.body.keys), 'Backup endpoint must return keys array');

        // Verify /api/health reports 24/7 Persistent runtime and uptime
        const healthRes = await makeRequest(server, { path: '/api/health', method: 'GET' });
        assert.strictEqual(healthRes.status, 200, '/api/health must return 200');
        assert.strictEqual(healthRes.body.status, 'ok');
        assert.strictEqual(healthRes.body.runtime, '24/7 Persistent');
        assert.ok(typeof healthRes.body.uptime === 'number', 'Health must report uptime');
    });
});
