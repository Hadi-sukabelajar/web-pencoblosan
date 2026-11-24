import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { loadEnv } from './load-env.mjs';

const { Client } = pg;

loadEnv();

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const databaseUrl = process.env.DATABASE_URL;
const withSeed = process.argv.includes('--seed');

if (!databaseUrl) {
    console.error('DATABASE_URL belum diset.');
    console.error('Gunakan connection string Supabase (Session Pooler), misalnya:');
    console.error('postgresql://postgres.xxxx:PASSWORD@aws-0-region.pooler.supabase.com:5432/postgres');
    console.error('\nAlternatif: jalankan file SQL langsung di Supabase SQL Editor.');
    process.exit(1);
}

const useSsl = !/localhost|127\.0\.0\.1/.test(databaseUrl);
const client = new Client({
    connectionString: databaseUrl,
    ssl: useSsl ? { rejectUnauthorized: false } : false
});

async function runInTransaction(db, sql) {
    await db.query('begin');
    try {
        await db.query(sql);
        await db.query('commit');
    } catch (error) {
        await db.query('rollback').catch(() => {});
        throw error;
    }
}

try {
    await client.connect();
    console.log('Terhubung ke database.');

    const migrationsDir = resolve(root, 'supabase/migrations');
    const files = (await readdir(migrationsDir))
        .filter(name => name.endsWith('.sql'))
        .sort();

    for (const file of files) {
        const sql = await readFile(resolve(migrationsDir, file), 'utf8');
        process.stdout.write(`Menjalankan migration ${file} ... `);
        await runInTransaction(client, sql);
        console.log('OK');
    }

    if (withSeed) {
        const seed = await readFile(resolve(root, 'supabase/seed.sql'), 'utf8');
        process.stdout.write('Menjalankan seed data ... ');
        await runInTransaction(client, seed);
        console.log('OK');
    }

    console.log('\nSelesai.');
    if (!withSeed) {
        console.log('Untuk menambahkan data contoh: npm run db:setup -- --seed');
    }
} catch (error) {
    console.error('\nGagal:', error.message);
    process.exitCode = 1;
} finally {
    await client.end().catch(() => {});
}
