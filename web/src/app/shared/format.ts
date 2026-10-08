const TZ = 'Asia/Manila';

/** Today in Manila as yyyy-MM-dd. */
export function todayIso(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

export function addDays(iso: string, n: number): string {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** 'yyyy-MM-dd' → 'Oct 8, 2026' */
export function niceDate(v: string | null | undefined): string {
  if (!v) return '';
  const s = String(v);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const [y, m, d] = s.split('-').map(Number);
    return new Date(y, m - 1, d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  }
  const d = new Date(s);
  return isNaN(+d) ? s : d.toLocaleDateString('en-US', { timeZone: TZ, month: 'short', day: 'numeric', year: 'numeric' });
}

/** timestamp → 'Oct 8, 2026 9:30 AM' (Manila) */
export function niceStamp(v: string | null | undefined): string {
  if (!v) return '';
  const d = new Date(v);
  return isNaN(+d) ? String(v) : d.toLocaleString('en-US', { timeZone: TZ, month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
}

export function niceTime(v: string | null | undefined): string {
  if (!v) return '';
  const d = new Date(v);
  return isNaN(+d) ? '' : d.toLocaleTimeString('en-US', { timeZone: TZ, hour: '2-digit', minute: '2-digit' });
}

export function num(v: unknown, digits = 2): string {
  const n = Math.round((Number(v) || 0) * 10 ** digits) / 10 ** digits;
  return n.toLocaleString('en-US');
}

export function peso(v: unknown): string {
  const n = Math.round((Number(v) || 0) * 100) / 100;
  return '₱' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function pct(v: number | null | undefined): string {
  return v == null || !isFinite(v) ? '—' : (v * 100).toFixed(1) + '%';
}

/** 'RB ABC Lapu-lapu Inc.' → 'Lapu-lapu' */
export function shortBranch(b: string | null | undefined): string {
  return String(b ?? '').replace(/^\s*(RB|BR)\s*ABC\s*/i, '').replace(/\s*Inc\.?\s*$/i, '');
}

export function statusClass(s: string | null | undefined): string {
  return 's-' + String(s ?? '').toLowerCase().replace(/[^a-z]+/g, '-');
}

export function itemKey(s: string | null | undefined): string {
  return String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

export function initials(name: string | null | undefined): string {
  return String(name ?? '?').replace(/^RB ABC\s*/i, '').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
}

export function downloadText(name: string, text: string, mime = 'text/csv'): void {
  const blob = new Blob(['﻿' + text], { type: mime });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
}

export function toCsv(rows: unknown[][]): string {
  const q = (s: unknown) => { const v = String(s ?? ''); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
  return rows.map((r) => r.map(q).join(',')).join('\r\n');
}

/** Prints a standalone HTML document in a hidden frame (used for DN, RR, SOA, PO and charts). */
export function printHtml(html: string): void {
  const f = document.createElement('iframe');
  f.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0';
  document.body.appendChild(f);
  const d = f.contentDocument!;
  d.open(); d.write(html); d.close();
  setTimeout(() => { f.contentWindow!.focus(); f.contentWindow!.print(); setTimeout(() => f.remove(), 2000); }, 400);
}
