import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { AuthService } from '../../core/auth.service';
import { BranchRow, scopeBranches, setting } from '../../core/scope';
import { errMsg, rows, rpc, sb } from '../../core/supabase';
import { UiService } from '../../core/ui.service';
import { addDays, niceDate, niceStamp, num, pct, shortBranch, todayIso } from '../../shared/format';

interface Settings { abh: number; spd: number; flag: number; }
interface Rep { id: number; report_date: string; branch_id: string; hq_code: string; prepared_by: string; abh_opened: number; abh_id: number; abh_im: number;
  abh_booster: number; spd_opened: number; spd_id: number; spd_im: number; spd_booster: number; reason: string | null; logged_at: string; }
interface Met { opened: number; idVials: number; used: number; wasted: number; util: number | null; ratio: number | null; }

export function metrics(opened: unknown, id: unknown, im: unknown, b: unknown, perVial: number): Met {
  const o = Number(opened) || 0, d = Number(id) || 0, m = Number(im) || 0, bb = Number(b) || 0;
  const idv = (d * 0.2 + bb * 0.1) / ((perVial || 2.5) * 0.2);
  const used = idv + m;
  return { opened: o, idVials: idv, used, wasted: o - used, util: o ? used / o : null, ratio: o ? (o - used) / o : null };
}

@Component({
  selector: 'app-wastage',
  imports: [FormsModule],
  template: `
  @if (error()) { <div class="err-box">{{ error() }}</div> }
  @if (isBranch()) {
    <form class="card" (ngSubmit)="submit()">
      <h4>Daily vial wastage report — {{ auth.profile()?.branchName }}</h4>
      <div class="grid2">
        <div><label>Report date</label><input type="date" name="d" [(ngModel)]="f.date" [max]="today" [min]="minDate" (change)="fill()"></div>
        <div><label>Prepared by (Nurse)</label><input name="pb" [(ngModel)]="f.preparedBy" maxlength="80"></div>
      </div>
      @if (existing()) { <div class="warn-box" style="margin-top:12px">You already reported for <b>{{ nice(f.date) }}</b> (logged {{ stamp(existing()!.logged_at) }}). Saving will <b>update</b> that report.</div> }
      <div class="prods">
        @for (p of prods; track p.key) {
          <fieldset [class]="p.key"><legend>{{ p.label }}</legend>
            <div class="grid4">
              <div><label>Vials opened</label><input type="number" min="0" step="1" [name]="p.key + 'o'" [(ngModel)]="f[p.key].opened"></div>
              <div><label>ID doses</label><input type="number" min="0" step="1" [name]="p.key + 'i'" [(ngModel)]="f[p.key].id"></div>
              <div><label>IM doses</label><input type="number" min="0" step="1" [name]="p.key + 'm'" [(ngModel)]="f[p.key].im"></div>
              <div><label>Booster</label><input type="number" min="0" step="1" [name]="p.key + 'b'" [(ngModel)]="f[p.key].booster"></div>
            </div>
            @if (calc(p.key); as m) {
              <div class="calc">ID vials <b>{{ n(m.idVials) }}</b> · Used <b>{{ n(m.used) }}</b> · Utilization <b>{{ pc(m.util) }}</b> ·
                @if (m.used > m.opened + 0.001) { <span class="bad">Doses need more vials than opened</span> }
                @else { Wasted <b [class.bad]="(m.ratio ?? 0) > st().flag">{{ n(m.wasted) }} ({{ pc(m.ratio) }})</b> }</div>
            }
          </fieldset>
        }
      </div>
      <label style="margin-top:12px">Reason of wastage @if (totalWasted() > 0.001) { <span style="color:var(--red)">(required — there is wastage)</span> }</label>
      <textarea name="rs" [(ngModel)]="f.reason" maxlength="300" placeholder="e.g. No patient came after the vial was opened"></textarea>
      <div class="btns end" style="margin-top:12px"><span class="muted">Total vials wasted: <b>{{ n(totalWasted()) }}</b></span>
        <button class="btn pri" type="submit" [disabled]="busy()">{{ existing() ? 'Update report' : 'Submit report' }}</button></div>
      <p class="muted" style="font-size:12px">ID dose = 0.2 mL · booster = 0.1 mL · IM dose = 1 vial · Abhayrab vial {{ st().abh * 0.2 }} mL · Speeda vial {{ st().spd * 0.2 }} mL · one report per branch per day.</p>
    </form>
  }

  <div class="section">
    <h3>{{ isBranch() ? 'My vial wastage reports' : 'Vial wastage monitoring' }}</h3>
    <div class="tools">
      <label class="inl">From <input type="date" [(ngModel)]="from"></label>
      <label class="inl">To <input type="date" [(ngModel)]="to"></label>
      @if (!isBranch()) { <select [(ngModel)]="branchFilter"><option value="">All branches</option>@for (b of branches(); track b.id) { <option [value]="b.id">{{ short(b.name) }}</option> }</select> }
      <button class="btn sm" type="button" (click)="load()">Show</button>
    </div>
    <div class="kpis">
      @if (!isBranch()) { <div class="kpi navy"><small>Reported today</small><b>{{ branches().length - missing().length }}/{{ branches().length }}</b><i>branches</i></div> }
      <div class="kpi"><small>Vials wasted</small><b>{{ n(tot().wasted) }}</b><i>{{ list().length }} report(s)</i></div>
      <div class="kpi"><small>Abhayrab wastage</small><b>{{ pc(tot().aRatio) }}</b><i>of vials opened</i></div>
      <div class="kpi"><small>Speeda wastage</small><b>{{ pc(tot().sRatio) }}</b><i>of vials opened</i></div>
    </div>
    @if (!isBranch() && missing().length) {
      <div class="warn-box"><b>{{ missing().length }} branch(es) have not reported today:</b> {{ missing().join(', ') }}</div>
    }
    @if (!isBranch()) {
      <div class="tbl" style="margin-bottom:14px"><table class="t">
        <tr><th>Branch</th><th class="num">Days reported</th><th>Today</th><th class="num">Abh opened</th><th class="num">Abh wasted</th><th class="num">Abh wastage</th>
          <th class="num">Spd opened</th><th class="num">Spd wasted</th><th class="num">Spd wastage</th><th>Last report</th></tr>
        @for (s of summary(); track s.id) {
          <tr><td><b>{{ short(s.name) }}</b><small>{{ s.hq }}</small></td><td class="num">{{ s.days }}</td>
            <td [style.color]="s.today ? 'var(--ok)' : 'var(--red-dark)'"><b>{{ s.today ? '✓' : '—' }}</b></td>
            <td class="num">{{ s.aOpen }}</td><td class="num">{{ n(s.aOpen - s.aUsed) }}</td><td class="num" [class.bad]="ratio(s.aOpen, s.aUsed) > st().flag">{{ pc(s.aOpen ? (s.aOpen - s.aUsed) / s.aOpen : null) }}</td>
            <td class="num">{{ s.sOpen }}</td><td class="num">{{ n(s.sOpen - s.sUsed) }}</td><td class="num" [class.bad]="ratio(s.sOpen, s.sUsed) > st().flag">{{ pc(s.sOpen ? (s.sOpen - s.sUsed) / s.sOpen : null) }}</td>
            <td>{{ nice(s.last) }}</td></tr>
        }
      </table></div>
    }
    <div class="tbl">
      @if (!list().length) { <div class="empty">{{ loading() ? 'Loading…' : 'No reports for this period.' }}</div> }
      @else {
        <table class="t"><tr><th>Date</th>@if (!isBranch()) { <th>Branch</th> }<th>Prepared by</th><th class="num">Abh opened</th><th class="num">ID / IM / B</th><th class="num">Wastage</th>
          <th class="num">Spd opened</th><th class="num">ID / IM / B</th><th class="num">Wastage</th><th class="num">Total wasted</th><th>Reason</th>@if (isBranch()) { <th></th> }</tr>
          @for (r of list(); track r.id) {
            <tr><td>{{ nice(r.report_date) }}</td>@if (!isBranch()) { <td>{{ short(branchName(r.branch_id)) }}</td> }<td>{{ r.prepared_by }}</td>
              <td class="num">{{ r.abh_opened }}</td><td class="num">{{ r.abh_id }} / {{ r.abh_im }} / {{ r.abh_booster }}</td>
              <td class="num" [class.bad]="(m(r, 'abh').ratio ?? 0) > st().flag">{{ pc(m(r, 'abh').ratio) }}</td>
              <td class="num">{{ r.spd_opened }}</td><td class="num">{{ r.spd_id }} / {{ r.spd_im }} / {{ r.spd_booster }}</td>
              <td class="num" [class.bad]="(m(r, 'spd').ratio ?? 0) > st().flag">{{ pc(m(r, 'spd').ratio) }}</td>
              <td class="num"><b>{{ n(m(r, 'abh').wasted + m(r, 'spd').wasted) }}</b></td><td>{{ r.reason }}</td>
              @if (isBranch()) { <td>@if (r.report_date >= minDate) { <button class="btn sm" (click)="edit(r.report_date)">Edit</button> }</td> }</tr>
          }
        </table>
      }
    </div>
    <p class="muted" style="font-size:12px">Wastage above {{ pc(st().flag) }} is shown in red.</p>
  </div>`,
  styles: [`
    .prods{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:12px}
    fieldset{border:2px solid var(--line);border-radius:12px;padding:10px 12px 12px;margin:0}
    fieldset.abh{border-color:#f3c7c7} fieldset.spd{border-color:#c9d5f0}
    legend{font-weight:800;font-size:13px;padding:0 6px} fieldset.abh legend{color:var(--red-dark)} fieldset.spd legend{color:var(--blue)}
    .calc{margin-top:10px;font-size:12.5px;color:var(--mute)}
    .bad{color:var(--red);font-weight:700}
    .inl{display:flex;align-items:center;gap:6px;margin:0;font-weight:500;color:var(--mute)}
    @media(max-width:760px){.prods{grid-template-columns:1fr}}
  `],
})
export class Wastage {
  readonly auth = inject(AuthService);
  private ui = inject(UiService);
  readonly today = todayIso();
  readonly minDate = addDays(this.today, -31);
  readonly isBranch = computed(() => this.auth.is('Branch'));
  readonly st = signal<Settings>({ abh: 2.5, spd: 3, flag: 0.2 });
  readonly branches = signal<BranchRow[]>([]);
  readonly reports = signal<Rep[]>([]);
  readonly todayReported = signal<Set<string>>(new Set());
  readonly loading = signal(true);
  readonly busy = signal(false);
  readonly error = signal('');
  readonly existing = signal<Rep | null>(null);
  readonly prods = [{ key: 'abh' as const, label: 'ABHAYRAB' }, { key: 'spd' as const, label: 'SPEEDA' }];
  from = this.today.slice(0, 8) + '01';
  to = this.today;
  branchFilter = '';
  f: any = this.blank();
  private recent: Rep[] = [];
  readonly nice = niceDate; readonly stamp = niceStamp; readonly short = shortBranch; readonly pc = pct;
  n(v: number): string { return num(v, 2); }
  ratio(o: number, u: number): number { return o ? (o - u) / o : 0; }

  readonly list = computed(() => this.reports().filter((r) => !this.branchFilter || r.branch_id === this.branchFilter));
  readonly missing = computed(() => this.branches().filter((b) => !this.todayReported().has(b.id)).map((b) => shortBranch(b.name)));
  readonly tot = computed(() => {
    let ao = 0, au = 0, so = 0, su = 0;
    for (const r of this.list()) { const a = this.m(r, 'abh'), s = this.m(r, 'spd'); ao += a.opened; au += a.used; so += s.opened; su += s.used; }
    return { wasted: ao - au + so - su, aRatio: ao ? (ao - au) / ao : null, sRatio: so ? (so - su) / so : null };
  });
  readonly summary = computed(() => {
    const m: Record<string, any> = {};
    for (const b of this.branches()) m[b.id] = { id: b.id, name: b.name, hq: b.hq_code, days: 0, aOpen: 0, aUsed: 0, sOpen: 0, sUsed: 0, last: '', today: this.todayReported().has(b.id) };
    for (const r of this.reports()) {
      const s = m[r.branch_id]; if (!s) continue;
      const a = this.m(r, 'abh'), sp = this.m(r, 'spd');
      s.days++; s.aOpen += a.opened; s.aUsed += a.used; s.sOpen += sp.opened; s.sUsed += sp.used;
      if (r.report_date > s.last) s.last = r.report_date;
    }
    return Object.values(m).sort((a: any, b: any) => (a.hq + a.name).localeCompare(b.hq + b.name));
  });
  totalWasted(): number { return Math.max(0, this.calc('abh').wasted) + Math.max(0, this.calc('spd').wasted); }

  constructor() { this.init(); }

  private blank() {
    return { date: this.today, preparedBy: this.auth.profile()?.fullName ?? '', reason: '',
      abh: { opened: '', id: '', im: '', booster: '' }, spd: { opened: '', id: '', im: '', booster: '' } };
  }

  private async init(): Promise<void> {
    try {
      this.st.set(await setting<Settings>('wastage', this.st()));
      if (!this.isBranch()) this.branches.set(await scopeBranches(this.auth));
      await this.load();
      if (this.isBranch()) await this.loadRecent();
    } catch (e) { this.error.set(errMsg(e)); }
  }

  async load(): Promise<void> {
    this.loading.set(true);
    try {
      let from = this.from, to = this.to;
      if (from > to) [from, to] = [to, from];
      this.reports.set(await rows<Rep>(sb.from('wastage_reports').select('*').gte('report_date', from).lte('report_date', to)
        .order('report_date', { ascending: false }).limit(5000)));
      const t = await rows<{ branch_id: string }>(sb.from('wastage_reports').select('branch_id').eq('report_date', this.today));
      this.todayReported.set(new Set(t.map((x) => x.branch_id)));
    } catch (e) { this.error.set(errMsg(e)); }
    finally { this.loading.set(false); }
  }

  private async loadRecent(): Promise<void> {
    this.recent = await rows<Rep>(sb.from('wastage_reports').select('*').gte('report_date', this.minDate));
    this.fill();
  }

  fill(): void {
    const e = this.recent.find((r) => r.report_date === this.f.date) ?? null;
    this.existing.set(e);
    if (e) {
      this.f = { date: e.report_date, preparedBy: e.prepared_by, reason: e.reason ?? '',
        abh: { opened: e.abh_opened, id: e.abh_id, im: e.abh_im, booster: e.abh_booster },
        spd: { opened: e.spd_opened, id: e.spd_id, im: e.spd_im, booster: e.spd_booster } };
    } else {
      const keep = { date: this.f.date, preparedBy: this.f.preparedBy || this.auth.profile()?.fullName || '' };
      this.f = { ...this.blank(), ...keep };
    }
  }

  edit(date: string): void { this.f.date = date; this.fill(); window.scrollTo({ top: 0, behavior: 'smooth' }); }

  m(r: Rep, k: 'abh' | 'spd'): Met {
    return k === 'abh' ? metrics(r.abh_opened, r.abh_id, r.abh_im, r.abh_booster, this.st().abh)
      : metrics(r.spd_opened, r.spd_id, r.spd_im, r.spd_booster, this.st().spd);
  }
  calc(k: 'abh' | 'spd'): Met { const x = this.f[k]; return metrics(x.opened, x.id, x.im, x.booster, k === 'abh' ? this.st().abh : this.st().spd); }
  branchName(id: string): string { return this.branches().find((b) => b.id === id)?.name ?? ''; }

  async submit(): Promise<void> {
    this.busy.set(true);
    try {
      const s = (v: unknown) => (v === null || v === undefined ? '' : String(v));
      const res = await rpc('wastage_submit', { p: { date: this.f.date, preparedBy: this.f.preparedBy, reason: this.f.reason,
        abh: { opened: s(this.f.abh.opened), id: s(this.f.abh.id), im: s(this.f.abh.im), booster: s(this.f.abh.booster) },
        spd: { opened: s(this.f.spd.opened), id: s(this.f.spd.id), im: s(this.f.spd.im), booster: s(this.f.spd.booster) } } });
      this.ui.notify(res.msg);
      await this.load(); await this.loadRecent();
    } catch (e) { this.ui.notify(errMsg(e), 'err'); }
    finally { this.busy.set(false); }
  }
}
