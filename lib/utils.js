import { createHash } from 'node:crypto';

const ERROR_STATUS = {
    VOTING_CLOSED: 403,
    ALREADY_VOTED: 409,
    VOTER_NOT_FOUND: 404,
    CANDIDATE_NOT_FOUND: 404,
    CANDIDATE_HAS_VOTES: 409,
    VOTER_HAS_VOTED: 409,
    DUPLICATE_NUMBER: 409,
    DUPLICATE_VOTER: 409,
    DUPLICATE_NIT: 409,
    IDENTITY_MISMATCH: 409,
    REGISTRATION_CLOSED: 403,
    INVALID_NUMBER: 400,
    INVALID_NAME: 400,
    INVALID_CLASS: 400,
    INVALID_NIT: 400,
    INVALID_MISSIONS: 400,
    INVALID_JSON: 400,
    IMPORT_EMPTY: 400,
    IMPORT_TOO_LARGE: 413,
    NOT_FOUND: 404,
    UNAUTHORIZED: 401,
    FORBIDDEN: 403,
    RESULTS_HIDDEN: 403,
    PAYLOAD_TOO_LARGE: 413,
    VALIDATION_ERROR: 400,
    RATE_LIMITED: 429,
    CONFIG_MISSING: 500
};

const ERROR_MESSAGES = {
    VOTING_CLOSED: 'Bilik suara sedang ditutup oleh Panitia.',
    ALREADY_VOTED: 'NIT ini sudah menggunakan hak suara.',
    VOTER_NOT_FOUND: 'Data pemilih tidak ditemukan.',
    CANDIDATE_NOT_FOUND: 'Kandidat tidak ditemukan.',
    CANDIDATE_HAS_VOTES: 'Kandidat yang sudah menerima suara tidak dapat dihapus.',
    VOTER_HAS_VOTED: 'Pemilih yang sudah mencoblos tidak dapat dihapus.',
    DUPLICATE_NUMBER: 'Nomor urut sudah digunakan paslon lain.',
    DUPLICATE_VOTER: 'Data pemilih tersebut sudah terdaftar.',
    DUPLICATE_NIT: 'NIT tersebut sudah terdaftar.',
    IDENTITY_MISMATCH: 'NIT sudah terdaftar dengan nama/kelas berbeda. Hubungi panitia.',
    REGISTRATION_CLOSED: 'NIT belum terdaftar di DPT dan pendaftaran mandiri sedang ditutup.',
    INVALID_NUMBER: 'Nomor urut tidak valid.',
    INVALID_NAME: 'Nama wajib diisi.',
    INVALID_CLASS: 'Kelas wajib diisi (maksimal 40 karakter).',
    INVALID_NIT: 'NIT tidak valid. Gunakan 4–20 karakter huruf, angka, titik, garis bawah, atau strip.',
    INVALID_MISSIONS: 'Minimal satu misi wajib diisi.',
    INVALID_JSON: 'Format data tidak valid.',
    IMPORT_EMPTY: 'Tidak ada data pemilih yang bisa diimpor.',
    IMPORT_TOO_LARGE: 'Impor dibatasi maksimal 5.000 baris sekali jalan.',
    NOT_FOUND: 'Data tidak ditemukan.',
    UNAUTHORIZED: 'Anda belum masuk.',
    FORBIDDEN: 'Anda tidak memiliki akses.',
    RESULTS_HIDDEN: 'Hasil sementara sedang dirahasiakan oleh Panitia.',
    PAYLOAD_TOO_LARGE: 'Data yang dikirim terlalu besar.',
    VALIDATION_ERROR: 'Data yang dikirim tidak valid.',
    RATE_LIMITED: 'Terlalu banyak percobaan. Coba lagi nanti.',
    CONFIG_MISSING: 'Konfigurasi server belum lengkap.'
};

export function httpError(status, code, message) {
    const error = new Error(message || ERROR_MESSAGES[code] || 'Terjadi kesalahan.');
    error.status = status;
    error.code = code;
    return error;
}

export function mapDbError(error) {
    if (!error) return httpError(500, 'INTERNAL_ERROR');
    if (error.status && error.code) return error;

    const raw = String(error.message || error.details || '');

    for (const [code, status] of Object.entries(ERROR_STATUS)) {
        if (raw.includes(code)) {
            return httpError(status, code, ERROR_MESSAGES[code]);
        }
    }

    if (error.code === '23505') return httpError(409, 'DUPLICATE', 'Data sudah ada.');
    if (error.code === '23503') return httpError(409, 'RELATION_CONFLICT', 'Data masih dipakai.');
    return httpError(500, 'INTERNAL_ERROR', 'Terjadi kesalahan pada server.');
}

export function normalizeName(value) {
    return String(value || '').trim().replace(/\s+/g, ' ').toUpperCase();
}

export function normalizeClassName(value) {
    return String(value || '').trim().replace(/\s+/g, ' ').toUpperCase();
}

export function normalizeNit(value) {
    return String(value || '').trim().toUpperCase();
}

export const NIT_PATTERN = /^[A-Z0-9._-]{4,20}$/;

export function round1(value) {
    return Math.round(Number(value || 0) * 10) / 10;
}

export function turnout(totalVotes, totalVoters) {
    if (!totalVoters) return 0;
    return round1((totalVotes / totalVoters) * 100);
}

export function computeResults(candidates, totalVotes) {
    return candidates
        .map(candidate => {
            const votes = Number(candidate.votes) || 0;
            return {
                ...candidate,
                votes,
                pct: totalVotes ? round1((votes / totalVotes) * 100) : 0
            };
        })
        .sort((a, b) => b.votes - a.votes || a.number - b.number);
}

export function csvCell(value) {
    let text = String(value ?? '');
    if (/^[=+\-@]/.test(text)) text = "'" + text;
    return '"' + text.replace(/"/g, '""') + '"';
}

export function buildCsv({ stats, results, generatedAt }) {
    const rows = [
        ['E-VOTE TARUNA - REKAP HASIL PEMILIHAN'],
        ['Diekspor', generatedAt],
        ['Pemilih Terdaftar', stats.totalVoters],
        ['Total Suara Masuk', stats.totalVotes],
        ['Partisipasi', `${stats.turnout.toFixed(1)}%`],
        [],
        ['No Urut', 'Nama Paslon', 'Perolehan Suara', 'Persentase']
    ];

    results.forEach(result => {
        rows.push([String(result.number).padStart(2, '0'), result.name, result.votes, `${result.pct.toFixed(1)}%`]);
    });

    rows.push([]);
    rows.push(['TOTAL', '', stats.totalVotes, stats.totalVotes ? '100.0%' : '0.0%']);

    return rows.map(row => row.map(csvCell).join(',')).join('\r\n');
}

export function photoDataToBuffer(dataUrl) {
    if (typeof dataUrl !== 'string') {
        throw httpError(400, 'VALIDATION_ERROR', 'Foto tidak valid.');
    }
    if (dataUrl.length > 4_000_000) {
        throw httpError(413, 'PAYLOAD_TOO_LARGE', 'Ukuran foto terlalu besar. Maksimal sekitar 3MB.');
    }

    const match = /^data:(image\/(png|jpeg|webp));base64,([A-Za-z0-9+/=\s]+)$/.exec(dataUrl);
    if (!match) {
        throw httpError(400, 'VALIDATION_ERROR', 'Format foto harus PNG, JPEG, atau WEBP.');
    }

    const mime = match[1];
    const buffer = Buffer.from(match[3], 'base64');
    if (!buffer.length) {
        throw httpError(400, 'VALIDATION_ERROR', 'Foto kosong.');
    }
    if (buffer.length > 3 * 1024 * 1024) {
        throw httpError(413, 'PAYLOAD_TOO_LARGE', 'Ukuran foto maksimal 3MB.');
    }

    const ext = mime === 'image/png' ? 'png' : mime === 'image/webp' ? 'webp' : 'jpg';
    return { buffer, mime, ext };
}

export function hashIp(req) {
    const forwarded = req.headers['x-forwarded-for'];
    const raw = Array.isArray(forwarded) ? forwarded[0] : String(forwarded || '').split(',')[0];
    const ip = raw.trim() || req.socket?.remoteAddress || 'unknown';
    return createHash('sha256')
        .update(`${ip}|${process.env.SESSION_SECRET || 'evote'}`)
        .digest('hex');
}
