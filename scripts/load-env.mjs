import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export function loadEnv() {
    for (const name of ['.env.local', '.env']) {
        const file = resolve(process.cwd(), name);
        if (!existsSync(file)) continue;

        const text = readFileSync(file, 'utf8');
        for (const line of text.split(/\r?\n/)) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith('#')) continue;

            const withoutExport = trimmed.startsWith('export ') ? trimmed.slice(7).trim() : trimmed;
            const index = withoutExport.indexOf('=');
            if (index === -1) continue;

            const key = withoutExport.slice(0, index).trim();
            let value = withoutExport.slice(index + 1).trim();

            if (
                (value.startsWith('"') && value.endsWith('"')) ||
                (value.startsWith("'") && value.endsWith("'"))
            ) {
                value = value.slice(1, -1);
            }

            if (key && !(key in process.env)) {
                process.env[key] = value;
            }
        }
    }
}
