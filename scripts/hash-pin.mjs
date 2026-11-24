import bcrypt from 'bcryptjs';

const pin = process.argv[2];

if (!pin) {
    console.error('Cara pakai:');
    console.error('  npm run hash-pin -- "PIN_RAHASIA_ANDA"');
    process.exit(1);
}

const hash = await bcrypt.hash(pin, 12);
console.log('\nSalin nilai berikut ke environment Vercel / .env.local:\n');
console.log(`ADMIN_PIN_HASH=${hash}\n`);
