import qrcode from 'qrcode-generator';

/** QR modules for `text` (true = dark), using medium error correction and the smallest fitting version. */
export function qrMatrix(text: string): boolean[][] {
  const qr = qrcode(0, 'M');
  qr.addData(text, 'Byte');
  qr.make();
  const size = qr.getModuleCount();
  return Array.from({ length: size }, (_, row) => Array.from({ length: size }, (_, col) => qr.isDark(row, col)));
}

// Fixed black-on-white colours: phone cameras need dark modules on a light background,
// which a dark terminal theme would otherwise invert.
const DARK_ON_LIGHT = '\u001b[38;5;16m\u001b[48;5;231m';
const RESET = '\u001b[0m';

/**
 * Renders a QR code with half-block characters, two modules per terminal row.
 * Returns plain lines (with ANSI colours) of equal visible width.
 */
export function renderQr(text: string, quietZone = 2): string[] {
  const modules = qrMatrix(text);
  const size = modules.length + quietZone * 2;
  const dark = (row: number, col: number) => {
    const r = row - quietZone, c = col - quietZone;
    return r >= 0 && c >= 0 && r < modules.length && c < modules.length && modules[r]![c]!;
  };
  const lines: string[] = [];
  for (let row = 0; row < size; row += 2) {
    let line = '';
    for (let col = 0; col < size; col++) {
      const top = dark(row, col), bottom = row + 1 < size && dark(row + 1, col);
      line += top && bottom ? '█' : top ? '▀' : bottom ? '▄' : ' ';
    }
    lines.push(`${DARK_ON_LIGHT}${line}${RESET}`);
  }
  return lines;
}

/** Visible width of the QR produced by renderQr (one column per module). */
export function qrWidth(text: string, quietZone = 2): number { return qrMatrix(text).length + quietZone * 2; }

/** Picks the URL a phone is most likely to reach: Tailscale first, then any non-loopback address. */
export function preferredPhoneUrl(urls: string[]): string | undefined {
  const host = (u: string) => { try { return new URL(u).hostname; } catch { return ''; } };
  const tailscale = (h: string) => h.endsWith('.ts.net') || /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(h);
  const loopback = (h: string) => h === 'localhost' || h.startsWith('127.') || h === '[::1]';
  return urls.find(u => tailscale(host(u)) && u.startsWith('https:')) ?? urls.find(u => tailscale(host(u)))
    ?? urls.find(u => !loopback(host(u))) ?? urls[0];
}
