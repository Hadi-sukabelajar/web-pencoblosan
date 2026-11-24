import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv } from './load-env.mjs';

loadEnv();

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const publicDir = resolve(root, 'public');
const port = Number(process.env.PORT) || 3000;

const { default: apiHandler } = await import('../lib/handler.js');

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.ico': 'image/x-icon',
    '.txt': 'text/plain; charset=utf-8'
};

// Hanya file dari folder public yang boleh disajikan saat development.
const STATIC_FILES = new Set(['/index.html', '/favicon.ico', '/robots.txt']);

function send(res, status, body, contentType = 'text/plain; charset=utf-8') {
    res.statusCode = status;
    res.setHeader('Content-Type', contentType);
    res.end(body);
}

const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    let pathname = url.pathname;

    if (pathname === '/api' || pathname.startsWith('/api/')) {
        try {
            await apiHandler(req, res);
        } catch (error) {
            console.error('[dev] API error:', error);
            if (!res.headersSent) {
                send(res, 500, JSON.stringify({ error: 'INTERNAL_ERROR', message: 'Terjadi kesalahan pada server.' }), 'application/json; charset=utf-8');
            }
        }
        return;
    }

    if (pathname === '/') pathname = '/index.html';

    if (!STATIC_FILES.has(pathname)) {
        send(res, 404, 'Not found');
        return;
    }

    const filePath = resolve(publicDir, `.${pathname}`);

    try {
        const body = await readFile(filePath);
        res.statusCode = 200;
        res.setHeader('Content-Type', MIME[extname(filePath)] || 'application/octet-stream');
        res.setHeader('Cache-Control', 'no-store');
        res.end(body);
    } catch {
        send(res, 404, 'Not found');
    }
});

server.listen(port, '0.0.0.0', () => {
    console.log(`\nE-VOTE TARUNA dev server`);
    console.log(`  Lokal   : http://localhost:${port}`);
    console.log(`  Jaringan: http://<IP-komputer>:${port}`);
    console.log(`  API     : http://localhost:${port}/api/health\n`);
});
