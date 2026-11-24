#!/usr/bin/env node
/**
 * Provisioning otomatis: Supabase project + skema + seed, lalu deploy Vercel.
 *
 * Butuh file kredensial (default /tmp/opencode/secrets.env, bisa dioverride
 * dengan CLOUD_SECRETS_FILE):
 *
 *   SUPABASE_ACCESS_TOKEN=sbp_xxx     # Personal Access Token, bukan service role
 *   VERCEL_TOKEN=xxx                  # Token akun Vercel
 *   ADMIN_PIN=12345678                # opsional, dibuat otomatis bila kosong
 *   SUPABASE_ORG_SLUG=xxx             # opsional, default organisasi pertama
 *   SUPABASE_PROJECT_NAME=evote-taruna
 *   SUPABASE_REGION=ap-southeast-1
 *   SUPABASE_DB_PASSWORD=xxx          # opsional, dibuat otomatis bila kosong
 *   VERCEL_SCOPE=nama-tim            # opsional
 *   SKIP_VERCEL=1                     # opsional, hanya siapkan Supabase
 *
 * Jalankan: node scripts/cloud-bootstrap.mjs
 */
import { readFile, writeFile, chmod, stat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import bcrypt from 'bcryptjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const SUPABASE_API = process.env.SUPABASE_API_BASE || 'https://api.supabase.com/v1';
const VERCEL_API = process.env.VERCEL_API_BASE || 'https://api.vercel.com';

const log = message => console.log(`\x1b[36m[evote]\x1b[0m ${message}`);
const warn = message => console.log(`\x1b[33m[evote]\x1b[0m ${message}`);
const done = message => console.log(`\x1b[32m[evote]\x1b[0m ${message}`);

function fail(message, hint) {
    console.error(`\x1b[31m[evote] GAGAL:\x1b[0m ${message}`);
    if (hint) console.error(`        ${hint}`);
    process.exit(1);
}

async function exists(path) {
    try {
        await stat(path);
        return true;
    } catch {
        return false;
    }
}

function parseEnv(text) {
    const result = {};
    for (const raw of text.split(/\r?\n/)) {
        const line = raw.trim();
        if (!line || line.startsWith('#')) continue;
        const index = line.indexOf('=');
        if (index === -1) continue;
        const key = line.slice(0, index).trim();
        let value = line.slice(index + 1).trim();
        if (
            (value.startsWith('"') && value.endsWith('"')) ||
            (value.startsWith("'") && value.endsWith("'"))
        ) {
            value = value.slice(1, -1);
        }
        if (key) result[key] = value;
    }
    return result;
}

async function loadSecrets() {
    const candidates = [
        process.env.CLOUD_SECRETS_FILE,
        resolve(root, 'secrets.env'),
        resolve(root, '.env.cloud'),
        '/tmp/opencode/secrets.env'
    ].filter(Boolean);

    let merged = {};
    const used = [];
    for (const path of candidates) {
        if (!(await exists(path))) continue;
        const parsed = parseEnv(await readFile(path, 'utf8'));
        // Nilai kosong tidak menimpa nilai yang sudah terisi.
        for (const [key, value] of Object.entries(parsed)) {
            if (value !== '') merged[key] = value;
        }
        used.push(path);
    }

    if (used.length) log(`membaca kredensial dari ${used.join(', ')}`);
    return { used, values: merged };
}

async function api(base, path, { token, method = 'GET', body, auth = 'bearer', context = 'API', soft = false } = {}) {
    const headers = { Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (token) headers.Authorization = `Bearer ${token}`;
    if (auth === 'vercel') headers.Authorization = `Bearer ${token}`;

    let response;
    try {
        response = await fetch(base + path, {
            method,
            headers,
            body: body === undefined ? undefined : JSON.stringify(body)
        });
    } catch (error) {
        fail(`${context} tidak bisa dihubungi: ${error.message}`);
    }

    const text = await response.text();
    let parsed = null;
    if (text) {
        try {
            parsed = JSON.parse(text);
        } catch {
            parsed = text;
        }
    }

    if (!response.ok) {
        const detail = typeof parsed === 'string' ? parsed : JSON.stringify(parsed);
        if (soft) return { __error: true, status: response.status, detail };
        fail(`${context} ${method} ${path} → ${response.status}`, detail.slice(0, 600));
    }
    return parsed;
}

function generatePassword() {
    return randomBytes(18).toString('base64url');
}

function generatePin() {
    // 8 digit, mudah diketik di HP.
    let pin = '';
    for (const byte of randomBytes(8)) pin += String(byte % 10);
    return pin;
}

async function run(command, args, { cwd = root, env = process.env } = {}) {
    log(`$ ${command} ${args.join(' ')}`);
    return new Promise((resolvePromise, rejectPromise) => {
        const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
        let output = '';
        child.stdout.on('data', chunk => {
            const text = chunk.toString();
            output += text;
            process.stdout.write(text);
        });
        child.stderr.on('data', chunk => {
            const text = chunk.toString();
            output += text;
            process.stderr.write(text);
        });
        child.on('error', rejectPromise);
        child.on('close', code => {
            if (code === 0) resolvePromise(output);
            else rejectPromise(new Error(`perintah gagal (exit ${code}): ${command} ${args[0]}`));
        });
    });
}

// ---------------------------------------------------------------- Supabase

async function ensureSupabaseProject(config) {
    const { token, projectName, region, orgSlug, dbPassword, projectRef } = config;
    const projects = await api(SUPABASE_API, '/projects', {
        token,
        context: 'Supabase'
    });

    if (projectRef) {
        let target = projects.find(item => item.ref === projectRef);
        if (!target) {
            target = await api(SUPABASE_API, `/projects/${projectRef}`, {
                token,
                context: 'Supabase'
            });
        }
        done(`memakai project Supabase yang sudah ada: ${target.name} (${target.ref})`);
        return target.ref;
    }

    let project = projects.find(item => item.name === projectName);
    if (project) {
        done(`project Supabase sudah ada: ${project.name} (${project.ref})`);
    } else {
        let resolvedOrg = orgSlug;
        if (!resolvedOrg) {
            const organizations = await api(SUPABASE_API, '/organizations', {
                token,
                context: 'Supabase',
                soft: true
            });
            if (Array.isArray(organizations) && organizations.length) {
                resolvedOrg = organizations[0].slug;
            } else {
                // Fine-grained token tanpa organizations_read: ambil organisasi
                // dari project yang sudah ada.
                const known = projects.find(item => item.organization_slug);
                if (known) {
                    resolvedOrg = known.organization_slug;
                    warn('token tidak punya izin organizations_read, memakai organisasi dari project yang sudah ada');
                }
            }
        }

        if (!resolvedOrg) {
            fail(
                'tidak bisa menentukan organisasi Supabase',
                'Isi SUPABASE_ORG_SLUG di secrets.env, atau buat token dengan izin organizations_read.'
            );
        }

        log(`membuat project Supabase "${projectName}" di ${region} (org ${resolvedOrg})...`);
        project = await api(SUPABASE_API, '/projects', {
            token,
            method: 'POST',
            context: 'Supabase',
            soft: true,
            body: {
                name: projectName,
                organization_slug: resolvedOrg,
                db_pass: dbPassword,
                region_selection: { type: 'specific', code: region }
            }
        });

        if (project && project.__error) {
            if (project.status === 403) {
                fail(
                    'token Supabase tidak punya izin membuat project (projects_write)',
                    'Buat token baru di https://supabase.com/dashboard/account/tokens — pilih tipe Personal access token (bukan fine-grained), lalu isi ulang secrets.env.'
                );
            }
            fail(`gagal membuat project Supabase (${project.status})`, String(project.detail).slice(0, 500));
        }

        done(`project dibuat: ${project.ref}`);
    }

    const ref = project.ref;
    const deadline = Date.now() + 15 * 60 * 1000;
    let status = project.status;
    while (status !== 'ACTIVE_HEALTHY') {
        if (Date.now() > deadline) {
            fail(`project ${ref} belum siap (status ${status})`, 'Buka dashboard Supabase, tunggu provisioning selesai, lalu jalankan ulang skrip ini.');
        }
        log(`menunggu project siap... status=${status}`);
        await new Promise(resolvePromise => setTimeout(resolvePromise, 10000));
        const fresh = await api(SUPABASE_API, `/projects/${ref}`, { token, context: 'Supabase' });
        status = fresh.status;
    }
    done(`project ${ref} aktif`);
    return ref;
}

async function runSql(token, ref, label, sql) {
    log(`menjalankan ${label} (${sql.length.toLocaleString('id-ID')} karakter)...`);
    const result = await api(SUPABASE_API, `/projects/${ref}/database/query`, {
        token,
        method: 'POST',
        context: 'Supabase SQL',
        soft: true,
        body: { query: sql, disable_statement_timeout: true }
    });
    if (result && result.__error) {
        if (result.status === 403) {
            fail(
                `token Supabase tidak punya izin menjalankan SQL (database_write)`,
                'Buat token baru tipe Personal access token, lalu isi ulang secrets.env.'
            );
        }
        fail(`gagal menjalankan ${label} (${result.status})`, String(result.detail).slice(0, 800));
    }
    done(`${label} selesai`);
}

async function pickServiceKey(token, ref, supabaseUrl) {
    const keys = await api(SUPABASE_API, `/projects/${ref}/api-keys?reveal=true`, {
        token,
        context: 'Supabase',
        soft: true
    });
    if (!Array.isArray(keys)) {
        if (keys && keys.status === 403) {
            fail(
                'token Supabase tidak punya izin membaca API keys (secrets_read)',
                'Buat token baru tipe Personal access token, lalu isi ulang secrets.env.'
            );
        }
        fail('gagal mengambil API keys project', String(keys?.detail || '').slice(0, 500));
    }
    const legacyService = keys.find(item => item.type === 'legacy' && item.name === 'service_role');
    const secret = keys.find(item => item.type === 'secret');
    const candidates = [legacyService, secret]
        .filter(item => item && item.api_key)
        .map(item => item.api_key);

    if (!candidates.length) {
        fail('service role / secret key tidak ditemukan', 'Ambil manual dari Project Settings → API.');
    }

    // Pastikan key benar-benar bisa membaca tabel, bukan hanya ada di daftar.
    for (const key of candidates) {
        const response = await fetch(`${supabaseUrl}/rest/v1/settings?select=is_voting_open&limit=1`, {
            headers: { apikey: key, Authorization: `Bearer ${key}` }
        });
        if (response.ok) {
            done('service key terverifikasi bisa mengakses database');
            return key;
        }
    }

    fail(
        'service key tidak bisa membaca database',
        'Tunggu 1 menit lalu jalankan ulang, atau ambil service_role key manual dari Project Settings → API.'
    );
}

// ---------------------------------------------------------------- Vercel

async function readVercelProject() {
    const path = resolve(root, '.vercel/project.json');
    if (!(await exists(path))) return null;
    return JSON.parse(await readFile(path, 'utf8'));
}

async function upsertVercelEnv(token, projectId, teamId, variables) {
    const query = teamId ? `?teamId=${encodeURIComponent(teamId)}` : '';
    const list = await api(VERCEL_API, `/v9/projects/${projectId}/env${query}`, {
        token,
        context: 'Vercel'
    });
    const existing = new Map((list.envs || []).map(item => [item.key, item]));

    for (const [key, value] of Object.entries(variables)) {
        if (existing.has(key)) {
            const env = existing.get(key);
            await api(VERCEL_API, `/v9/projects/${projectId}/env/${env.id}${query}`, {
                token,
                method: 'PATCH',
                context: 'Vercel',
                body: { value, target: ['production', 'preview', 'development'] }
            });
            log(`env ${key} diperbarui`);
        } else {
            await api(VERCEL_API, `/v10/projects/${projectId}/env${query}`, {
                token,
                method: 'POST',
                context: 'Vercel',
                body: {
                    key,
                    value,
                    type: 'encrypted',
                    target: ['production', 'preview', 'development']
                }
            });
            log(`env ${key} ditambahkan`);
        }
    }
}

async function latestDeployment(token, projectId, teamId) {
    const query = new URLSearchParams({ projectId, limit: '1' });
    if (teamId) query.set('teamId', teamId);
    const result = await api(VERCEL_API, `/v6/deployments?${query}`, { token, context: 'Vercel' });
    return (result.deployments || [])[0] || null;
}

async function waitDeployment(token, deployment, teamId) {
    const query = teamId ? `?teamId=${encodeURIComponent(teamId)}` : '';
    const deadline = Date.now() + 10 * 60 * 1000;
    let current = deployment;
    while (current && current.readyState && !['READY', 'ERROR', 'CANCELED'].includes(current.readyState)) {
        if (Date.now() > deadline) fail('deployment Vercel melebihi 10 menit');
        await new Promise(resolvePromise => setTimeout(resolvePromise, 5000));
        current = await api(VERCEL_API, `/v13/deployments/${current.uid}${query}`, {
            token,
            context: 'Vercel'
        });
    }
    if (!current || current.readyState === 'ERROR') {
        fail('deployment Vercel gagal', 'Periksa log di dashboard Vercel.');
    }
    return current;
}

// ---------------------------------------------------------------- main

async function main() {
    const { values: secrets } = await loadSecrets();
    const merged = { ...secrets, ...process.env };
    const supabaseToken = merged.SUPABASE_ACCESS_TOKEN;
    const vercelToken = merged.VERCEL_TOKEN;

    if (!supabaseToken) fail('SUPABASE_ACCESS_TOKEN kosong', 'Token dibuat di https://supabase.com/dashboard/account/tokens');
    const skipVercel = merged.SKIP_VERCEL === '1' || merged.SKIP_VERCEL === 'true';
    if (!vercelToken && !skipVercel) fail('VERCEL_TOKEN kosong', 'Token dibuat di https://vercel.com/account/tokens');

    const projectName = merged.SUPABASE_PROJECT_NAME || 'evote-taruna';
    const region = merged.SUPABASE_REGION || 'ap-southeast-1';
    const dbPassword = merged.SUPABASE_DB_PASSWORD || generatePassword();
    const adminPin = merged.ADMIN_PIN || generatePin();
    const sessionSecret = merged.SESSION_SECRET || randomBytes(32).toString('hex');

    // 1. Supabase
    const ref = await ensureSupabaseProject({
        token: supabaseToken,
        projectName,
        region,
        orgSlug: merged.SUPABASE_ORG_SLUG,
        dbPassword,
        projectRef: merged.SUPABASE_PROJECT_REF
    });

    const migration = await readFile(resolve(root, 'supabase/migrations/202611230001_init.sql'), 'utf8');
    const seed = await readFile(resolve(root, 'supabase/seed.sql'), 'utf8');
    await runSql(supabaseToken, ref, 'migration', migration);
    await runSql(supabaseToken, ref, 'seed', seed);
    const supabaseUrl = merged.SUPABASE_URL || `https://${ref}.supabase.co`;
    const serviceKey = await pickServiceKey(supabaseToken, ref, supabaseUrl);

    const pinHash = await bcrypt.hash(adminPin, 12);

    const envVars = {
        SUPABASE_URL: supabaseUrl,
        SUPABASE_SERVICE_ROLE_KEY: serviceKey,
        SESSION_SECRET: sessionSecret,
        ADMIN_PIN_HASH: pinHash,
        SUPABASE_BUCKET: 'candidate-photos'
    };

    // 2. .env.local
    const envPath = resolve(root, '.env.local');
    const existing = (await exists(envPath)) ? parseEnv(await readFile(envPath, 'utf8')) : {};
    const mergedEnv = { ...existing, ...envVars, DATABASE_URL: existing.DATABASE_URL || '' };
    const lines = Object.entries(mergedEnv)
        .filter(([, value]) => value !== '')
        .map(([key, value]) => `${key}=${value}`);
    await writeFile(envPath, `${lines.join('\n')}\n`);
    await chmod(envPath, 0o600);
    done('.env.local ditulis');

    if (skipVercel) {
        report({ ref, supabaseUrl, adminPin, deploymentUrl: null, skipVercel: true });
        return;
    }

    // 3. Vercel: deploy pertama untuk membuat project, lalu set env, lalu deploy ulang.
    const vercelArgs = ['--yes', 'vercel@latest', 'deploy', '--prod', '--yes'];
    if (merged.VERCEL_SCOPE) vercelArgs.push('--scope', merged.VERCEL_SCOPE);
    if (merged.VERCEL_PROJECT_NAME) vercelArgs.push('--name', merged.VERCEL_PROJECT_NAME);
    // Token lewat environment agar tidak muncul di daftar proses.
    const vercelEnv = { ...process.env, VERCEL_TOKEN: vercelToken };

    await run('npx', vercelArgs, { env: vercelEnv });

    const link = await readVercelProject();
    if (!link) fail('project Vercel tidak terdeteksi', 'Folder .vercel/project.json tidak dibuat.');

    log('menulis environment variables ke Vercel...');
    await upsertVercelEnv(vercelToken, link.projectId, link.orgId, envVars);
    done('environment variables siap');

    log('deploy ulang dengan environment variables...');
    await run('npx', vercelArgs, { env: vercelEnv });

    const deployment = await latestDeployment(vercelToken, link.projectId, link.orgId);
    const ready = await waitDeployment(vercelToken, deployment, link.orgId);
    const deploymentUrl = `https://${ready.url}`;

    // 4. Smoke test
    if (merged.SKIP_SMOKE === '1' || merged.SKIP_SMOKE === 'true') {
        report({ ref, supabaseUrl, adminPin, deploymentUrl, skipVercel: false });
        return;
    }

    log('smoke test /api/health ...');
    const health = await fetch(`${deploymentUrl}/api/health`);
    const healthBody = await health.text();
    if (!health.ok) fail(`health check gagal (${health.status})`, healthBody.slice(0, 400));

    log('smoke test /api/status ...');
    const status = await fetch(`${deploymentUrl}/api/status`);
    if (!status.ok) fail(`status gagal (${status.status})`, (await status.text()).slice(0, 400));

    report({ ref, supabaseUrl, adminPin, deploymentUrl, skipVercel: false });
}

async function report(info) {
    const lines = [
        '',
        '============================================================',
        '  E-VOTE TARUNA — HASIL PROVISIONING',
        '============================================================',
        `Supabase URL   : ${info.supabaseUrl}`,
        `Project ref    : ${info.ref}`,
        `Admin PIN      : ${info.adminPin}`,
        info.deploymentUrl ? `Website        : ${info.deploymentUrl}` : 'Website        : (deploy Vercel dilewati)',
        '',
        'Simpan PIN di atas. PIN hanya ditampilkan sekali di sini,',
        'yang tersimpan di server hanya hash bcrypt-nya.',
        '============================================================',
        ''
    ].join('\n');

    console.log(lines);
    const out = resolve(root, 'DEPLOY-INFO.txt');
    await writeFile(out, `${lines}\n`, { mode: 0o600 });
    log(`ringkasan disimpan di ${out}`);
}

main().catch(error => fail(error.message, error.stack?.split('\n')[1]?.trim()));
