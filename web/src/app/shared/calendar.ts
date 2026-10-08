import { Component, OnDestroy, computed, signal } from '@angular/core';

interface Holiday { date: string; name: string; regular: boolean; }
interface Day { iso: string; day: number; inMonth: boolean; today: boolean; sunday: boolean; holiday: Holiday | null; }

const TZ = 'Asia/Manila';
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function iso(y: number, m: number, d: number): string { return `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`; }
function manilaToday(): string { return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()); }

/** Easter Sunday (Gregorian, Anonymous algorithm) → used for Holy Week. */
function easter(y: number): Date {
  const a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25),
    g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4,
    l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451),
    month = Math.floor((h + l - 7 * m + 114) / 31), day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(y, month - 1, day);
}

/** Philippine holidays with a fixed rule. Dates moved by a yearly proclamation (and Eid / Chinese New Year) are not included. */
export function phHolidays(y: number): Holiday[] {
  const out: Holiday[] = [];
  const add = (m: number, d: number, name: string, regular: boolean) => out.push({ date: iso(y, m, d), name, regular });
  add(0, 1, "New Year's Day", true);
  add(3, 9, 'Araw ng Kagitingan', true);
  add(4, 1, 'Labor Day', true);
  add(5, 12, 'Independence Day', true);
  add(10, 30, 'Bonifacio Day', true);
  add(11, 25, 'Christmas Day', true);
  add(11, 30, 'Rizal Day', true);
  add(7, 21, 'Ninoy Aquino Day', false);
  add(10, 1, "All Saints' Day", false);
  add(10, 2, "All Souls' Day", false);
  add(11, 8, 'Feast of the Immaculate Conception', false);
  add(11, 24, 'Christmas Eve', false);
  add(11, 31, 'Last Day of the Year', false);
  // National Heroes Day: last Monday of August
  const lastAug = new Date(y, 7, 31);
  add(7, 31 - ((lastAug.getDay() + 6) % 7), 'National Heroes Day', true);
  // Holy Week
  const e = easter(y);
  const rel = (n: number) => { const d = new Date(e); d.setDate(d.getDate() + n); return d; };
  for (const [n, name, regular] of [[-3, 'Maundy Thursday', true], [-2, 'Good Friday', true], [-1, 'Black Saturday', false]] as [number, string, boolean][]) {
    const d = rel(n);
    out.push({ date: iso(d.getFullYear(), d.getMonth(), d.getDate()), name, regular });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

/** Month calendar for the right side panel (Manila date, Philippine holidays). */
@Component({
  selector: 'app-calendar',
  template: `
  <div class="cal">
    <div class="clock"><b>{{ time() }}</b><span>{{ longToday() }}</span></div>
    <div class="head">
      <button type="button" (click)="move(-1)" aria-label="Previous month">‹</button>
      <b>{{ monthName() }} {{ year() }}</b>
      <button type="button" (click)="move(1)" aria-label="Next month">›</button>
    </div>
    <div class="grid wk">@for (w of week; track $index) { <span [class.sun]="$index === 0">{{ w }}</span> }</div>
    <div class="grid">
      @for (d of days(); track d.iso) {
        <button type="button" [class.out]="!d.inMonth" [class.today]="d.today" [class.sel]="d.iso === selected()" [class.sun]="d.sunday"
          [class.hol]="!!d.holiday" [class.reg]="d.holiday?.regular" [title]="d.holiday?.name ?? ''" (click)="pick(d)">{{ d.day }}</button>
      }
    </div>
    <div class="btns"><button type="button" class="btn sm" (click)="goToday()">Today</button></div>
    <div class="sel-day"><b>{{ selectedLabel() }}</b>@if (selectedHoliday(); as h) { <span [class]="h.regular ? 'reg' : 'spec'">{{ h.name }} · {{ h.regular ? 'Regular holiday' : 'Special non-working day' }}</span> }</div>
    <div class="hols">
      <small>Holidays in {{ monthName() }}</small>
      @for (h of monthHolidays(); track h.date) {
        <div class="h" (click)="selected.set(h.date)"><i [class]="h.regular ? 'reg' : 'spec'"></i><span>{{ +h.date.slice(8) }}</span>{{ h.name }}</div>
      } @empty { <p>No holidays this month.</p> }
      <p class="note">Fixed-date and Holy Week holidays. Check the yearly proclamation for moved dates.</p>
    </div>
  </div>`,
  styles: [`
    .cal{font-size:13px}
    .clock{background:var(--navy);color:#fff;border-radius:16px;padding:14px;text-align:center;margin-bottom:14px}
    .clock b{display:block;font-size:26px;font-weight:600;font-variant-numeric:tabular-nums}.clock span{font-size:12px;opacity:.75}
    .head{display:flex;align-items:center;justify-content:space-between;margin-bottom:8px}.head b{font-size:14.5px}
    .head button{border:1px solid var(--line);background:#fff;border-radius:9px;width:30px;height:30px;font-size:18px;line-height:1;cursor:pointer;color:var(--ink)}
    .head button:hover{border-color:var(--pri);color:var(--pri)}
    .grid{display:grid;grid-template-columns:repeat(7,1fr);gap:3px}
    .wk span{text-align:center;font-size:11px;font-weight:600;color:var(--mute);padding:4px 0}.wk .sun{color:var(--red)}
    .grid button{aspect-ratio:1;border:0;border-radius:9px;background:transparent;font:inherit;font-size:12.5px;cursor:pointer;color:var(--ink);position:relative;padding:0}
    .grid button:hover{background:var(--pri-soft)}
    .grid button.sun{color:var(--red)}
    .grid button.out{opacity:.35}
    .grid button.hol::after{content:"";position:absolute;bottom:3px;left:50%;width:5px;height:5px;margin-left:-2.5px;border-radius:50%;background:#E0A100}
    .grid button.hol.reg::after{background:var(--red)}
    .grid button.today{background:var(--pri);color:#fff;font-weight:700}
    .grid button.sel:not(.today){outline:2px solid var(--pri);outline-offset:-2px}
    .btns{margin-top:8px;justify-content:flex-end}
    .sel-day{margin-top:10px;padding:10px 12px;background:var(--bg);border-radius:12px}.sel-day b{display:block}
    .sel-day span{display:block;font-size:12px;margin-top:3px}.sel-day .reg{color:var(--red-dark)}.sel-day .spec{color:var(--warn-ink)}
    .hols{margin-top:12px}.hols small{display:block;font-weight:600;color:var(--mute);margin-bottom:6px}
    .h{display:flex;align-items:center;gap:8px;padding:5px 0;border-top:1px solid var(--line);cursor:pointer;font-size:12.5px}
    .h span{font-weight:700;width:20px;text-align:right}.h i{width:8px;height:8px;border-radius:50%;flex:none}
    i.reg{background:var(--red)}i.spec{background:#E0A100}
    .hols p{margin:4px 0;color:var(--mute);font-size:12px}.hols .note{font-size:11px;margin-top:8px}
  `],
})
export class Calendar implements OnDestroy {
  readonly week = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];
  readonly now = signal(new Date());
  readonly today = signal(manilaToday());
  readonly year = signal(Number(this.today().slice(0, 4)));
  readonly month = signal(Number(this.today().slice(5, 7)) - 1);
  readonly selected = signal(this.today());
  private timer = setInterval(() => { this.now.set(new Date()); this.today.set(manilaToday()); }, 1000);

  readonly time = computed(() => this.now().toLocaleTimeString('en-US', { timeZone: TZ, hour: '2-digit', minute: '2-digit', second: '2-digit' }));
  readonly longToday = computed(() => this.now().toLocaleDateString('en-US', { timeZone: TZ, weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }));
  readonly monthName = computed(() => MONTHS[this.month()]);
  private readonly holidays = computed(() => {
    const y = this.year();
    return [...phHolidays(y - 1), ...phHolidays(y), ...phHolidays(y + 1)];
  });
  readonly monthHolidays = computed(() => {
    const p = iso(this.year(), this.month(), 1).slice(0, 8);
    return this.holidays().filter((h) => h.date.startsWith(p));
  });
  readonly days = computed<Day[]>(() => {
    const y = this.year(), m = this.month(), first = new Date(y, m, 1), start = new Date(y, m, 1 - first.getDay());
    const hol = new Map(this.holidays().map((h) => [h.date, h]));
    const out: Day[] = [];
    for (let i = 0; i < 42; i++) {
      const d = new Date(start); d.setDate(start.getDate() + i);
      const k = iso(d.getFullYear(), d.getMonth(), d.getDate());
      out.push({ iso: k, day: d.getDate(), inMonth: d.getMonth() === m, today: k === this.today(), sunday: d.getDay() === 0, holiday: hol.get(k) ?? null });
    }
    return out;
  });
  readonly selectedLabel = computed(() => {
    const [y, m, d] = this.selected().split('-').map(Number);
    return new Date(y, m - 1, d).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
  });
  readonly selectedHoliday = computed(() => this.holidays().find((h) => h.date === this.selected()) ?? null);

  move(n: number): void {
    let m = this.month() + n, y = this.year();
    if (m < 0) { m = 11; y--; } else if (m > 11) { m = 0; y++; }
    this.month.set(m); this.year.set(y);
  }
  goToday(): void {
    const t = this.today();
    this.year.set(Number(t.slice(0, 4))); this.month.set(Number(t.slice(5, 7)) - 1); this.selected.set(t);
  }
  pick(d: Day): void {
    this.selected.set(d.iso);
    if (!d.inMonth) { this.year.set(Number(d.iso.slice(0, 4))); this.month.set(Number(d.iso.slice(5, 7)) - 1); }
  }
  ngOnDestroy(): void { clearInterval(this.timer); }
}
