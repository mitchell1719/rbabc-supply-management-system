import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';
import { AuthService } from '../../core/auth.service';
import { setting } from '../../core/scope';
import { errMsg, rows, rpc, sb } from '../../core/supabase';
import { UiService, escapeHtml } from '../../core/ui.service';
import { addDays, niceDate, niceTime, printHtml, shortBranch, todayIso } from '../../shared/format';

interface Loc { id: number; name: string; kind: 'HQ' | 'Branch'; hq_code: string; branch_id: string | null; ref_count: number; ref_names: string[]; }
interface Reading { id: number; location_id: number; reading_date: string; logged_at: string; session: string; ref_no: number; temp: number;
  min_temp: number | null; max_temp: number | null; status: string; action_taken: string | null; recorded_by: string; remarks: string | null; }
interface TSet { min: number; max: number; amEnd: number; }

@Component({
  selector: 'app-temperature',
  imports: [FormsModule],
  template: `
  @if (error()) { <div class="err-box">{{ error() }}</div> }
  <div class="pagebar">
    <div class="muted">Now <b>{{ nowText() }}</b> · Session <b>{{ session() }}</b> · Safe range <b>{{ st().min }}–{{ st().max }} °C</b></div>
    <div class="btns"><button class="btn" (click)="load()">Refresh</button><button class="btn pri" (click)="openChart()">Monthly chart / print</button></div>
  </div>

  @if (mine(); as L) {
    <div class="section" style="margin-top:0">
      <h3>{{ L.kind === 'HQ' ? L.name + ' refrigerators' : 'My refrigerator' }} — today</h3>
      <div class="refs">
        @for (no of refNos(L); track no) {
          <div class="ref" [class.bad]="isBad(L.id, no)">
            <h4>Ref {{ no }}{{ L.ref_names[no - 1] ? ' · ' + L.ref_names[no - 1] : '' }}
              <button class="btn sm" (click)="f.ref = no">{{ slot(L.id, no, session()) ? 'Recheck' : 'Log ' + session() }}</button></h4>
            @for (s of ['AM', 'PM']; track s) {
              <div class="slot"><span>{{ s }}</span>
                @if (slot(L.id, no, s); as e) { <b>{{ e.temp }} °C</b> <span [class]="'chip ' + (e.status === 'OK' ? 'ok' : 'bad')">{{ e.status === 'OK' ? 'OK' : 'OUT' }}</span> <small>{{ time(e.logged_at) }} · {{ e.recorded_by }}</small> }
                @else if (s === session()) { <span class="chip warn">DUE NOW</span> }
                @else if (s === 'AM' && session() === 'PM') { <span class="chip bad">MISSING</span> }
                @else { <span class="chip">Not yet</span> }
              </div>
            }
            @if (rechecks(L.id, no)) { <div class="slot"><span>Re</span>{{ rechecks(L.id, no) }} recheck(s)</div> }
          </div>
        }
      </div>
      <form class="card" (ngSubmit)="save()">
        <h4>Log a reading <span [class]="'chip ' + (willRecheck() ? 'warn' : 'blue')">{{ willRecheck() ? 'Will be saved as RECHECK' : session() + ' reading' }}</span></h4>
        <div class="grid4">
          <div><label>Refrigerator</label><select name="ref" [(ngModel)]="f.ref">
            @for (no of refNos(L, true); track no) { <option [ngValue]="no">{{ no > L.ref_count ? '+ Add refrigerator ' + no : 'Ref ' + no }}</option> }</select></div>
          <div><label>Temperature (°C)</label><input name="t" type="number" step="0.1" [(ngModel)]="f.temp" required></div>
          <div><label>Min (°C) <small class="muted">optional</small></label><input name="mn" type="number" step="0.1" [(ngModel)]="f.min"></div>
          <div><label>Max (°C) <small class="muted">optional</small></label><input name="mx" type="number" step="0.1" [(ngModel)]="f.max"></div>
        </div>
        @if (f.temp !== '' && f.temp !== null) {
          <p [class]="inRange() ? 'ok-box' : 'warn-box'" style="margin:10px 0 0">{{ f.temp }} °C is {{ inRange() ? 'within range' : 'OUT OF RANGE — write the action taken, then do a recheck.' }}</p>
        }
        <div class="grid2" style="margin-top:10px">
          <div><label>Recorded by</label><input name="by" [(ngModel)]="f.by" maxlength="80"></div>
          <div><label>Remarks <small class="muted">optional</small></label><input name="rm" [(ngModel)]="f.remarks" maxlength="300"></div>
          @if (!inRange()) { <div class="span-all"><label>Action taken (required)</label><textarea name="ac" [(ngModel)]="f.action" maxlength="300"></textarea></div> }
        </div>
        <div class="btns end" style="margin-top:12px"><button class="btn pri" [disabled]="busy()">{{ willRecheck() ? 'Save recheck' : 'Save ' + session() + ' reading' }}</button></div>
        <p class="muted" style="font-size:12px;margin:8px 0 0">Date and time are recorded by the server and cannot be changed. One AM and one PM reading per refrigerator; extra readings are saved as rechecks.</p>
      </form>
    </div>
  }

  @if (monitored().length) {
    <div class="section">
      <h3>{{ auth.is('Admin') ? 'All refrigerators' : auth.is('RNS') ? 'Refrigerators of your branches' : 'Branch refrigerators' }} — today</h3>
      <div class="tbl"><table class="t"><tr><th>Location</th><th>Type</th><th class="num">Ref</th><th>AM</th><th>PM</th><th class="num">Rechecks</th><th>Recorded by</th></tr>
        @for (l of monitored(); track l.id) {
          @for (no of refNos(l); track no) {
            <tr><td>@if (no === 1) { <b>{{ short(l.name) }}</b><small>{{ l.hq_code }}</small> }</td><td>{{ no === 1 ? l.kind : '' }}</td><td class="num">{{ no }}</td>
              @for (s of ['AM', 'PM']; track s) {
                <td>@if (slot(l.id, no, s); as e) { <b>{{ e.temp }} °C</b> <span [class]="'chip ' + (e.status === 'OK' ? 'ok' : 'bad')">{{ e.status === 'OK' ? 'OK' : 'OUT' }}</span><small>{{ time(e.logged_at) }}</small> }
                  @else if (s === session()) { <span class="chip warn">Due now</span> } @else if (s === 'AM') { <span class="chip bad">MISSING</span> } @else { — }</td>
              }
              <td class="num">{{ rechecks(l.id, no) || '' }}</td><td><small>{{ slot(l.id, no, 'AM')?.recorded_by }} {{ slot(l.id, no, 'PM')?.recorded_by }}</small></td></tr>
          }
        }
      </table></div>
    </div>
  }

  @if (mine()) {
    <div class="section"><h3>My readings — last 14 days</h3>
      <div class="tbl"><table class="t"><tr><th>Date</th><th>Time</th><th>Session</th><th class="num">Ref</th><th class="num">°C</th><th class="num">Min</th><th class="num">Max</th><th>Status</th><th>Recorded by</th><th>Action / remarks</th></tr>
        @for (e of history(); track e.id) {
          <tr><td>{{ nice(e.reading_date) }}</td><td>{{ time(e.logged_at) }}</td><td>{{ e.session }}</td><td class="num">{{ e.ref_no }}</td><td class="num"><b>{{ e.temp }}</b></td>
            <td class="num">{{ e.min_temp ?? '—' }}</td><td class="num">{{ e.max_temp ?? '—' }}</td><td><span [class]="'chip ' + (e.status === 'OK' ? 'ok' : 'bad')">{{ e.status }}</span></td>
            <td>{{ e.recorded_by }}</td><td>{{ note(e) }}</td></tr>
        } @empty { <tr><td colspan="10" class="empty">No readings in the last 14 days.</td></tr> }
      </table></div>
    </div>
  }

  @if (chart()) {
    <div class="overlay" (mousedown)="$event.target === $event.currentTarget && chart.set(false)">
      <div class="modal wide">
        <div class="modal-bar"><div class="btns">
            <label class="inl">Month <input type="month" [(ngModel)]="cMonth" (change)="buildChart()"></label>
            @if (chartLocs().length > 1) { <select [(ngModel)]="cLoc" (change)="cRef = 1; buildChart()">@for (l of chartLocs(); track l.id) { <option [ngValue]="l.id">{{ short(l.name) }}</option> }</select> }
            <select [(ngModel)]="cRef" (change)="buildChart()">@for (no of chartRefs(); track no) { <option [ngValue]="no">Ref {{ no }}</option> }</select></div>
          <div class="btns"><button class="btn pri" (click)="printChart()">Print / Save PDF</button><button class="btn" (click)="chart.set(false)">Close</button></div></div>
        <div style="overflow-x:auto"><div [innerHTML]="chartHtml()"></div></div>
      </div>
    </div>
  }`,
  styles: [`
    .refs{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:12px;margin-bottom:14px}
    .ref{background:#fff;border:1px solid var(--line);border-top:4px solid var(--blue);border-radius:12px;padding:12px 14px}
    .ref.bad{border-top-color:var(--red)}
    .ref h4{display:flex;justify-content:space-between;align-items:center;font-size:14px;color:var(--blue);margin-bottom:8px}
    .slot{display:flex;gap:8px;align-items:center;flex-wrap:wrap;padding:6px 0;border-top:1px dashed var(--line);font-size:13px}
    .slot > span:first-child{width:28px;color:var(--mute);font-weight:600}
    .slot small{color:var(--mute)}
    .inl{display:flex;align-items:center;gap:6px;margin:0;font-weight:500}
  `],
})
export class Temperature {
  readonly auth = inject(AuthService);
  private ui = inject(UiService);
  private san = inject(DomSanitizer);
  readonly today = todayIso();
  readonly st = signal<TSet>({ min: 2, max: 8, amEnd: 12 });
  readonly locs = signal<Loc[]>([]);
  readonly readings = signal<Reading[]>([]);
  readonly error = signal('');
  readonly busy = signal(false);
  readonly now = signal(new Date());
  readonly chart = signal(false);
  readonly chartHtml = signal<SafeHtml>('');
  cMonth = this.today.slice(0, 7);
  cLoc = 0;
  cRef = 1;
  private chartRows: Reading[] = [];
  f: any = { ref: 1, temp: '', min: '', max: '', by: this.auth.profile()?.fullName ?? '', remarks: '', action: '' };
  readonly nice = niceDate; readonly time = niceTime; readonly short = shortBranch;

  readonly hour = computed(() => Number(this.now().toLocaleString('en-US', { timeZone: 'Asia/Manila', hour: 'numeric', hour12: false })) % 24);
  readonly session = computed(() => (this.hour() < this.st().amEnd ? 'AM' : 'PM'));
  readonly nowText = computed(() => this.now().toLocaleTimeString('en-US', { timeZone: 'Asia/Manila', hour: 'numeric', minute: '2-digit' }));
  readonly mine = computed<Loc | null>(() => {
    const p = this.auth.profile();
    if (!p) return null;
    if (p.type === 'Branch') return this.locs().find((l) => l.branch_id === p.branchId) ?? null;
    if (p.type === 'HQ') return this.locs().find((l) => l.kind === 'HQ' && p.hqs.includes(l.hq_code)) ?? null;
    return null;
  });
  readonly monitored = computed(() => this.auth.is('Branch') ? [] : this.locs().filter((l) => l.id !== this.mine()?.id));
  readonly history = computed(() => { const m = this.mine(); return m ? this.readings().filter((r) => r.location_id === m.id).slice(0, 200) : []; });
  readonly chartLocs = computed(() => this.locs());

  constructor() {
    this.init();
    setInterval(() => this.now.set(new Date()), 60000);
  }

  private async init(): Promise<void> {
    try { this.st.set(await setting<TSet>('temperature', this.st())); } catch { /* defaults */ }
    await this.load();
  }

  async load(): Promise<void> {
    try {
      this.locs.set(await rows<Loc>(sb.from('fridge_locations').select('*').order('kind').order('name')));
      this.readings.set(await rows<Reading>(sb.from('temp_readings').select('*').gte('reading_date', addDays(this.today, -13))
        .order('logged_at', { ascending: false }).limit(5000)));
      this.now.set(new Date());
    } catch (e) { this.error.set(errMsg(e)); }
  }

  refNos(l: Loc, withAdd = false): number[] {
    let n = l.ref_count;
    for (const r of this.readings()) if (r.location_id === l.id && r.reading_date === this.today) n = Math.max(n, r.ref_no);
    const out = Array.from({ length: Math.min(n, 6) }, (_, i) => i + 1);
    if (withAdd && l.kind === 'HQ' && n < 6) out.push(n + 1);
    return out;
  }
  slot(loc: number, ref: number, s: string): Reading | undefined {
    return this.readings().find((r) => r.location_id === loc && r.ref_no === ref && r.session === s && r.reading_date === this.today);
  }
  rechecks(loc: number, ref: number): number {
    return this.readings().filter((r) => r.location_id === loc && r.ref_no === ref && r.session === 'RECHECK' && r.reading_date === this.today).length;
  }
  note(e: Reading): string { return [e.action_taken, e.remarks].filter((x) => !!x).join(' · '); }
  isBad(loc: number, ref: number): boolean { return ['AM', 'PM'].some((s) => { const e = this.slot(loc, ref, s); return !!e && e.status !== 'OK'; }); }
  willRecheck(): boolean { const m = this.mine(); return !!m && !!this.slot(m.id, Number(this.f.ref), this.session()); }
  inRange(): boolean { const t = Number(this.f.temp); return this.f.temp === '' || this.f.temp === null || (t >= this.st().min && t <= this.st().max); }

  async save(): Promise<void> {
    this.busy.set(true);
    try {
      const s = (v: unknown) => (v === null || v === undefined ? '' : String(v));
      const res = await rpc('temp_submit', { p: { ref: this.f.ref, recheck: this.willRecheck(), temp: s(this.f.temp), min: s(this.f.min), max: s(this.f.max),
        recordedBy: this.f.by, action: this.f.action, remarks: this.f.remarks } });
      this.ui.notify(res.msg, res.status === 'OK' ? 'ok' : 'err');
      this.f = { ...this.f, temp: '', min: '', max: '', remarks: '', action: '' };
      await this.load();
    } catch (e) { this.ui.notify(errMsg(e), 'err'); }
    finally { this.busy.set(false); }
  }

  /* ---------- monthly chart (the paper "Refrigerator Temperature Monitoring Chart") ---------- */
  chartRefs(): number[] { const l = this.locs().find((x) => x.id === this.cLoc); return Array.from({ length: l?.ref_count ?? 1 }, (_, i) => i + 1); }

  openChart(): void {
    this.cLoc = this.mine()?.id ?? this.locs()[0]?.id ?? 0;
    this.cRef = 1;
    this.chart.set(true);
    this.buildChart();
  }

  async buildChart(): Promise<void> {
    if (!this.cLoc || !/^\d{4}-\d{2}$/.test(this.cMonth)) return;
    const [y, m] = this.cMonth.split('-').map(Number);
    const days = new Date(y, m, 0).getDate();
    try {
      this.chartRows = await rows<Reading>(sb.from('temp_readings').select('*').eq('location_id', this.cLoc).eq('ref_no', this.cRef)
        .gte('reading_date', this.cMonth + '-01').lte('reading_date', `${this.cMonth}-${String(days).padStart(2, '0')}`).order('logged_at'));
      this.chartHtml.set(this.san.bypassSecurityTrustHtml(this.chartDoc(days)));
    } catch (e) { this.ui.notify(errMsg(e), 'err'); }
  }

  private chartDoc(days: number): string {
    const st = this.st(), h = escapeHtml, loc = this.locs().find((l) => l.id === this.cLoc)!;
    const cell = (d: number, s: string) => this.chartRows.find((r) => Number(r.reading_date.slice(8)) === d && r.session === s);
    const vals = (d: number) => this.chartRows.filter((r) => Number(r.reading_date.slice(8)) === d)
      .flatMap((r) => [r.temp, r.min_temp, r.max_temp]).filter((v): v is number => v !== null && v !== undefined).map(Number);
    let head = '<tr><th class="lbl">DAY</th>';
    for (let d = 1; d <= 31; d++) head += `<th colspan="2" class="${d > days ? 'off' : ''}">${d}</th>`;
    head += '</tr><tr><th class="deg">°C</th>';
    for (let d = 1; d <= 31; d++) head += `<th class="ap ${d > days ? 'off' : ''}">am</th><th class="ap ${d > days ? 'off' : ''}">pm</th>`;
    head += '</tr>';
    let body = '';
    for (let t = 16; t >= -5; t--) {
      body += `<tr class="${t >= st.min && t <= st.max ? 'band' : ''}"><th class="deg">${t > 0 ? '+' : ''}${t}°C</th>`;
      for (let d = 1; d <= 31; d++) for (const s of ['AM', 'PM']) {
        const e = d <= days ? cell(d, s) : undefined;
        let mark = '';
        if (e && Math.max(-5, Math.min(16, Math.round(e.temp))) === t) mark = `<i class="dot${e.temp < st.min || e.temp > st.max ? ' out' : ''}" title="${s} ${d}: ${e.temp} °C"></i>`;
        body += `<td class="${d > days ? 'off' : ''}">${mark}</td>`;
      }
      body += '</tr>';
    }
    const perDay = (fn: (d: number) => string) => { let x = ''; for (let d = 1; d <= 31; d++) x += `<td colspan="2" class="dv ${d > days ? 'off' : ''}">${d <= days ? fn(d) : ''}</td>`; return x; };
    const max = (d: number) => { const v = vals(d); return v.length ? String(Math.max(...v)) : ''; };
    const min = (d: number) => { const v = vals(d); return v.length ? String(Math.min(...v)) : ''; };
    const hiA = (d: number) => { const v = vals(d); return v.length ? (Math.max(...v) > st.max ? '<b class="al">ALARM</b>' : 'OK') : ''; };
    const loA = (d: number) => { const v = vals(d); return v.length ? (Math.min(...v) < -0.5 ? '<b class="al">ALARM</b>' : 'OK') : ''; };
    let ini = '';
    for (let d = 1; d <= 31; d++) for (const s of ['AM', 'PM']) {
      const e = d <= days ? cell(d, s) : undefined;
      ini += `<td class="ini ${d > days ? 'off' : ''}">${e ? h(e.recorded_by.split(/\s+/).map((w) => w[0]).join('').slice(0, 3).toUpperCase()) : ''}</td>`;
    }
    const by: Record<string, number> = {};
    for (const r of this.chartRows) by[r.recorded_by] = (by[r.recorded_by] ?? 0) + 1;
    const preparedBy = Object.keys(by).sort((a, b) => by[b] - by[a])[0] ?? '';
    const notes = this.chartRows.filter((r) => r.temp < st.min || r.temp > st.max)
      .map((r) => `${niceDate(r.reading_date)} ${r.session}: ${r.temp} °C${r.action_taken ? ' — ' + h(r.action_taken) : ''}`);
    const [y, m] = this.cMonth.split('-').map(Number);
    const month = new Date(y, m - 1, 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
    return `<div class="tcdoc"><style>
      .tcdoc{font-family:Arial,Helvetica,sans-serif;color:#111;min-width:1060px}
      .tcdoc h2{text-align:center;font-size:15px;margin:6px 0 4px}.tcdoc .sub{display:flex;justify-content:center;gap:28px;font-size:12.5px;font-weight:700;margin-bottom:8px}
      .tcg{border-collapse:collapse;width:100%;table-layout:fixed;font-size:8.5px}.tcg th,.tcg td{border:1px solid #333;padding:0;height:13px;text-align:center;font-weight:400;white-space:nowrap;overflow:hidden}
      .tcg tr:first-child th{background:#9DC3E6;font-weight:700}.tcg th.lbl,.tcg th.deg{width:46px}.tcg th.ap{font-size:7px}
      .tcg tr.band td,.tcg tr.band th.deg{background:#FFF59D}.tcg .off{background:#E9E9E9!important}
      .dot{display:inline-block;width:7px;height:7px;border-radius:50%;background:#1C3F94}.dot.out{background:#E1262D}
      .tcg tr.hi td,.tcg tr.hi th{background:#F8CBAD}.tcg tr.lo td,.tcg tr.lo th{background:#D9EAD3}.dv{font-size:7px}.al{color:#E1262D}.ini{font-size:6.5px}
      .foot{display:grid;grid-template-columns:1fr 1fr 1.6fr;gap:18px;margin-top:14px;font-size:11px;align-items:end}
      .ln{border-bottom:1px solid #111;min-height:18px;padding:2px 4px;font-weight:600;text-align:center}.rem{border:1px solid #111;min-height:60px;padding:4px 8px;font-size:10px}
      @page{size:A4 landscape;margin:8mm}</style>
      <h2>RABIES BUSTER ANIMAL BITE CENTER<br>REFRIGERATOR TEMPERATURE MONITORING CHART</h2>
      <div class="sub"><span>For the Month of ${h(month)}</span><span>${h(loc?.name)}</span><span>Refrigerator: Ref ${this.cRef}${loc?.ref_names?.[this.cRef - 1] ? ' — ' + h(loc.ref_names[this.cRef - 1]) : ''}</span></div>
      <table class="tcg">${head}${body}
        <tr class="hi"><th>&gt;+${st.max} °C</th><td colspan="62">Once every 24 hours, enter high alarm status and maximum temperature recorded</td></tr>
        <tr><th>Alarm/Ok</th>${perDay(hiA)}</tr><tr><th>Maximum °C</th>${perDay(max)}</tr>
        <tr class="lo"><th>&lt;−0.5 °C</th><td colspan="62">Once every 24 hours, enter low alarm status and minimum temperature recorded</td></tr>
        <tr><th>Alarm/Ok</th>${perDay(loA)}</tr><tr><th>Minimum °C</th>${perDay(min)}</tr><tr><th>Initials</th>${ini}</tr></table>
      <div class="foot"><div><b>Prepared By:</b><div class="ln">${h(preparedBy)}</div><small>RB ABC NURSE</small></div>
        <div><b>Noted By:</b><div class="ln"></div><small>RB ABC PHYSICIAN</small></div>
        <div class="rem"><b>Remarks</b><br>${notes.length ? notes.join('<br>') : `All readings within ${st.min}–${st.max} °C.`}</div></div></div>`;
  }

  printChart(): void {
    const [y, m] = this.cMonth.split('-').map(Number);
    printHtml(`<!doctype html><html><head><meta charset="utf-8"><title>Temperature chart</title></head><body>${this.chartDoc(new Date(y, m, 0).getDate())}</body></html>`);
  }
}
