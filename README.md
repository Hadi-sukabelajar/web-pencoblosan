# E-VOTE TARUNA

Sistem pencoblosan digital untuk pemilihan taruna. Frontend statis dengan tampilan yang sama seperti versi sebelumnya, backend Vercel Serverless Functions, database dan penyimpanan foto di Supabase.

- **Website:** <https://web-pencoblosan.vercel.app>
- **Repository:** <https://github.com/Hadi-sukabelajar/web-pencoblosan>
- **Health check:** <https://web-pencoblosan.vercel.app/api/health>

> Repository `main` terhubung ke project Vercel `web-pencoblosan`. Setiap push ke `main` otomatis memicu deploy production; branch lain menjadi preview deployment.

## Arsitektur

```text
Browser
  │
  ├── GET /                     → public/index.html (Vercel Static)
  └── fetch /api/*              → api/index.js (Vercel Function)
                                      │
                                      ├── Supabase Postgres (service role)
                                      └── Supabase Storage (foto kandidat)
```

- Browser **tidak** terhubung langsung ke database. Semua operasi lewat API.
- `SUPABASE_SERVICE_ROLE_KEY` hanya disimpan di environment server.
- PIN admin disimpan sebagai hash bcrypt di environment, bukan di JavaScript frontend.
- Sesi memakai JWT yang ditandatangani `SESSION_SECRET`, disimpan di cookie `HttpOnly`, `SameSite=Strict`, dan `Secure` saat production.
- Suara disimpan sebagai **tally agregat per kandidat** (`vote_tallies`), tanpa identitas pemilih dan tanpa urutan suara yang bisa dicocokkan dengan waktu pencoblosan.
- Penghitungan suara dan pencatatan hak suara berjalan dalam satu transaksi PostgreSQL (`cast_vote`).

## Struktur proyek

```text
api/index.js                       Entry point Vercel (semua /api/* di-rewrite ke sini)
lib/
  handler.js                       Seluruh logika endpoint API
  supabase.js                      Supabase client (service role)
  session.js                       JWT + cookie sesi
  data.js                          Query kandidat, DPT, statistik
  utils.js                         Validasi, error, CSV, foto, hash IP
public/index.html                  Aplikasi frontend
supabase/migrations/*.sql          Skema database, fungsi, RLS, storage
supabase/seed.sql                  Data contoh kandidat dan DPT
scripts/dev-server.mjs             Server lokal (API + frontend)
scripts/db-setup.mjs               Menjalankan migration/seed lokal
scripts/cloud-bootstrap.mjs        Provisioning Supabase + deploy Vercel
scripts/hash-pin.mjs               Membuat hash PIN admin
tests/                             Test frontend dan helper
vercel.json                        Konfigurasi Vercel
.vercelignore                      File yang tidak diunggah ke Vercel
```

## 1. Siapkan Supabase

1. Buat project baru di [supabase.com](https://supabase.com).
2. Buka **Project Settings → API**.
3. Catat:
   - **Project URL** → `SUPABASE_URL`
   - **service_role** / **secret key** → `SUPABASE_SERVICE_ROLE_KEY`
4. Jangan pernah menaruh service role key di frontend atau membagikannya.

### Jalankan skema database

Pilih salah satu cara.

**Cara A — Supabase SQL Editor (tanpa install apa pun)**

1. Buka **SQL Editor**.
2. Salin seluruh isi `supabase/migrations/202611230001_init.sql`, jalankan.
3. Buat query baru, salin seluruh isi `supabase/seed.sql`, jalankan.

**Cara B — dari komputer lokal**

Ambil connection string **Session Pooler** dari Supabase, lalu:

```bash
cp .env.example .env.local
# isi DATABASE_URL di .env.local
npm install
npm run db:setup -- --seed
```

Migration membuat tabel, fungsi, view, RLS, dan bucket Storage `candidate-photos`. Seed menambahkan 2 kandidat contoh dan 5 pemilih contoh lengkap dengan kelas dan NIT. Keduanya aman dijalankan ulang.

> **Jika database lama sudah pernah memakai skema berbasis nama saja:** tabel `voters` lama belum punya kolom kelas/NIT. Kosongkan atau hapus tabel `voters` lama sebelum menjalankan migration ini, lalu impor ulang DPT. Jangan jalankan `drop` pada database yang sudah berisi data produksi tanpa backup.

## 2. Konfigurasi environment

Salin contoh:

```bash
cp .env.example .env.local
```

Isi nilai berikut:

| Variabel | Wajib | Keterangan |
| --- | --- | --- |
| `SUPABASE_URL` | Ya | URL project Supabase |
| `SUPABASE_SERVICE_ROLE_KEY` | Ya | Service role / secret key |
| `SESSION_SECRET` | Ya | Minimal 32 karakter acak |
| `ADMIN_PIN_HASH` | Ya | Hash bcrypt PIN admin |
| `SUPABASE_BUCKET` | Tidak | Default `candidate-photos` |
| `DATABASE_URL` | Tidak | Hanya untuk migration/seed lokal |
| `COOKIE_SECURE` | Tidak | `true` jika HTTPS non-Vercel |

Membuat `SESSION_SECRET`:

```bash
openssl rand -hex 32
```

Membuat hash PIN admin:

```bash
npm run hash-pin -- "PIN_RAHASIA_ANDA"
```

Salin hasil `ADMIN_PIN_HASH=...` ke `.env.local`. Jangan menyimpan PIN asli di file mana pun.

## 3. Jalankan lokal

```bash
npm install
npm run dev
```

Buka `http://localhost:3000`.

Server lokal menyajikan `public/index.html` dan meneruskan `/api/*` ke function yang sama seperti di Vercel.

## 4. Deploy ke Vercel

Project Vercel sudah dibuat dan tersambung ke repository GitHub ini (`Hadi-sukabelajar/web-pencoblosan`, branch produksi `main`). Alur normalnya cukup:

```bash
git add .
git commit -m "pesan perubahan"
git push origin main
```

Vercel membangun dan menerbitkan otomatis. Tidak perlu build command; `vercel.json` sudah mengatur output directory `public`, rewrite `/api/*`, dan header keamanan.

Untuk memasang ulang dari nol:

1. Buka [vercel.com/new](https://vercel.com/new), pilih repository GitHub ini.
2. Framework Preset: **Other**. Build Command: kosong. Output Directory: `public`.
3. Tambahkan environment variables untuk **Production** (dan Preview bila perlu):
   - `SUPABASE_URL`
   - `SUPABASE_SERVICE_ROLE_KEY`
   - `SESSION_SECRET`
   - `ADMIN_PIN_HASH`
   - `SUPABASE_BUCKET` (opsional)
4. Deploy, lalu sambungkan domain. Setiap push ke `main` berikutnya otomatis ter-deploy.

Jika deploy lewat CLI:

```bash
npm i -g vercel
vercel link
vercel --prod
```

`vercel.json` sudah mengatur output directory, header keamanan, dan runtime function.

### Opsi cepat: provisioning otomatis

Jika Anda punya **Personal Access Token** Supabase dan token Vercel, satu perintah dapat membuat project Supabase, menjalankan migration + seed, menulis `.env.local`, mengisi environment Vercel, lalu deploy.

1. Buat token:
   - Supabase → **Account → Access Tokens**: <https://supabase.com/dashboard/account/tokens>
   - Vercel → **Account Settings → Tokens**: <https://vercel.com/account/tokens>
2. Isi file `secrets.env` di folder project (sudah dibuatkan, otomatis diabaikan git dan Vercel):

   ```env
   SUPABASE_ACCESS_TOKEN=sbp_...
   VERCEL_TOKEN=...
   ADMIN_PIN=          # kosongkan agar dibuat otomatis dan ditampilkan
   ```

3. Jalankan:

   ```bash
   npm run cloud
   ```

4. Di akhir skrip ditampilkan URL website, project ref, dan PIN admin. Simpan PIN tersebut — yang tersimpan di server hanya hash bcrypt.

Skrip aman dijalankan ulang: project yang sudah ada dipakai kembali, migration dan seed idempoten, dan environment Vercel diperbarui. Isi opsional lain (`SUPABASE_ORG_SLUG`, `SUPABASE_REGION`, `SUPABASE_DB_PASSWORD`, `VERCEL_SCOPE`, `SKIP_VERCEL`, `SKIP_SMOKE`) ada di komentar `scripts/cloud-bootstrap.mjs`.

> `.vercelignore` mencegah `.env*`, `backup/`, `tests/`, `supabase/`, dan `scripts/` ikut terunggah ke Vercel.

## 5. Cara pakai

### Pemilih

1. Masukkan **nama lengkap**, **kelas**, dan **NIT**.
2. Jika NIT belum terdaftar dan pendaftaran mandiri dibuka, data langsung dibuat otomatis.
3. Pilih kandidat, cek konfirmasi (nama, kelas, NIT), lalu coblos.
4. Simpan kode bukti digital yang muncul.
5. Satu NIT hanya dapat mencoblos satu kali.

### Admin

1. Klik tombol **Admin**, masukkan PIN.
2. Kelola kandidat: tambah, edit, hapus, unggah foto dari file atau URL.
3. **Impor DPT** sekali jalan: unggah CSV/TXT atau tempel data `NAMA,KELAS,NIT`.
4. Buka/tutup **Pendaftaran Mandiri**. Disarankan: impor DPT lalu matikan pendaftaran mandiri sebelum TPS dibuka.
5. Hapus data pemilih yang belum mencoblos bila ada kesalahan impor.
6. Buka/tutup TPS.
7. Tampilkan/sembunyikan hasil publik.
8. Pantau grafik dan daftar pencoblos tercepat.
9. Export rekap CSV.
10. Reset seluruh suara bila diperlukan.

Contoh data impor:

```csv
NAMA,KELAS,NIT
TARUNA AHMAD RISKY,1A,NIT2026001
TARUNA BUDI SANTOSO,1A,NIT2026002
```

NIT yang berawalan angka nol sebaiknya diformat sebagai teks di Excel agar nol tidak hilang.

## Endpoint API

| Method | Path | Akses | Fungsi |
| --- | --- | --- | --- |
| GET | `/api/health` | Publik | Cek koneksi server |
| GET | `/api/status` | Publik | Status TPS, pendaftaran mandiri, jumlah pemilih/suara |
| GET | `/api/candidates` | Publik | Daftar kandidat |
| GET | `/api/results` | Publik/Admin | Rekap suara (bisa disembunyikan) |
| GET | `/api/session` | Publik | Sesi aktif |
| POST | `/api/auth/voter/login` | Publik | Login pemilih dengan nama, kelas, NIT |
| POST | `/api/auth/logout` | Publik | Logout |
| POST | `/api/vote` | Pemilih | Coblos |
| POST | `/api/admin/login` | Publik | Login PIN admin |
| POST | `/api/admin/logout` | Admin | Logout admin |
| GET | `/api/admin/overview` | Admin | Statistik, kandidat, DPT |
| POST | `/api/admin/candidates` | Admin | Tambah kandidat |
| PUT | `/api/admin/candidates/:id` | Admin | Edit kandidat |
| DELETE | `/api/admin/candidates/:id` | Admin | Hapus kandidat tanpa suara |
| POST | `/api/admin/upload-photo` | Admin | Unggah foto kandidat |
| POST | `/api/admin/voters/import` | Admin | Impor DPT massal |
| DELETE | `/api/admin/voters/:id` | Admin | Hapus pemilih belum mencoblos |
| POST | `/api/admin/settings` | Admin | Ubah TPS, hasil publik, pendaftaran mandiri |
| POST | `/api/admin/votes/reset` | Admin | Reset semua suara |
| GET | `/api/admin/export.csv` | Admin | Unduh rekap CSV |

## Model keamanan

- **Rahasia suara**: suara hanya disimpan sebagai jumlah agregat per kandidat di `vote_tallies`. Tidak ada `voter_id`, timestamp suara, atau baris suara per pemilih yang bisa dicocokkan dengan `voters.voted_at`. Admin bisa melihat siapa yang sudah mencoblos dan total suara, tetapi tidak bisa mengetahui pilihan seseorang — termasuk lewat dashboard Supabase.
- **Satu suara per NIT**: NIT adalah kunci unik. Fungsi `cast_vote` mengunci baris pemilih dan menolak percobaan kedua, termasuk saat dua request datang bersamaan.
- **Identitas harus cocok**: login dengan NIT yang sudah terdaftar tetapi nama/kelas berbeda ditolak (`IDENTITY_MISMATCH`).
- **Pendaftaran mandiri**: bisa dimatikan dari dashboard admin. Saat dimatikan, hanya NIT yang sudah terdaftar di DPT yang bisa masuk.
- **TPS tutup**: `cast_vote` menolak suara ketika `is_voting_open = false`.
- **RLS**: seluruh tabel mengaktifkan Row Level Security tanpa policy untuk `anon`/`authenticated`. Hanya service role dari API yang bisa mengakses.
- **Admin**: PIN diverifikasi dengan bcrypt; percobaan login dibatasi 8 kali per 15 menit per IP.
- **Cookie**: `HttpOnly`, `SameSite=Strict`, `Secure` di Vercel production/preview.
- **Audit**: aksi admin penting dicatat di `audit_logs`.
- **CSV**: sel yang diawali `=`, `+`, `-`, atau `@` diberi prefiks untuk mencegah formula injection.
- **Upload foto**: hanya PNG/JPEG/WEBP, maksimal 3MB, dengan nama file acak.

### Keterbatasan yang disepakati

Login pemilih memakai nama, kelas, dan NIT, tetapi NIT bukan rahasia. Siapa pun yang mengetahui ketiga data tersebut dapat menggunakan hak suara orang lain jika belum mencoblos. Ini tetap lebih baik daripada login nama saja, tetapi bukan autentikasi kuat. Untuk pemilihan dengan risiko tinggi, impor DPT, matikan pendaftaran mandiri sebelum TPS dibuka, dan pertimbangkan verifikasi tambahan (OTP, token unik, atau petugas di TPS).

## Pengujian

```bash
npm test
```

Test mencakup alur login pemilih dengan nama/kelas/NIT, registrasi otomatis, penolakan identitas tidak cocok, penolakan saat pendaftaran mandiri ditutup, impor DPT (termasuk parser CSV/titik koma/tab), pemilihan kandidat, bukti suara, pemulihan sesi, pemulihan bukti saat suara sudah tercatat di server, login admin, penutupan TPS, CRUD paslon, JWT, normalisasi nama/kelas/NIT, perhitungan hasil, CSV, dan validasi foto. Jalankan `npm test` — saat ini 24 test lulus.

## Troubleshooting

**`SUPABASE_URL dan SUPABASE_SERVICE_ROLE_KEY belum diset`**  
Environment variable belum terbaca. Di Vercel, tambahkan lalu redeploy. Di lokal, pastikan `.env.local` ada.

**`ADMIN_PIN_HASH belum diset` / `tidak valid`**  
Jalankan `npm run hash-pin -- "PIN"` dan salin hash lengkap, termasuk awalan `$2a$` atau `$2b$`. Bungkus nilai dengan tanda kutip saat menulis ke file `.env`.

**`Gagal mengunggah foto`**  
Pastikan bucket `candidate-photos` ada dan public. Migration biasanya membuatnya otomatis. Jika tidak, buat bucket manual dengan nama tersebut dan set public.

**`NIT belum terdaftar di DPT`**  
Pendaftaran mandiri sedang ditutup. Impor DPT lewat tab **Data Pemilih → Impor DPT**, atau buka **Daftar Mandiri** sementara.

**`NIT sudah terdaftar dengan nama/kelas berbeda`**  
NIT sudah ada dengan identitas lain. Periksa ejaan nama/kelas, atau perbaiki data lewat impor ulang selama pemilih tersebut belum mencoblos.

**Sebagian baris impor dilewati**  
Baris dengan NIT duplikat, NIT tidak valid, atau pemilih yang sudah mencoblos akan dilewati. Ringkasan jumlahnya muncul setelah impor.

**`Hasil sementara sedang dirahasiakan`**  
Admin menonaktifkan hasil publik. Login admin atau aktifkan kembali **Hasil Publik**.

**Sesi admin berakhir**  
Sesi admin berlaku 8 jam. Login ulang. Sesi pemilih berlaku 4 jam.

**Supabase free tier pause**  
Project Supabase gratis dapat di-pause setelah lama tidak aktif. Buka dashboard Supabase sebelum hari pemilihan agar database aktif.

## Catatan operasional

### Checklist sebelum hari pencoblosan

1. Deploy dan buka `/api/health` — harus `{ "ok": true }`.
2. Login admin dan pastikan PIN benar.
3. Tambah/edit paslon beserta foto, cek tampilan di HP.
4. Impor DPT final (nama, kelas, NIT) dan cek jumlah pemilih terdaftar.
5. Pastikan opsi **Matikan pendaftaran mandiri setelah impor** tercentang, atau matikan manual **Daftar Mandiri**.
6. Uji satu akun contoh: login, coblos, lihat bukti suara, lalu reset suara sebelum hari-H.
7. Pastikan **TPS: BUKA** dan **Hasil Publik** sesuai kebijakan panitia.
8. Buka dashboard Supabase sekali agar project free tier tidak pause.

### Saat pencoblosan

- Pantau jumlah suara masuk dan partisipasi dari dashboard admin.
- Jangan menutup TPS sebelum panitia menyatakan selesai.
- Setelah selesai: tutup TPS, export CSV, dan simpan screenshot hasil akhir.
- Jangan pernah commit `.env.local`, service role key, atau hash PIN.
- `backup/index-localstorage.html` adalah versi lama berbasis `localStorage`; hanya untuk referensi, bukan untuk produksi.
