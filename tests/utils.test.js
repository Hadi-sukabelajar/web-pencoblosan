import test from 'node:test';
import assert from 'node:assert/strict';
import {
    normalizeName,
    normalizeClassName,
    normalizeNit,
    NIT_PATTERN,
    computeResults,
    csvCell,
    buildCsv,
    httpError,
    mapDbError,
    photoDataToBuffer,
    turnout
} from '../lib/utils.js';

test('normalizeName merapikan spasi dan kapitalisasi', () => {
    assert.equal(normalizeName('  taruna   budi  santoso '), 'TARUNA BUDI SANTOSO');
    assert.equal(normalizeName(null), '');
});

test('normalizeClassName dan normalizeNit menyeragamkan input', () => {
    assert.equal(normalizeClassName('  xii   ipa 2 '), 'XII IPA 2');
    assert.equal(normalizeNit(' nit2026.001 '), 'NIT2026.001');
    assert.equal(NIT_PATTERN.test('NIT2026.001'), true);
    assert.equal(NIT_PATTERN.test('AB'), false);
    assert.equal(NIT_PATTERN.test('NIT 2026'), false);
});

test('mapDbError mengenali kode identitas pemilih', () => {
    const mismatch = mapDbError(new Error('IDENTITY_MISMATCH'));
    assert.equal(mismatch.code, 'IDENTITY_MISMATCH');
    assert.equal(mismatch.status, 409);

    const closed = mapDbError(new Error('REGISTRATION_CLOSED'));
    assert.equal(closed.status, 403);
});

test('computeResults menghitung persentase dan urutan suara', () => {
    const results = computeResults([
        { id: 'a', number: 1, name: 'A', votes: 3 },
        { id: 'b', number: 2, name: 'B', votes: 7 }
    ], 10);

    assert.equal(results[0].id, 'b');
    assert.equal(results[0].pct, 70);
    assert.equal(results[1].pct, 30);
});

test('computeResults aman saat belum ada suara', () => {
    const results = computeResults([{ id: 'a', number: 1, name: 'A', votes: 0 }], 0);
    assert.equal(results[0].pct, 0);
});

test('turnout dibulatkan satu desimal', () => {
    assert.equal(turnout(2, 3), 66.7);
    assert.equal(turnout(0, 0), 0);
});

test('csvCell mencegah formula injection', () => {
    assert.equal(csvCell('=SUM(A1)'), '"\'=SUM(A1)"');
    assert.equal(csvCell('Nama "Taruna"'), '"Nama ""Taruna"""');
});

test('buildCsv memuat ringkasan hasil', () => {
    const csv = buildCsv({
        stats: { totalVoters: 5, totalVotes: 3, turnout: 60 },
        results: [{ number: 1, name: 'Paslon A', votes: 3, pct: 100 }],
        generatedAt: '23 Nov 2026 10.00'
    });

    assert.match(csv, /E-VOTE TARUNA/);
    assert.match(csv, /Pemilih Terdaftar/);
    assert.match(csv, /Paslon A/);
});

test('mapDbError menerjemahkan error PostgreSQL menjadi kode API', () => {
    const error = mapDbError(new Error('ALREADY_VOTED'));
    assert.equal(error.status, 409);
    assert.equal(error.code, 'ALREADY_VOTED');
});

test('httpError memakai pesan default Bahasa Indonesia', () => {
    const error = httpError(404, 'VOTER_NOT_FOUND');
    assert.equal(error.message, 'Data pemilih tidak ditemukan.');
});

test('photoDataToBuffer menerima PNG valid', () => {
    const png = 'data:image/png;base64,iVBORw0KGgo=';
    const result = photoDataToBuffer(png);
    assert.equal(result.ext, 'png');
    assert.equal(result.mime, 'image/png');
    assert.ok(result.buffer.length > 0);
});

test('photoDataToBuffer menolak format selain gambar', () => {
    assert.throws(
        () => photoDataToBuffer('data:text/plain;base64,SGVsbG8='),
        /PNG, JPEG, atau WEBP/
    );
});
