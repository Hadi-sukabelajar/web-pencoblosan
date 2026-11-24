import { SignJWT, jwtVerify } from 'jose';

const COOKIE_NAME = 'evote_session';
const VOTER_TTL = 60 * 60 * 4;
const ADMIN_TTL = 60 * 60 * 8;

function getSecret() {
    const secret = process.env.SESSION_SECRET;
    if (!secret || secret.length < 32) {
        const error = new Error('SESSION_SECRET minimal 32 karakter dan wajib diset.');
        error.code = 'CONFIG_MISSING';
        error.status = 500;
        throw error;
    }
    return new TextEncoder().encode(secret);
}

function parseCookies(header) {
    const cookies = {};
    String(header || '').split(';').forEach(part => {
        const index = part.indexOf('=');
        if (index === -1) return;
        const key = part.slice(0, index).trim();
        const value = part.slice(index + 1).trim();
        if (!key) return;
        try {
            cookies[key] = decodeURIComponent(value);
        } catch {
            cookies[key] = value;
        }
    });
    return cookies;
}

function isSecureCookie() {
    if (process.env.COOKIE_SECURE === 'true') return true;
    return process.env.VERCEL_ENV === 'production' || process.env.VERCEL_ENV === 'preview';
}

function cookieHeader(token, maxAge) {
    const attributes = [
        `${COOKIE_NAME}=${encodeURIComponent(token)}`,
        'Path=/',
        'HttpOnly',
        'SameSite=Strict',
        `Max-Age=${maxAge}`
    ];
    if (isSecureCookie()) attributes.push('Secure');
    return attributes.join('; ');
}

export function voterTtl() {
    return VOTER_TTL;
}

export function adminTtl() {
    return ADMIN_TTL;
}

export async function createSession(payload, maxAge = VOTER_TTL) {
    return new SignJWT(payload)
        .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
        .setIssuedAt()
        .setExpirationTime(Math.floor(Date.now() / 1000) + maxAge)
        .sign(getSecret());
}

export async function readSession(req) {
    const token = parseCookies(req.headers.cookie)[COOKIE_NAME];
    if (!token) return null;

    const secret = getSecret();

    try {
        const { payload } = await jwtVerify(token, secret);
        return payload;
    } catch {
        return null;
    }
}

export function setSessionCookie(res, token, maxAge) {
    res.setHeader('Set-Cookie', cookieHeader(token, maxAge));
}

export function clearSessionCookie(res) {
    res.setHeader('Set-Cookie', cookieHeader('', 0));
}
