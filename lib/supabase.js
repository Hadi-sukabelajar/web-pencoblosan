import { createClient } from '@supabase/supabase-js';
import WebSocket from 'ws';

let client = null;

export function getSupabase() {
    if (client) return client;

    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!url || !key) {
        const error = new Error('SUPABASE_URL dan SUPABASE_SERVICE_ROLE_KEY belum diset.');
        error.code = 'CONFIG_MISSING';
        error.status = 500;
        throw error;
    }

    client = createClient(url, key, {
        auth: {
            persistSession: false,
            autoRefreshToken: false,
            detectSessionInUrl: false
        },
        global: {
            headers: { 'X-Client-Info': 'evote-taruna' }
        },
        // Node.js 20 di Vercel belum punya WebSocket global. Realtime tidak dipakai,
        // tetapi createClient tetap membutuhkan konstruktor transport.
        realtime: {
            transport: WebSocket
        }
    });

    return client;
}

export function getBucket() {
    return process.env.SUPABASE_BUCKET || 'candidate-photos';
}
