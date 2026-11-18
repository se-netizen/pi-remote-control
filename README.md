# Pi Remote Control

Buka dan kendalikan sesi [Pi](https://github.com/earendil-works/pi) yang berjalan di komputer Anda dari HP atau browser lain. Percakapannya tetap satu: yang diketik di HP muncul di terminal, dan sebaliknya. Pi tetap berjalan di komputer dengan kredensial model Anda.

- **Masuk tanpa ribet**: perangkat di akun Tailscale Anda masuk otomatis; perangkat lain cukup scan QR dari terminal, sekali per HP.
- **Real-time seperti Claude Code**: teks muncul saat Pi menulis, tool tampil sebagai baris `Bash(npm test)` yang bisa dibuka, edit sebagai diff, satu kotak input untuk instruksi dan arahan, tombol stop.
- **Perintah slash dari HP**: `/model`, `/thinking`, `/compact`, `/new`, `/session`, serta perintah extension, prompt template, dan skill Pi.
- **Sesi background**: `/remote-control detach` membuat Pi terus bekerja walau terminal ditutup; `/remote-control attach` menariknya kembali.
- **Aman di jalan**: lewat Tailscale (WireGuard) atau Wi-Fi dengan enkripsi XChaCha20-Poly1305 berkunci per perangkat, tanpa HTTPS dan tanpa server pihak ketiga.

Baseline teruji: Linux, Node 22.23, Pi 1.5.2. Windows belum didukung untuk daemon.

## Mulai cepat

```sh
npm ci && npm run build
npm run pi:install                              # daftarkan extension ke Pi
npm start -- start --host 0.0.0.0 --allow-http  # jalankan daemon
```

Lalu di Pi (`/reload` bila Pi sudah terbuka):

```text
/remote-control
```

Scan QR yang muncul dengan kamera HP, atau buka `http://IP-TAILSCALE-KOMPUTER:3141` dari HP di akun Tailscale yang sama. Selesai.

## Dokumentasi

| | |
| --- | --- |
| [Panduan](docs/PANDUAN.md) | Instalasi, daemon sebagai service, menghubungkan HP, memakai web, perintah slash, sesi background, mode auto, keamanan |
| [Referensi](docs/REFERENSI.md) | Semua perintah, opsi, variabel lingkungan, file, batas, API, kode kesalahan |
| [Troubleshooting](docs/TROUBLESHOOTING.md) | Masalah umum dan solusinya |
| [Workflow](docs/WORKFLOWS.md) | Orchestrator beberapa worker Pi dan model per peran |
| [Semua dokumen](docs/README.md) | Termasuk catatan implementasi dan rancangan awal |

## Ringkasan perintah

```text
/remote-control                 # aktifkan remote untuk sesi ini (QR bila belum ada HP)
/remote-control pair [wifi]     # QR untuk perangkat baru (wifi: alamat LAN terenkripsi)
/remote-control detach          # lanjutkan sesi di background, tutup Pi di terminal
/remote-control attach [show]   # tarik kembali (atau intip) sesi background
/remote-control auto [on|off]   # semua Pi baru otomatis muncul di HP
/remote-control status | devices | revoke ID | stop
```

```sh
npm start -- status | pair | revoke ID | sessions | new [FOLDER] | stop pi-rc-xxxxxx
```

## Pengembangan

```sh
npm run check     # typecheck + semua tes
npm run build     # dist/ untuk daemon dan web
PI_REMOTE_REAL_SMOKE=1 npx tsx --test tests/pi-adapter.test.ts   # smoke dengan Pi terpasang
```

Struktur: `extensions/remote-control.ts` (entry Pi) → `src/pi/attach-bridge.ts` (extension), `src/server.ts` dan `src/core.ts` (daemon), `src/seal.ts` (enkripsi Wi-Fi), `src/tailscale.ts` (login Tailscale), `src/background.ts` (sesi background), `web/` (aplikasi web tanpa build step). Catatan keputusan dan bukti pengujian ada di [IMPLEMENTATION.md](docs/IMPLEMENTATION.md).

Data daemon disimpan di `~/.pi/remote-control/` (0700/0600) dan tidak boleh di-commit. Nama paket masih nama kerja; belum dipublikasikan.
