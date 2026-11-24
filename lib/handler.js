import { randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { getSupabase, getBucket } from './supabase.js';
import {
    createSession,
    readSession,
    setSessionCookie,
    clearSessionCookie,
    voterTtl,
    adminTtl
} from './session.js';
import {
    getSettings,
    getStats,
    getCandidates,
    resolveVoter,
    importVoters,
    getVoterById,
    getVoters,
    getTopVoters
} from './data.js';
import {
    httpError,
    mapDbError,
    normalizeName,
    normalizeClassName,
    normalizeNit,
    NIT_PATTERN,
    computeResults,
    buildCsv,
    photoDataToBuffer,
    hashIp
} from './utils.js';

const MAX_BODY_BYTES = 4_500_000;
const LOGIN_WINDOW_MINUTES = 15;
const MAX_LOGIN_ATTEMPTS = 8;

const voterLoginSchema = z.object({
    name: z.string().trim().min(1, 'Nama wajib diisi.').max(120),
    className: z.string().trim().min(1, 'Kelas wajib diisi.').max(40),
    nit: z.string().trim().min(1, 'NIT wajib diisi.').max(20)
}).superRefine((value, ctx) => {
    if (!NIT_PATTERN.test(normalizeNit(value.nit))) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['nit'],
            message: 'NIT harus 4–20 karakter huruf, angka, titik, garis bawah, atau strip.'
        });
    }
});

const voteSchema = z.object({
    candidateId: z.string().uuid('Kandidat tidak valid.')
});

const adminLoginSchema = z.object({
    pin: z.string().min(1, 'PIN wajib diisi.').max(200)
});

const candidateSchema = z.object({
    number: z.number().int().min(1).max(999),
    name: z.string().trim().min(1, 'Nama paslon wajib diisi.').max(160),
    photo: z.string().trim().max(2048).optional().default(''),
    vision: z.string().trim().min(1, 'Visi wajib diisi.').max(2000),
    mission: z.array(z.string().trim().min(1).max(500)).min(1, 'Minimal satu misi.').max(20)
}).superRefine((value, ctx) => {
    if (value.photo && !/^https?:\/\//i.test(value.photo)) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['photo'],
            message: 'URL foto harus diawali http:// atau https://.'
        });
    }
});

const voterImportSchema = z.object({
    rows: z.array(z.object({
        name: z.string().max(120),
        className: z.string().max(40),
        nit: z.string().max(20)
    })).min(1, 'Tidak ada data yang diimpor.').max(5000, 'Maksimal 5.000 baris per impor.'),
    disableSelfRegistration: z.boolean().optional().default(false)
});

const settingsSchema = z.object({
    isVotingOpen: z.boolean().optional(),
    allowPublicResults: z.boolean().optional(),
    allowSelfRegistration: z.boolean().optional()
}).refine(value =>
    value.isVotingOpen !== undefined
    || value.allowPublicResults !== undefined
    || value.allowSelfRegistration !== undefined
, {
    message: 'Tidak ada perubahan setting.'
});

const photoSchema = z.object({
    dataUrl: z.string().min(1, 'Foto wajib diisi.')
});

function json(res, status, payload) {
    res.statusCode = status;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.end(JSON.stringify(payload));
}

async function readJson(req) {
    if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) {
        return req.body;
    }
    if (typeof req.body === 'string' || Buffer.isBuffer(req.body)) {
        const raw = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : req.body;
        if (raw.length > MAX_BODY_BYTES) throw httpError(413, 'PAYLOAD_TOO_LARGE');
        if (!raw.trim()) return {};
        try {
            return JSON.parse(raw);
        } catch {
            throw httpError(400, 'INVALID_JSON');
        }
    }

    let raw = '';
    for await (const chunk of req) {
        raw += chunk;
        if (raw.length > MAX_BODY_BYTES) throw httpError(413, 'PAYLOAD_TOO_LARGE');
    }
    if (!raw.trim()) return {};
    try {
        return JSON.parse(raw);
    } catch {
        throw httpError(400, 'INVALID_JSON');
    }
}

function parseBody(schema, body) {
    const result = schema.safeParse(body);
    if (!result.success) {
        const issue = result.error.issues[0];
        const message = issue
            ? `${issue.path.join('.') || 'data'}: ${issue.message}`
            : 'Data tidak valid.';
        throw httpError(400, 'VALIDATION_ERROR', message);
    }
    return result.data;
}

async function requireAdmin(req) {
    const session = await readSession(req);
    if (!session || session.role !== 'admin') {
        throw httpError(401, 'UNAUTHORIZED');
    }
    return session;
}

async function audit(action, detail = {}) {
    try {
        await getSupabase().from('audit_logs').insert({
            actor: 'admin',
            action,
            detail
        });
    } catch (error) {
        console.error('[audit] gagal mencatat log:', error?.message || error);
    }
}

async function getStatusPayload() {
    const [settings, stats] = await Promise.all([getSettings(), getStats()]);
    return {
        isVotingOpen: settings.isVotingOpen,
        allowPublicResults: settings.allowPublicResults,
        allowSelfRegistration: settings.allowSelfRegistration,
        totalVoters: stats.totalVoters,
        totalVotes: stats.totalVotes,
        turnout: stats.turnout
    };
}

async function getResultsPayload(session) {
    const [settings, stats, candidates] = await Promise.all([
        getSettings(),
        getStats(),
        getCandidates({ withVotes: true })
    ]);

    const isAdmin = session?.role === 'admin';
    if (!settings.allowPublicResults && !isAdmin) {
        throw httpError(403, 'RESULTS_HIDDEN');
    }

    return {
        isVotingOpen: settings.isVotingOpen,
        allowPublicResults: settings.allowPublicResults,
        totalVoters: stats.totalVoters,
        totalVotes: stats.totalVotes,
        turnout: stats.turnout,
        results: computeResults(candidates, stats.totalVotes)
    };
}

async function route(req, res, method, path) {
    // ---------- publik ----------
    if (method === 'GET' && path === '/health') {
        const { error } = await getSupabase()
            .from('settings')
            .select('id', { count: 'exact', head: true })
            .eq('id', 1);
        if (error) throw mapDbError(error);
        return { ok: true, service: 'evote-taruna', time: new Date().toISOString() };
    }

    if (method === 'GET' && path === '/status') {
        return getStatusPayload();
    }

    if (method === 'GET' && path === '/candidates') {
        return { candidates: await getCandidates() };
    }

    if (method === 'GET' && path === '/results') {
        const session = await readSession(req);
        return getResultsPayload(session);
    }

    if (method === 'GET' && path === '/session') {
        const session = await readSession(req);
        if (!session) return { role: null };

        if (session.role === 'admin') {
            return { role: 'admin' };
        }

        if (session.role === 'voter' && session.sub) {
            const voter = await getVoterById(session.sub);
            if (!voter) {
                clearSessionCookie(res);
                return { role: null };
            }
            return {
                role: 'voter',
                voter: {
                    ...voter,
                    voteId: session.voteId || null
                }
            };
        }

        clearSessionCookie(res);
        return { role: null };
    }

    if (method === 'POST' && path === '/auth/voter/login') {
        const body = parseBody(voterLoginSchema, await readJson(req));
        const settings = await getSettings();
        if (!settings.isVotingOpen) throw httpError(403, 'VOTING_CLOSED');

        const { voter, isNew } = await resolveVoter({
            name: normalizeName(body.name),
            className: normalizeClassName(body.className),
            nit: normalizeNit(body.nit)
        });

        const token = await createSession(
            {
                role: 'voter',
                sub: voter.id,
                name: voter.name,
                className: voter.className,
                nit: voter.nit
            },
            voterTtl()
        );
        setSessionCookie(res, token, voterTtl());
        return { voter, isNew };
    }

    if (method === 'POST' && path === '/auth/logout') {
        clearSessionCookie(res);
        return { ok: true };
    }

    if (method === 'POST' && path === '/vote') {
        const session = await readSession(req);
        if (!session || session.role !== 'voter' || !session.sub) {
            throw httpError(401, 'UNAUTHORIZED');
        }

        const body = parseBody(voteSchema, await readJson(req));
        const { data, error } = await getSupabase().rpc('cast_vote', {
            p_voter_id: session.sub,
            p_candidate_id: body.candidateId
        });

        if (error) throw mapDbError(error);

        const row = Array.isArray(data) ? data[0] : data;
        if (!row) throw httpError(500, 'INTERNAL_ERROR');

        const token = await createSession(
            {
                role: 'voter',
                sub: session.sub,
                name: session.name,
                votedAt: row.voted_at,
                voteId: row.vote_id
            },
            voterTtl()
        );
        setSessionCookie(res, token, voterTtl());

        return {
            receipt: {
                code: row.vote_id,
                votedAt: row.voted_at,
                candidateName: row.candidate_name,
                candidateNumber: row.candidate_number
            }
        };
    }

    // ---------- admin ----------
    if (method === 'POST' && path === '/admin/login') {
        const body = parseBody(adminLoginSchema, await readJson(req));
        const pinHash = process.env.ADMIN_PIN_HASH;
        if (!pinHash) {
            throw httpError(500, 'CONFIG_MISSING', 'ADMIN_PIN_HASH belum diset di server.');
        }

        const supabase = getSupabase();
        const ipHash = hashIp(req);
        const since = new Date(Date.now() - LOGIN_WINDOW_MINUTES * 60 * 1000).toISOString();

        const { count, error: countError } = await supabase
            .from('admin_login_attempts')
            .select('id', { count: 'exact', head: true })
            .eq('ip_hash', ipHash)
            .gte('attempted_at', since);

        if (countError) throw mapDbError(countError);
        if ((count || 0) >= MAX_LOGIN_ATTEMPTS) {
            throw httpError(429, 'RATE_LIMITED');
        }

        let valid = false;
        try {
            valid = await bcrypt.compare(body.pin, pinHash);
        } catch {
            throw httpError(500, 'CONFIG_MISSING', 'ADMIN_PIN_HASH tidak valid.');
        }

        if (!valid) {
            await supabase.from('admin_login_attempts').insert({ ip_hash: ipHash });
            void Promise.resolve(
                supabase
                    .from('admin_login_attempts')
                    .delete()
                    .lt('attempted_at', new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString())
            ).catch(() => {});
            throw httpError(401, 'UNAUTHORIZED', 'PIN administrator salah.');
        }

        await supabase.from('admin_login_attempts').delete().eq('ip_hash', ipHash);

        const token = await createSession({ role: 'admin' }, adminTtl());
        setSessionCookie(res, token, adminTtl());
        await audit('admin.login');
        return { ok: true };
    }

    if (method === 'POST' && path === '/admin/logout') {
        clearSessionCookie(res);
        return { ok: true };
    }

    if (method === 'GET' && path === '/admin/overview') {
        await requireAdmin(req);

        const [settings, stats, candidates, topVoters, voters] = await Promise.all([
            getSettings(),
            getStats(),
            getCandidates({ withVotes: true }),
            getTopVoters(4),
            getVoters()
        ]);

        return {
            settings,
            stats,
            candidates,
            results: computeResults(candidates, stats.totalVotes),
            topVoters,
            voters
        };
    }

    if (method === 'POST' && path === '/admin/candidates') {
        await requireAdmin(req);
        const body = parseBody(candidateSchema, await readJson(req));

        const { data, error } = await getSupabase().rpc('save_candidate', {
            p_id: null,
            p_number: body.number,
            p_name: body.name,
            p_photo_url: body.photo || '',
            p_vision: body.vision,
            p_missions: body.mission
        });

        if (error) throw mapDbError(error);
        await audit('candidate.create', { id: data, number: body.number, name: body.name });
        return { id: data };
    }

    const candidateMatch = path.match(/^\/admin\/candidates\/([0-9a-fA-F-]{36})$/);

    if (candidateMatch && method === 'PUT') {
        await requireAdmin(req);
        const body = parseBody(candidateSchema, await readJson(req));

        const { data, error } = await getSupabase().rpc('save_candidate', {
            p_id: candidateMatch[1],
            p_number: body.number,
            p_name: body.name,
            p_photo_url: body.photo || '',
            p_vision: body.vision,
            p_missions: body.mission
        });

        if (error) throw mapDbError(error);
        await audit('candidate.update', { id: data, number: body.number, name: body.name });
        return { id: data };
    }

    if (candidateMatch && method === 'DELETE') {
        await requireAdmin(req);
        const { error } = await getSupabase().rpc('delete_candidate', { p_id: candidateMatch[1] });
        if (error) throw mapDbError(error);
        await audit('candidate.delete', { id: candidateMatch[1] });
        return { ok: true };
    }

    if (method === 'POST' && path === '/admin/upload-photo') {
        await requireAdmin(req);
        const body = parseBody(photoSchema, await readJson(req));
        const { buffer, mime, ext } = photoDataToBuffer(body.dataUrl);

        const objectPath = `candidates/${new Date().toISOString().slice(0, 10)}/${randomUUID()}.${ext}`;
        const bucket = getBucket();
        const supabase = getSupabase();

        const { error } = await supabase.storage
            .from(bucket)
            .upload(objectPath, buffer, {
                contentType: mime,
                cacheControl: '31536000',
                upsert: false
            });

        if (error) {
            console.error('[storage]', error);
            throw httpError(
                500,
                'STORAGE_ERROR',
                'Gagal mengunggah foto. Pastikan bucket "candidate-photos" sudah dibuat dan bersifat public.'
            );
        }

        const { data } = supabase.storage.from(bucket).getPublicUrl(objectPath);
        await audit('candidate.photo', { path: objectPath });
        return { url: data.publicUrl };
    }

    if (method === 'POST' && path === '/admin/voters/import') {
        await requireAdmin(req);
        const body = parseBody(voterImportSchema, await readJson(req));

        const rows = body.rows.map(row => ({
            name: normalizeName(row.name),
            className: normalizeClassName(row.className),
            nit: normalizeNit(row.nit)
        }));

        const summary = await importVoters(rows);

        let selfRegistrationDisabled = false;
        if (body.disableSelfRegistration) {
            const { error } = await getSupabase()
                .from('settings')
                .update({
                    allow_self_registration: false,
                    updated_at: new Date().toISOString()
                })
                .eq('id', 1);

            if (error) throw mapDbError(error);
            selfRegistrationDisabled = true;
        }

        await audit('voters.import', {
            added: summary.added,
            updated: summary.updated,
            skipped: summary.skipped,
            invalid: summary.invalid,
            selfRegistrationDisabled
        });

        return { ...summary, selfRegistrationDisabled };
    }

    const voterMatch = path.match(/^\/admin\/voters\/([0-9a-fA-F-]{36})$/);

    if (voterMatch && method === 'DELETE') {
        await requireAdmin(req);
        const { error } = await getSupabase().rpc('delete_voter', { p_id: voterMatch[1] });
        if (error) throw mapDbError(error);
        await audit('voter.delete', { id: voterMatch[1] });
        return { ok: true };
    }

    if (method === 'POST' && path === '/admin/settings') {
        await requireAdmin(req);
        const body = parseBody(settingsSchema, await readJson(req));

        const patch = { updated_at: new Date().toISOString() };
        if (body.isVotingOpen !== undefined) patch.is_voting_open = body.isVotingOpen;
        if (body.allowPublicResults !== undefined) patch.allow_public_results = body.allowPublicResults;
        if (body.allowSelfRegistration !== undefined) patch.allow_self_registration = body.allowSelfRegistration;

        const { data, error } = await getSupabase()
            .from('settings')
            .update(patch)
            .eq('id', 1)
            .select('is_voting_open, allow_public_results, allow_self_registration, updated_at')
            .single();

        if (error) throw mapDbError(error);
        await audit('settings.update', patch);

        return {
            settings: {
                isVotingOpen: Boolean(data.is_voting_open),
                allowPublicResults: Boolean(data.allow_public_results),
                allowSelfRegistration: Boolean(data.allow_self_registration),
                updatedAt: data.updated_at
            }
        };
    }

    if (method === 'POST' && path === '/admin/votes/reset') {
        await requireAdmin(req);
        const { error } = await getSupabase().rpc('reset_votes');
        if (error) throw mapDbError(error);
        await audit('votes.reset');
        return { ok: true };
    }

    if (method === 'GET' && path === '/admin/export.csv') {
        await requireAdmin(req);

        const [stats, candidates] = await Promise.all([
            getStats(),
            getCandidates({ withVotes: true })
        ]);
        const results = computeResults(candidates, stats.totalVotes);
        const generatedAt = new Date().toLocaleString('id-ID', {
            dateStyle: 'medium',
            timeStyle: 'medium',
            timeZone: 'Asia/Jakarta'
        });
        const csv = buildCsv({ stats, results, generatedAt });
        const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');

        await audit('votes.export');

        res.statusCode = 200;
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="rekap-evote-${stamp}.csv"`);
        res.setHeader('Cache-Control', 'no-store');
        res.end('\uFEFF' + csv);
        return undefined;
    }

    throw httpError(404, 'NOT_FOUND', 'Endpoint tidak ditemukan.');
}

export default async function handler(req, res) {
    try {
        const url = new URL(req.url, 'http://localhost');
        let path = url.pathname;

        if (!path.startsWith('/api')) {
            throw httpError(404, 'NOT_FOUND', 'Endpoint tidak ditemukan.');
        }

        path = path.slice(4) || '/';
        const result = await route(req, res, req.method || 'GET', path);

        if (result !== undefined && !res.writableEnded && !res.headersSent) {
            json(res, 200, result);
        }
    } catch (error) {
        const mapped = mapDbError(error);

        if (res.writableEnded || res.headersSent) {
            console.error('[api] respons sudah terkirim:', mapped.message);
            return;
        }

        if (!mapped.status || mapped.status >= 500) {
            console.error('[api]', error);
        }

        json(res, mapped.status || 500, {
            error: mapped.code || 'INTERNAL_ERROR',
            message: mapped.message
        });
    }
}
