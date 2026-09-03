# Setup database & env buat JoTavern login backend

## 1. Tabel `tenants` (SKEMA BARU — ada tambahan kolom `db_name`)

Ini beda dari skema yang dipakai di sisi C++ (gateway) sebelumnya —
sekarang WAJIB ada `db_name`, karena web login butuh tau database mana
yang mau di-query buat cek GrowID/password:

```sql
CREATE DATABASE IF NOT EXISTS jotavern_control;
USE jotavern_control;

CREATE TABLE IF NOT EXISTS tenants (
    name    VARCHAR(32)  NOT NULL PRIMARY KEY,
    ip      VARCHAR(45)  NOT NULL,
    port    INT          NOT NULL,
    db_name VARCHAR(64)  NOT NULL
);

-- contoh isi buat 1 tenant:
INSERT INTO tenants (name, ip, port, db_name) VALUES
    ('serverkeren', '127.0.0.1', 7019, 'gurotopia_serverkeren');
```

Tabel ini dipakai BARENG oleh dua sisi:
- **Gateway (C++)**: baca `ip` + `port` buat redirect (`OnSendToServer`)
- **Web login (index.ts)**: baca `db_name` buat query tabel `peer` yang benar

## 2. Environment variables buat login-gurotopia (Vercel)

Ganti `DATABASE_URL` (yang lama, satu database tetap) jadi ini:

| Env var | Contoh | Keterangan |
|---|---|---|
| `DB_HOST` | `66.33.22.220` | IP MySQL server (VPS yang sama tempat gateway/tenant jalan) |
| `DB_PORT` | `3306` | |
| `DB_USER` | `jotavern_web` | User MySQL khusus buat web login (jangan pakai root) |
| `DB_PASS` | `xxxxx` | |
| `CONTROL_DB_NAME` | `jotavern_control` | Nama database tempat tabel `tenants` |

⚠️ Karena Vercel itu serverless (bukan di VPS-mu), MySQL di VPS harus
bisa diakses dari luar (bind-address bukan cuma 127.0.0.1, dan port
3306 di-forward/dibuka ke internet dengan user MySQL yang PASSWORD-nya
kuat + akses dibatasi user tsb doang, JANGAN buka root ke publik).

User MySQL yang dipakai web ini idealnya cuma dikasih akses
`SELECT` ke tabel `tenants` (control db) dan tabel `peer` di
semua database tenant — bukan `ALL PRIVILEGES` kayak yang dipakai
proses game server.
