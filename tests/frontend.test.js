import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');

function json(data, status = 200) {
    return new Response(JSON.stringify(data), {
        status,
        headers: { 'Content-Type': 'application/json; charset=utf-8' }
    });
}

function delay(ms = 10) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitFor(predicate, label = 'kondisi') {
    for (let attempt = 0; attempt < 120; attempt += 1) {
        if (predicate()) return;
        await delay(10);
    }
    throw new Error(`Timeout menunggu ${label}`);
}

function createState() {
    return {
        session: { role: null },
        settings: { isVotingOpen: true, allowPublicResults: true, allowSelfRegistration: true },
        candidates: [
            {
                id: '11111111-1111-4111-8111-111111111111',
                number: 1,
                name: 'Paslon Satu',
                photo: '',
                vision: 'Visi satu',
                mission: ['Misi satu'],
                votes: 1
            },
            {
                id: '22222222-2222-4222-8222-222222222222',
                number: 2,
                name: 'Paslon Dua',
                photo: '',
                vision: 'Visi dua',
                mission: ['Misi dua'],
                votes: 1
            }
        ],
        voters: [
            { id: 'v1', name: 'TARUNA BUDI SANTOSO', className: '1A', nit: 'NIT2026002', votedAt: null },
            { id: 'v2', name: 'TARUNA CITRA DEWI', className: '1B', nit: 'NIT2026003', votedAt: '2026-11-23T03:00:00.000Z' },
            { id: 'v3', name: 'TARUNA DENI KURNIAWAN', className: '1B', nit: 'NIT2026004', votedAt: null }
        ]
    };
}

function stats(state) {
    const totalVotes = state.candidates.reduce((sum, item) => sum + Number(item.votes || 0), 0);
    const totalVoters = state.voters.length;
    return {
        totalVoters,
        totalVotes,
        turnout: totalVoters ? Math.round((totalVotes / totalVoters) * 1000) / 10 : 0
    };
}

function results(state) {
    const totalVotes = stats(state).totalVotes;
    return state.candidates
        .map(candidate => ({
            ...candidate,
            pct: totalVotes ? Math.round((candidate.votes / totalVotes) * 1000) / 10 : 0
        }))
        .sort((a, b) => b.votes - a.votes || a.number - b.number);
}

function createFetchMock(state) {
    return async function fetchMock(input, init = {}) {
        const url = new URL(String(input), 'http://localhost');
        const path = url.pathname;
        const method = (init.method || 'GET').toUpperCase();
        const body = init.body ? JSON.parse(init.body) : {};

        if (path === '/api/status' && method === 'GET') {
            return json({
                isVotingOpen: state.settings.isVotingOpen,
                allowPublicResults: state.settings.allowPublicResults,
                allowSelfRegistration: state.settings.allowSelfRegistration,
                ...stats(state)
            });
        }

        if (path === '/api/candidates' && method === 'GET') {
            return json({ candidates: state.candidates });
        }

        if (path === '/api/results' && method === 'GET') {
            if (!state.settings.allowPublicResults && state.session.role !== 'admin') {
                return json({ error: 'RESULTS_HIDDEN', message: 'Hasil sementara sedang dirahasiakan oleh Panitia.' }, 403);
            }
            return json({ ...stats(state), results: results(state) });
        }

        if (path === '/api/session' && method === 'GET') {
            return json(state.session);
        }

        if (path === '/api/auth/voter/login' && method === 'POST') {
            const name = String(body.name || '').trim().replace(/\s+/g, ' ').toUpperCase();
            const className = String(body.className || '').trim().replace(/\s+/g, ' ').toUpperCase();
            const nit = String(body.nit || '').trim().toUpperCase();
            if (!state.settings.isVotingOpen) {
                return json({ error: 'VOTING_CLOSED', message: 'Bilik suara sedang ditutup oleh Panitia.' }, 403);
            }
            if (!/^[A-Z0-9._-]{4,20}$/.test(nit)) {
                return json({ error: 'INVALID_NIT', message: 'NIT tidak valid.' }, 400);
            }

            let voter = state.voters.find(item => item.nit === nit);
            let isNew = false;

            if (voter) {
                if (voter.name !== name || voter.className !== className) {
                    return json({ error: 'IDENTITY_MISMATCH', message: 'NIT sudah terdaftar dengan nama/kelas berbeda. Hubungi panitia.' }, 409);
                }
                if (voter.votedAt) {
                    return json({ error: 'ALREADY_VOTED', message: 'NIT ini sudah menggunakan hak suara.' }, 409);
                }
            } else {
                if (!state.settings.allowSelfRegistration) {
                    return json({ error: 'REGISTRATION_CLOSED', message: 'NIT belum terdaftar di DPT dan pendaftaran mandiri sedang ditutup.' }, 403);
                }
                voter = { id: 'v-' + (state.voters.length + 1), name, className, nit, votedAt: null };
                state.voters.push(voter);
                isNew = true;
            }

            state.session = { role: 'voter', voter: { ...voter } };
            return json({ voter: { ...voter }, isNew });
        }

        if (path === '/api/auth/logout' && method === 'POST') {
            state.session = { role: null };
            return json({ ok: true });
        }

        if (path === '/api/vote' && method === 'POST') {
            if (!state.session.voter) {
                return json({ error: 'UNAUTHORIZED', message: 'Anda belum masuk.' }, 401);
            }
            const voter = state.voters.find(item => item.id === state.session.voter.id);
            if (voter.votedAt) {
                return json({ error: 'ALREADY_VOTED', message: 'NIT ini sudah menggunakan hak suara.' }, 409);
            }
            const candidate = state.candidates.find(item => item.id === body.candidateId);
            if (!candidate) {
                return json({ error: 'CANDIDATE_NOT_FOUND', message: 'Kandidat tidak ditemukan.' }, 404);
            }

            const votedAt = '2026-11-23T04:05:06.000Z';
            const voteId = '33333333-3333-4333-8333-333333333333';
            candidate.votes += 1;
            voter.votedAt = votedAt;
            state.session = { role: 'voter', voter: { ...voter } };

            return json({
                receipt: {
                    code: voteId,
                    votedAt,
                    candidateName: candidate.name,
                    candidateNumber: candidate.number
                }
            });
        }

        if (path === '/api/admin/login' && method === 'POST') {
            if (body.pin !== '123456') {
                return json({ error: 'UNAUTHORIZED', message: 'PIN administrator salah.' }, 401);
            }
            state.session = { role: 'admin' };
            return json({ ok: true });
        }

        if (path === '/api/admin/logout' && method === 'POST') {
            state.session = { role: null };
            return json({ ok: true });
        }

        if (path === '/api/admin/overview' && method === 'GET') {
            if (state.session.role !== 'admin') {
                return json({ error: 'UNAUTHORIZED', message: 'Anda belum masuk.' }, 401);
            }
            return json({
                settings: state.settings,
                stats: {
                    ...stats(state),
                    totalCandidates: state.candidates.length,
                    votedVoters: state.voters.filter(item => item.votedAt).length
                },
                candidates: state.candidates,
                results: results(state),
                topVoters: state.voters.filter(item => item.votedAt).slice(0, 4),
                voters: state.voters
            });
        }

        if (path === '/api/admin/settings' && method === 'POST') {
            if (state.session.role !== 'admin') {
                return json({ error: 'UNAUTHORIZED', message: 'Anda belum masuk.' }, 401);
            }
            if (typeof body.isVotingOpen === 'boolean') state.settings.isVotingOpen = body.isVotingOpen;
            if (typeof body.allowPublicResults === 'boolean') state.settings.allowPublicResults = body.allowPublicResults;
            if (typeof body.allowSelfRegistration === 'boolean') state.settings.allowSelfRegistration = body.allowSelfRegistration;
            return json({ settings: state.settings });
        }

        if (path === '/api/admin/candidates' && method === 'POST') {
            if (state.session.role !== 'admin') {
                return json({ error: 'UNAUTHORIZED', message: 'Anda belum masuk.' }, 401);
            }
            const id = '33333333-3333-4333-8333-333333333333';
            state.candidates.push({
                id,
                number: body.number,
                name: body.name,
                photo: body.photo || '',
                vision: body.vision,
                mission: body.mission,
                votes: 0
            });
            return json({ id });
        }

        if (path === '/api/admin/voters/import' && method === 'POST') {
            if (state.session.role !== 'admin') {
                return json({ error: 'UNAUTHORIZED', message: 'Anda belum masuk.' }, 401);
            }

            let added = 0;
            let updated = 0;
            let skipped = 0;
            let invalid = 0;
            const seen = new Set();

            (body.rows || []).forEach(row => {
                const name = String(row.name || '').trim().replace(/\s+/g, ' ').toUpperCase();
                const className = String(row.className || '').trim().replace(/\s+/g, ' ').toUpperCase();
                const nit = String(row.nit || '').trim().toUpperCase();

                if (!name || !className || !/^[A-Z0-9._-]{4,20}$/.test(nit) || seen.has(nit)) {
                    invalid += 1;
                    return;
                }
                seen.add(nit);

                const voter = state.voters.find(item => item.nit === nit);
                if (!voter) {
                    state.voters.push({ id: 'v-' + (state.voters.length + 1), name, className, nit, votedAt: null });
                    added += 1;
                } else if (voter.votedAt) {
                    skipped += 1;
                } else if (voter.name !== name || voter.className !== className) {
                    voter.name = name;
                    voter.className = className;
                    updated += 1;
                } else {
                    skipped += 1;
                }
            });

            let selfRegistrationDisabled = false;
            if (body.disableSelfRegistration) {
                state.settings.allowSelfRegistration = false;
                selfRegistrationDisabled = true;
            }

            return json({
                added,
                updated,
                skipped,
                invalid,
                errors: [],
                selfRegistrationDisabled
            });
        }

        return json({ error: 'NOT_FOUND', message: 'Endpoint belum dimock: ' + path }, 404);
    };
}

async function cleanupApp(dom) {
    dom.window.stopAdminPolling?.();
    dom.window.stopStatusPolling?.();
    dom.window.stopQuickCountPolling?.();
    await delay(20);
    dom.window.close();
}

function createApp(state) {
    const dom = new JSDOM(html, {
        url: 'http://localhost/',
        runScripts: 'dangerously',
        pretendToBeVisual: true,
        beforeParse(window) {
            window.tailwind = { config: {} };
            window.scrollTo = () => {};
            window.confetti = () => {};
            window.fetch = createFetchMock(state);
        }
    });

    return dom;
}

async function loginAdmin(dom) {
    const { document } = dom.window;
    dom.window.toggleAdminAuthModal();
    document.getElementById('adminPinInput').value = '123456';
    document.querySelector('#adminAuthModal form').dispatchEvent(
        new dom.window.Event('submit', { bubbles: true, cancelable: true })
    );
    await waitFor(() => !document.getElementById('adminSection').classList.contains('hidden'), 'dashboard admin tampil');
}

test('pemilih dapat login, memilih kandidat, dan menerima bukti suara', async (t) => {
    const state = createState();
    const dom = createApp(state);
    t.after(() => cleanupApp(dom));
    const { document } = dom.window;

    await waitFor(() => document.querySelectorAll('#candidatesGrid article').length === 2, 'kandidat tampil');

    document.getElementById('voterTokenInput').value = 'taruna budi santoso';
    document.getElementById('voterClassInput').value = '1a';
    document.getElementById('voterNitInput').value = 'nit2026002';
    document.getElementById('voterLoginForm').dispatchEvent(
        new dom.window.Event('submit', { bubbles: true, cancelable: true })
    );

    await waitFor(() => !document.getElementById('votingBooth').classList.contains('hidden'), 'bilik suara terbuka');
    assert.equal(document.getElementById('currentVoterDisplay').innerText, 'TARUNA BUDI SANTOSO');
    assert.match(document.getElementById('currentVoterMeta').innerText, /1A/);

    document.querySelector('#candidatesGrid [data-action="vote"]').click();
    assert.equal(document.getElementById('confirmVoteModal').classList.contains('hidden'), false);

    document.querySelector('#confirmVoteModal button[onclick="submitVote()"]').click();
    await waitFor(() => !document.getElementById('voteSuccessCard').classList.contains('hidden'), 'bukti suara tampil');

    assert.equal(document.getElementById('receiptVoterId').innerText, 'TARUNA BUDI SANTOSO');
    assert.equal(
        document.getElementById('receiptHash').innerText,
        '33333333-3333-4333-8333-333333333333'
    );
    assert.equal(state.voters[0].votedAt, '2026-11-23T04:05:06.000Z');
});

test('sesi pemilih yang sudah mencoblos dipulihkan saat halaman dimuat ulang', async (t) => {
    const state = createState();
    state.voters[0].votedAt = '2026-11-23T04:05:06.000Z';
    state.session = { role: 'voter', voter: { ...state.voters[0], voteId: '33333333-3333-4333-8333-333333333333' } };

    const dom = createApp(state);
    t.after(() => cleanupApp(dom));
    const { document } = dom.window;

    await waitFor(() => !document.getElementById('voteSuccessCard').classList.contains('hidden'), 'kartu bukti dipulihkan');
    assert.equal(document.getElementById('receiptVoterId').innerText, 'TARUNA BUDI SANTOSO');
    assert.equal(document.getElementById('votingBooth').classList.contains('hidden'), true);
});

test('suara yang sudah tercatat di server dipulihkan menjadi bukti suara', async (t) => {
    const state = createState();
    state.session = { role: 'voter', voter: { ...state.voters[0] } };
    const dom = createApp(state);
    t.after(() => cleanupApp(dom));
    const { document } = dom.window;

    await waitFor(() => !document.getElementById('votingBooth').classList.contains('hidden'), 'bilik suara terbuka');

    // Simulasi suara dikirim dari tab/perangkat lain setelah sesi ini dibuka.
    state.voters[0].votedAt = '2026-11-23T04:05:06.000Z';
    state.session = {
        role: 'voter',
        voter: { ...state.voters[0], voteId: '33333333-3333-4333-8333-333333333333' }
    };

    document.querySelector('#candidatesGrid [data-action="vote"]').click();
    document.querySelector('#confirmVoteModal button[onclick="submitVote()"]').click();

    await waitFor(() => !document.getElementById('voteSuccessCard').classList.contains('hidden'), 'bukti suara dipulihkan');
    assert.equal(document.getElementById('receiptVoterId').innerText, 'TARUNA BUDI SANTOSO');
    assert.equal(document.getElementById('receiptHash').innerText, '33333333-3333-4333-8333-333333333333');
    assert.equal(document.getElementById('confirmVoteModal').classList.contains('hidden'), true);
});

test('administrator dapat login dan menutup TPS', async (t) => {
    const state = createState();
    const dom = createApp(state);
    t.after(() => cleanupApp(dom));
    const { document } = dom.window;

    await waitFor(() => document.querySelectorAll('#candidatesGrid article').length === 2, 'aplikasi siap');
    assert.equal(document.getElementById('adminAuthModal').classList.contains('hidden'), true);

    await loginAdmin(dom);
    assert.equal(String(document.getElementById('statTotalVoters').innerText), '3');
    assert.equal(String(document.getElementById('statTotalVotes').innerText), '2');

    await dom.window.toggleVotingStatus();
    await waitFor(() => state.settings.isVotingOpen === false, 'TPS tertutup');
    assert.equal(document.getElementById('btnToggleVotingText').innerText, 'TPS: TUTUP');
    assert.equal(document.getElementById('votingStatusPill').innerText, 'TPS TUTUP');
});

test('administrator dapat menambah paslon, mengimpor DPT, dan menyembunyikan hasil', async (t) => {
    const state = createState();
    const dom = createApp(state);
    t.after(() => cleanupApp(dom));
    const { document } = dom.window;

    await waitFor(() => document.querySelectorAll('#candidatesGrid article').length === 2, 'aplikasi siap');
    await loginAdmin(dom);

    dom.window.openCandidateModal();
    document.getElementById('candNameInput').value = 'Paslon Tiga';
    document.getElementById('candVisionInput').value = 'Visi tiga';
    document.getElementById('candMissionInput').value = 'Misi tiga A\nMisi tiga B';
    document.querySelector('#candidateModal form').dispatchEvent(
        new dom.window.Event('submit', { bubbles: true, cancelable: true })
    );

    await waitFor(() => state.candidates.length === 3, 'paslon baru tersimpan');
    await waitFor(() => document.querySelectorAll('#candidatesGrid article').length === 3, 'kartu paslon baru tampil');
    assert.equal(document.getElementById('candidateModal').classList.contains('hidden'), true);

    dom.window.openImportVotersModal();
    document.getElementById('importVoterText').value = 'NAMA,KELAS,NIT\nTARUNA FAJAR,1C,NIT2026006';
    dom.window.updateImportPreview();
    assert.match(document.getElementById('importVoterPreview').innerText, /1 baris siap diimpor/);
    document.querySelector('#importVotersModal form').dispatchEvent(
        new dom.window.Event('submit', { bubbles: true, cancelable: true })
    );

    await waitFor(() => state.voters.length === 4, 'pemilih baru tersimpan');
    assert.equal(state.voters[3].name, 'TARUNA FAJAR');
    assert.equal(state.voters[3].className, '1C');
    assert.equal(state.voters[3].nit, 'NIT2026006');
    assert.equal(state.settings.allowSelfRegistration, false);

    await dom.window.togglePublicResults();
    await waitFor(() => state.settings.allowPublicResults === false, 'hasil publik disembunyikan');
    assert.equal(document.getElementById('btnTogglePublicResultText').innerText, 'Hasil Publik: OFF');
});

test('pemilih baru otomatis terdaftar saat pendaftaran mandiri aktif', async (t) => {
    const state = createState();
    const dom = createApp(state);
    t.after(() => cleanupApp(dom));
    const { document } = dom.window;

    await waitFor(() => document.querySelectorAll('#candidatesGrid article').length === 2, 'aplikasi siap');

    document.getElementById('voterTokenInput').value = 'taruna fajar';
    document.getElementById('voterClassInput').value = '1c';
    document.getElementById('voterNitInput').value = 'nit2026006';
    document.getElementById('voterLoginForm').dispatchEvent(
        new dom.window.Event('submit', { bubbles: true, cancelable: true })
    );

    await waitFor(() => !document.getElementById('votingBooth').classList.contains('hidden'), 'bilik suara terbuka');
    assert.equal(state.voters.length, 4);
    assert.equal(state.voters[3].nit, 'NIT2026006');
});

test('identitas yang tidak cocok dengan NIT ditolak', async (t) => {
    const state = createState();
    const dom = createApp(state);
    t.after(() => cleanupApp(dom));
    const { document } = dom.window;

    await waitFor(() => document.querySelectorAll('#candidatesGrid article').length === 2, 'aplikasi siap');

    document.getElementById('voterTokenInput').value = 'taruna lain';
    document.getElementById('voterClassInput').value = '1a';
    document.getElementById('voterNitInput').value = 'nit2026002';
    document.getElementById('voterLoginForm').dispatchEvent(
        new dom.window.Event('submit', { bubbles: true, cancelable: true })
    );

    await waitFor(() => (document.getElementById('toastMessage').innerText || document.getElementById('toastMessage').textContent || '').includes('nama/kelas berbeda'), 'pesan identitas ditolak');
    assert.equal(document.getElementById('votingBooth').classList.contains('hidden'), true);
    assert.equal(state.session.role, null);
});

test('parser impor DPT mendukung header, titik koma, dan tab', async (t) => {
    const state = createState();
    const dom = createApp(state);
    t.after(() => cleanupApp(dom));

    const rows = dom.window.parseVoterData('NIT;NAMA;KELAS\nNIT2026007;Taruna Gita;1c\n');
    assert.deepEqual(JSON.parse(JSON.stringify(rows)), [{ line: 2, name: 'TARUNA GITA', className: '1C', nit: 'NIT2026007' }]);

    const tabbed = dom.window.parseVoterData('TARUNA HADI\t1C\tNIT2026008');
    assert.deepEqual(JSON.parse(JSON.stringify(tabbed)), [{ line: 1, name: 'TARUNA HADI', className: '1C', nit: 'NIT2026008' }]);
});

test('pendaftaran mandiri yang ditutup menolak NIT baru', async (t) => {
    const state = createState();
    state.settings.allowSelfRegistration = false;
    const dom = createApp(state);
    t.after(() => cleanupApp(dom));
    const { document } = dom.window;

    await waitFor(() => document.querySelectorAll('#candidatesGrid article').length === 2, 'aplikasi siap');

    document.getElementById('voterTokenInput').value = 'taruna fajar';
    document.getElementById('voterClassInput').value = '1c';
    document.getElementById('voterNitInput').value = 'nit2026006';
    document.getElementById('voterLoginForm').dispatchEvent(
        new dom.window.Event('submit', { bubbles: true, cancelable: true })
    );

    await waitFor(() => (document.getElementById('toastMessage').innerText || document.getElementById('toastMessage').textContent || '').includes('pendaftaran mandiri'), 'pesan pendaftaran ditutup');
    assert.equal(state.voters.length, 3);
    assert.equal(document.getElementById('votingBooth').classList.contains('hidden'), true);
});
