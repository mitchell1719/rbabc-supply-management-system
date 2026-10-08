import { Component, computed, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { setting } from '../../core/scope';
import { errMsg, rows, sb, signedUrl } from '../../core/supabase';
import { addDays, downloadText, niceDate, niceTime, toCsv, todayIso } from '../../shared/format';

interface Emp { id: string; name: string; hq_code: string | null; active: boolean; }
interface Att { id: number; work_date: string; employee_id: string; employee_name: string; time_in: string; in_photo: string | null; time_out: string | null;
  out_photo: string | null; hours: number | null; status: string; site: string; in_dist: number | null; out_dist: number | null; remarks: string | null; }
interface Sum { id: string; name: string; hq: string; days: number; hours: number; ot: number; open: number; noOut: number; }

const MAX_RANGE = 92;

/** Admin Attendance Monitoring: every TIME IN / TIME OUT with selfies, per-employee summary. */
@Component({
  selector: 'app-attendance-monitor',
  imports: [FormsModule],
  template: `
  <div class="card filters">
    <div><label>From</label><input type="date" [(ngModel)]="from"></div>
    <div><label>To</label><input type="date" [(ngModel)]="to"></div>
    <div><label>Headquarters</label><select [(ngModel)]="hq"><option value="">All</option>@for (h of hqs(); track h) { <option [value]="h">{{ h }}</option> }</select></div>
    <div><label>Employee</label><select [(ngModel)]="emp"><option value="">All</option>@for (e of emps(); track e.id) { <option [value]="e.id">{{ e.name }} ({{ e.id }})</option> }</select></div>
    <div class="btns">
      <button class="btn pri" (click)="load()">Load</button>
      <button class="btn" (click)="range('today')">Today</button><button class="btn" (click)="range('week')">This week</button><button class="btn" (click)="range('month')">This month</button>
      <button class="btn" [disabled]="!shown().length" (click)="csv()">CSV</button>
    </div>
  </div>
  @if (error()) { <div class="err-box" style="margin:12px 0">{{ error() }}</div> }

  <div class="kpis" style="margin-top:14px">
    <div class="kpi navy"><small>Timed in now</small><b>{{ openNow().length }}</b><i>{{ openNow().map(nameOf).join(', ') || 'nobody' }}</i></div>
    <div class="kpi" [class.warn]="notInToday().length > 0"><small>Not timed in today</small><b>{{ notInToday().length }}</b><i>of {{ emps().length }} employee(s)</i></div>
    <div class="kpi"><small>Records</small><b>{{ shown().length }}</b><i>{{ nice(from) }} – {{ nice(to) }}</i></div>
    <div class="kpi"><small>Hours worked</small><b>{{ totalHours() }}</b><i>overtime after {{ otHours() }} hrs</i></div>
  </div>
  @if (notInToday().length) {
    <div class="warn-box"><b>Not timed in today:</b> @for (e of notInToday(); track e.id) { {{ e.name }} ({{ e.hq_code }}){{ $last ? '' : ', ' }} }</div>
  }

  <div class="section"><h3>Summary per employee</h3>
    <div class="tbl"><table class="t"><tr><th>Employee</th><th>HQ</th><th class="num">Days</th><th class="num">Hours</th><th class="num">Overtime</th><th class="num">Timed in now</th><th class="num">No time out</th></tr>
      @for (s of summary(); track s.id) {
        <tr><td><b>{{ s.name }}</b><small>{{ s.id }}</small></td><td>{{ s.hq }}</td><td class="num">{{ s.days }}</td><td class="num">{{ s.hours }}</td><td class="num">{{ s.ot || '—' }}</td>
          <td class="num">{{ s.open || '—' }}</td><td class="num" [class.bad]="s.noOut > 0">{{ s.noOut || '—' }}</td></tr>
      } @empty { <tr><td colspan="7" class="empty">No employees.</td></tr> }
    </table></div></div>

  <div class="section"><h3>Time in / time out</h3>
    <div class="tbl">
      @if (loading()) { <div class="empty">Loading attendance…</div> }
      @else if (!shown().length) { <div class="empty">No attendance in this range.</div> }
      @else {
        <table class="t"><tr><th>Date</th><th>Employee</th><th>Location</th><th>Time in</th><th>Time out</th><th class="num">Hours</th><th>Status</th><th>Remarks</th></tr>
          @for (r of shown(); track r.id) {
            <tr><td>{{ nice(r.work_date) }}</td><td><b>{{ r.employee_name }}</b><small>{{ r.employee_id }}</small></td><td>{{ r.site }}</td>
              <td>{{ time(r.time_in) }}@if (r.in_dist !== null) { <small>{{ r.in_dist }} m</small> }@if (r.in_photo) { <a href="" (click)="$event.preventDefault(); photo(r.in_photo)">selfie</a> }</td>
              <td>{{ r.time_out ? time(r.time_out) : '—' }}@if (r.out_dist !== null) { <small>{{ r.out_dist }} m</small> }@if (r.out_photo) { <a href="" (click)="$event.preventDefault(); photo(r.out_photo)">selfie</a> }</td>
              <td class="num">{{ r.hours ?? '—' }}</td><td><span [class]="'chip ' + chip(r.status)">{{ r.status }}</span></td><td><small>{{ r.remarks }}</small></td></tr>
          }
        </table>
      }
    </div></div>

  @if (img()) {
    <div class="overlay" role="dialog" aria-modal="true" aria-label="Selfie" (click)="img.set('')">
      <div class="modal narrow"><div class="modal-bar"><b>Selfie</b><button class="btn sm" (click)="img.set('')">Close</button></div>
        <img [src]="img()" alt="Selfie" style="width:100%;border-radius:12px"></div>
    </div>
  }`,
  styles: [`
    .filters{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;align-items:end}.filters .btns{grid-column:1/-1}
    @media (max-width:820px){.filters{grid-template-columns:repeat(2,minmax(0,1fr))}}
    td.bad{color:var(--red-dark);font-weight:600}td a{font-size:11.5px;display:block}
  `],
})
export class AttendanceMonitor {
  readonly emps = signal<Emp[]>([]);
  readonly list = signal<Att[]>([]);
  readonly todayRows = signal<Att[]>([]);
  readonly otHours = signal(10);
  readonly loading = signal(false);
  readonly error = signal('');
  readonly img = signal('');
  from = todayIso(); to = todayIso(); hq = ''; emp = '';
  readonly nice = niceDate; readonly time = niceTime;

  readonly hqs = computed(() => [...new Set(this.emps().map((e) => e.hq_code ?? '').filter((h) => h))].sort());
  readonly openNow = computed(() => this.todayRows().filter((r) => r.status === 'TIMED IN'));
  readonly notInToday = computed(() => { const s = new Set(this.todayRows().map((r) => r.employee_id.toUpperCase())); return this.emps().filter((e) => !s.has(e.id.toUpperCase())); });

  constructor() {
    setting<number>('attendance_ot_hours', 10).then((v) => this.otHours.set(Number(v) || 10)).catch(() => {});
    this.load();
  }

  nameOf = (r: Att): string => r.employee_name;
  chip(s: string): string { return s === 'COMPLETE' ? 'ok' : s === 'TIMED IN' ? 'blue' : 'bad'; }

  range(k: 'today' | 'week' | 'month'): void {
    const t = todayIso();
    this.to = t;
    if (k === 'today') this.from = t;
    else if (k === 'month') this.from = t.slice(0, 8) + '01';
    else { const [y, m, d] = t.split('-').map(Number); this.from = addDays(t, -((new Date(y, m - 1, d).getDay() + 6) % 7)); }
    this.load();
  }

  async load(): Promise<void> {
    this.loading.set(true); this.error.set('');
    try {
      if (!this.from) this.from = this.to || todayIso();
      if (!this.to) this.to = todayIso();
      if (this.from > this.to) [this.from, this.to] = [this.to, this.from];
      if (addDays(this.from, MAX_RANGE) < this.to) this.from = addDays(this.to, -MAX_RANGE);
      const t = todayIso();
      const [e, a, today] = await Promise.all([
        rows<Emp>(sb.from('employees').select('id, name, hq_code, active').eq('active', true).order('hq_code').order('name')),
        rows<Att>(sb.from('attendance').select('*').gte('work_date', this.from).lte('work_date', this.to)
          .order('work_date', { ascending: false }).order('time_in', { ascending: false }).limit(5000)),
        rows<Att>(sb.from('attendance').select('*').or(`work_date.eq.${t},status.eq."TIMED IN"`)),
      ]);
      this.emps.set(e); this.list.set(a); this.todayRows.set(today.filter((r) => r.work_date === t || r.status === 'TIMED IN'));
    } catch (err) { this.error.set(errMsg(err)); }
    finally { this.loading.set(false); }
  }

  private empHq(id: string): string { return this.emps().find((e) => e.id.toUpperCase() === id.toUpperCase())?.hq_code ?? ''; }
  shown(): Att[] {
    return this.list().filter((r) => (!this.emp || r.employee_id.toUpperCase() === this.emp.toUpperCase())
      && (!this.hq || this.empHq(r.employee_id) === this.hq));
  }
  summary(): Sum[] {
    const ot = this.otHours();
    const m = new Map<string, Sum & { dates: Set<string> }>();
    for (const e of this.emps()) {
      if ((this.hq && e.hq_code !== this.hq) || (this.emp && e.id !== this.emp)) continue;
      m.set(e.id.toUpperCase(), { id: e.id, name: e.name, hq: e.hq_code ?? '', days: 0, hours: 0, ot: 0, open: 0, noOut: 0, dates: new Set() });
    }
    for (const r of this.shown()) {
      const k = r.employee_id.toUpperCase();
      let s = m.get(k);
      if (!s) { s = { id: r.employee_id, name: r.employee_name, hq: this.empHq(r.employee_id), days: 0, hours: 0, ot: 0, open: 0, noOut: 0, dates: new Set() }; m.set(k, s); }
      s.dates.add(r.work_date);
      const h = Number(r.hours) || 0;
      if (h) { s.hours += h; if (h > ot) s.ot += h - ot; }
      if (r.status === 'TIMED IN') s.open++;
      if (r.status === 'NO TIME OUT') s.noOut++;
    }
    return [...m.values()].map((s) => ({ id: s.id, name: s.name, hq: s.hq, days: s.dates.size, hours: Math.round(s.hours * 100) / 100,
      ot: Math.round(s.ot * 100) / 100, open: s.open, noOut: s.noOut })).sort((a, b) => (a.hq + a.name).localeCompare(b.hq + b.name));
  }
  totalHours(): number { return Math.round(this.shown().reduce((a, r) => a + (Number(r.hours) || 0), 0) * 100) / 100; }

  async photo(path: string): Promise<void> {
    try { this.img.set(await signedUrl('attendance', path, 300)); } catch (e) { this.error.set(errMsg(e)); }
  }

  csv(): void {
    const out: unknown[][] = [['Date', 'Employee ID', 'Name', 'Location', 'Time in', 'Time out', 'Hours', 'Status', 'Remarks', 'Distance in (m)', 'Distance out (m)']];
    for (const r of this.shown()) out.push([r.work_date, r.employee_id, r.employee_name, r.site, niceTime(r.time_in), r.time_out ? niceTime(r.time_out) : '',
      r.hours ?? '', r.status, r.remarks ?? '', r.in_dist ?? '', r.out_dist ?? '']);
    downloadText(`attendance-${this.from}-to-${this.to}.csv`, toCsv(out));
  }
}
