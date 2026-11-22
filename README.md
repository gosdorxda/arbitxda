# Arbit Scanner

Aplikasi web untuk mengambil data harga spot dari API REST resmi exchange, menyimpannya ke SQLite, lalu menampilkannya di tabel. Saat ini percobaan pertama hanya **Kraken**, dan hanya pair dengan quote **USD**.

Tidak memakai `ccxt` dan tidak memakai WebSocket. Tabel di web selalu membaca data dari database hasil fetch terakhir.

## Stack

- Next.js (React, TypeScript, App Router)
- SQLite lewat modul bawaan Node.js (`node:sqlite`), tanpa paket native
- File database: `data/arbit.db`
- Konfigurasi di `.env`

## Persyaratan

- **Node.js 22.13 atau lebih baru** (diuji di Node 24). Cek dengan `node -v`.
- Tidak perlu Python, Visual Studio Build Tools, atau compiler C++. Tidak ada dependensi yang harus di-compile dengan `node-gyp`.

## Cara menjalankan di Windows

Jika ini **upgrade dari zip lama** (yang masih memakai `better-sqlite3`), hapus dulu sisa instalasi lama supaya tidak bentrok:

```powershell
cd D:\AI\arbit
Remove-Item -Recurse -Force node_modules, package-lock.json -ErrorAction SilentlyContinue
```

Lalu:

1. Pastikan [Node.js](https://nodejs.org/) sudah terpasang, versi **22.13+** (kamu sudah punya Node 24, itu cukup).
2. Extract / salin file project ke folder kerja, lalu buka PowerShell.
3. Masuk ke folder project:

   ```powershell
   cd D:\AI\arbit
   ```

4. Salin file environment jika belum ada:

   ```powershell
   copy .env.example .env
   ```

5. Install dependensi dan jalankan server pengembangan:

   ```powershell
   npm install
   npm run dev
   ```

6. Buka browser di [http://localhost:3000](http://localhost:3000).

7. Klik **Fetch Kraken** atau **Fetch semua**. Data ticker semua pair USD akan diambil, disimpan ke `data/arbit.db`, lalu tampil di tabel. Tombol **Depth 20** di setiap baris mengambil orderbook 20 level teratas untuk pair itu, menyimpannya ke database, dan menampilkannya di modal.

Kalau muncul peringatan `ExperimentalWarning` terkait SQLite (kadang muncul di Node 22), itu sudah ditekan lewat `.npmrc`. Di Node 24 biasanya tidak muncul.

## Struktur singkat

- `src/lib/exchanges/kraken.ts` — adapter Kraken (API resmi).
- `src/lib/exchanges/gate.ts` — adapter Gate (API resmi v4, tanpa API key).
- `src/lib/exchanges/poloniex.ts` — adapter Poloniex (API resmi v3, tanpa API key).
- `src/lib/exchanges/bitrue.ts` — adapter Bitrue (API resmi, tanpa API key).
- `src/lib/exchanges/mexc.ts` — adapter MEXC (API resmi; key read-only opsional untuk depo/wd).
- `src/lib/exchanges/htx.ts` — adapter HTX (API resmi, tanpa API key).
- `src/lib/exchanges/fameex.ts` — adapter FameEX (API resmi, tanpa API key).
- `src/lib/exchanges/xt.ts` — adapter XT.com (API resmi, tanpa API key).
- `src/lib/exchanges/bifinance.ts` — adapter BiFinance (API resmi, tanpa API key).
- `src/lib/exchanges/hotcoin.ts` — adapter Hotcoin (API resmi, tanpa API key).
- `src/lib/exchanges/bigone.ts` — adapter BigONE (API resmi, tanpa API key).
- `src/lib/exchanges/cryptocom.ts` — adapter Crypto.com Exchange (API resmi; key read-only opsional untuk depo/wd; hanya quote USD).
- `src/lib/exchanges/registry.ts` — daftar adapter.
- `src/lib/exchanges/stock-filter.ts` — buang token saham (xStock, rToken, Ondo) dan token leverage (3L/3S, UP/DOWN, dll.) di jalur fetch bersama. Adapter baru: set `isStock` / `isLeveraged` pada MarketInfo jika exchange punya flag resmi.
- `src/lib/db.ts` — skema dan akses SQLite (`node:sqlite`).
- `src/app/api/fetch/route.ts` — tombol Fetch (`POST /api/fetch?exchange=kraken` atau `?exchange=all`).
- `src/app/api/orderbook/route.ts` — fetch orderbook on-demand.
- `src/app/api/tickers/route.ts` dan `src/app/api/status/route.ts` — data tabel dan status dari DB.

## Cara menambah exchange baru

1. Buat file adapter baru, misalnya `src/lib/exchanges/binance.ts`.
2. Implementasikan interface `ExchangeAdapter` (lihat `src/lib/types.ts`):
   - `id` dan `name`
   - `fetchTickers()` memanggil REST resmi, menerapkan rate limit exchange itu, menormalisasi ke format seragam, dan hanya menyaring quote yang diinginkan (misalnya USDT/USD).
   - `fetchOrderBook(rawSymbol, count)` untuk depth on-demand (default 20 level).
3. Daftarkan adapter di `src/lib/exchanges/registry.ts`.
4. Jika API exchange menandai token saham atau token leverage, set `isStock` / `isLeveraged` di MarketInfo; filter bersama akan membuangnya otomatis.
5. Tambahkan id-nya di `.env`:

   ```env
   ENABLED_EXCHANGES=kraken,binance
   ```

Bagian lain (database, tombol Fetch, tabel) tidak perlu diubah. API key read-only bisa ditambahkan nanti di `.env` untuk status deposit/withdraw.

## Catatan Kraken

- Pair USD dikenali dari field `quote` = `ZUSD` atau `USD`.
- Nama aset klasik dinormalisasi: `XXBT` / `XBT` menjadi `BTC`, `XXDG` / `XDG` menjadi `DOGE`. Nama lain memakai `wsname` Kraken, misalnya `ETH/USD` menjadi `ETH`.
- Perubahan 24 jam dihitung dari harga *open hari ini* (`o`) karena ticker publik Kraken tidak menyediakan open 24 jam.
- Volume quote 24 jam dihitung dari volume base 24 jam dikali VWAP 24 jam.
- Ticker publik Kraken tidak berisi timestamp exchange, jadi kolom itu kosong; waktu yang dipakai adalah `fetched_at`.
- Status deposit/withdraw belum diambil dan ditampilkan sebagai `-`.
- Pair volume 0 dan bid/ask kosong tetap diambil dan ditampilkan. Status mentah dari AssetPairs disimpan di kolom `markets.status` dan tampil sebagai badge di tabel.
- Pair `cancel_only` (pasar ST/delisting di Kraken, misalnya ACAUSD) dilewati saat fetch dan dihapus dari `markets` / `tickers_latest` exchange itu setelah fetch berhasil. Status lain yang bukan `online` (`post_only`, `limit_only`, `maintenance`, dll.) tetap disimpan dan ditandai di kolom Status.
