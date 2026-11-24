import test from 'node:test';
import assert from 'node:assert/strict';
import { createSession, readSession, voterTtl, adminTtl } from '../lib/session.js';

process.env.SESSION_SECRET = 'test-secret-yang-panjangnya-lebih-dari-32-karakter';
process.env.COOKIE_SECURE = 'false';

function requestWithCookie(cookie) {
    return { headers: { cookie } };
}

test('sesi JWT dapat dibuat dan dibaca kembali', async () => {
    const token = await createSession({ role: 'voter', sub: 'voter-id', name: 'TARUNA TEST' }, voterTtl());
    const payload = await readSession(requestWithCookie(`evote_session=${encodeURIComponent(token)}`));

    assert.equal(payload.role, 'voter');
    assert.equal(payload.sub, 'voter-id');
    assert.equal(payload.name, 'TARUNA TEST');
});

test('token rusak atau cookie kosong dianggap tidak login', async () => {
    assert.equal(await readSession(requestWithCookie('')), null);
    assert.equal(await readSession(requestWithCookie('evote_session=token-palsu')), null);
});

test('durasi sesi admin dan voter berbeda', () => {
    assert.equal(voterTtl(), 4 * 60 * 60);
    assert.equal(adminTtl(), 8 * 60 * 60);
});
