import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { AuthService } from '../../core/auth.service';
import { errMsg, rows, sb } from '../../core/supabase';
import { UiService } from '../../core/ui.service';
import { niceStamp, todayIso } from '../../shared/format';

interface Week { week_of: string; wins: string[]; cascading: string[]; escalation: string[]; updated_at: string | null; updated_by: string | null; }
type Key = 'wins' | 'cascading' | 'escalation';

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONL = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const MAX_ITEMS = 30, MAX_LEN = 300;

function iso(d: Date): string { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }
/** Monday of the week that contains this date. */
function mondayOf(v: string): string {
  const [y, m, d] = v.split('-').map(Number);
  const x = new Date(y, m - 1, d);
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7));
  return iso(x);
}

/** Admin Monday Report: Wins · For Cascading · For Escalation, one row per week. */
@Component({
  selector: 'app-monday',
  imports: [FormsModule],
  template: `
  <div class="pagebar no-print">
    <div class="btns"><label style="margin:0">Week of</label>
      <select [ngModel]="week()" (ngModelChange)="go($event)" [disabled]="editing()" style="width:auto">
        @for (w of weekList(); track w) { <option [value]="w">{{ label(w) }}{{ w === thisWeek ? ' (this week)' : has(w) ? '' : ' (new)' }}</option> }</select>
      <input type="date" [ngModel]="week()" (ngModelChange)="go($event)" [disabled]="editing()" style="width:auto" title="Pick any day to open that week"></div>
    <div class="btns">
      @if (editing()) { <button class="btn" (click)="cancel()">Cancel</button><button class="btn pri" [disabled]="busy()" (click)="save()">{{ busy() ? 'Saving…' : 'Save' }}</button> }
      @else { <button class="btn pri" (click)="edit()">Edit this week</button><button class="btn" (click)="print()">Print / save as PDF</button> }
    </div>
  </div>
  @if (error()) { <div class="err-box no-print" style="margin-bottom:12px">{{ error() }}</div> }
  <div class="sheet">
    <div class="brand"><img src="logo.png" alt="" width="54" height="54">
      <div class="nm"><b>RABIES BUSTER</b><span>ANIMAL BITE CENTER</span><i>“Vaccinating people against Rabies since 2019”</i></div>
      <div class="when"><b>Monday Report</b><span>{{ label(week(), true) }}</span></div></div>
    <table class="mr"><tr><th>WINS</th><th>FOR CASCADING</th><th>FOR ESCALATION</th></tr>
      <tr>@for (k of keys; track k) {
        <td>@if (editing()) { <textarea [(ngModel)]="draft[k]" [attr.aria-label]="k" placeholder="One item per line"></textarea> }
          @else { @if (cur()[k].length) { <ul>@for (s of cur()[k]; track $index) { <li>{{ s }}</li> }</ul> } @else { <span class="none">Nothing written yet.</span> } }</td>
      }</tr></table>
    <p class="meta">{{ cur().updated_at ? 'Last saved ' + stamp(cur().updated_at) + (cur().updated_by ? ' by ' + cur().updated_by : '') : (editing() ? '' : 'Not saved yet for this week.') }}</p>
  </div>`,
  styles: [`
    .sheet{background:#fff;border:1px solid var(--line);border-radius:18px;padding:22px}
    .brand{display:flex;align-items:center;gap:14px;border-bottom:3px solid var(--navy);padding-bottom:12px;margin-bottom:14px}
    .nm b{display:block;font-size:22px;color:#E1262D;letter-spacing:.5px}.nm span{display:block;font-weight:700;color:#1C3F94;letter-spacing:1.5px;font-size:13px}.nm i{font-size:11px;color:var(--mute)}
    .when{margin-left:auto;text-align:right}.when b{display:block;font-size:18px;color:var(--navy)}.when span{font-size:13px;color:var(--mute)}
    table.mr{width:100%;border-collapse:collapse;table-layout:fixed}
    table.mr th{background:var(--navy);color:#fff;padding:9px;font-size:13px;letter-spacing:1px}
    table.mr td{border:1px solid var(--line);vertical-align:top;padding:10px 12px;font-size:13.5px;height:320px}
    table.mr ul{margin:0;padding-left:18px}table.mr li{margin:0 0 6px;line-height:1.45}
    table.mr textarea{width:100%;height:300px;font-size:13.5px}
    .none{color:var(--mute);font-style:italic}.meta{font-size:12px;color:var(--mute);margin:10px 0 0}
    @media (max-width:720px){table.mr,table.mr tr,table.mr td,table.mr th{display:block}table.mr td{height:auto}}
    @media print{.sheet{border:0;padding:0}table.mr td{height:auto;min-height:420px}}
  `],
})
export class Monday {
  private auth = inject(AuthService);
  private ui = inject(UiService);
  readonly keys: Key[] = ['wins', 'cascading', 'escalation'];
  readonly thisWeek = mondayOf(todayIso());
  readonly weeks = signal<Record<string, Week>>({});
  readonly week = signal(this.thisWeek);
  readonly editing = signal(false);
  readonly busy = signal(false);
  readonly error = signal('');
  draft: Record<Key, string> = { wins: '', cascading: '', escalation: '' };
  readonly stamp = niceStamp;

  readonly cur = computed<Week>(() => this.weeks()[this.week()] ?? { week_of: this.week(), wins: [], cascading: [], escalation: [], updated_at: null, updated_by: null });
  readonly weekList = computed(() => {
    const l = Object.keys(this.weeks());
    for (const w of [this.thisWeek, this.week()]) if (!l.includes(w)) l.push(w);
    return l.sort().reverse();
  });

  constructor() { this.load(); }

  async load(): Promise<void> {
    try {
      const r = await rows<Week>(sb.from('monday_reports').select('*').order('week_of', { ascending: false }));
      const m: Record<string, Week> = {};
      for (const w of r) m[w.week_of] = w;
      this.weeks.set(m);
    } catch (e) { this.error.set(errMsg(e)); }
  }

  has(w: string): boolean { return !!this.weeks()[w]; }
  label(w: string, long = false): string {
    const [y, m, d] = w.split('-').map(Number);
    if (!long) return `${MON[m - 1]} ${d}, ${y}`;
    const end = new Date(y, m - 1, d + 4);
    return `Week of ${MONL[m - 1]} ${d}, ${y} (to ${MON[end.getMonth()]} ${end.getDate()})`;
  }
  go(v: string): void { if (v) { this.week.set(mondayOf(v)); this.error.set(''); } }
  edit(): void {
    const c = this.cur();
    this.draft = { wins: c.wins.join('\n'), cascading: c.cascading.join('\n'), escalation: c.escalation.join('\n') };
    this.editing.set(true); this.error.set('');
  }
  cancel(): void { this.editing.set(false); }

  private clean(v: string): string[] {
    return v.split(/\r?\n/).map((s) => s.replace(/^\s*[•●▪\-*]\s*/, '').replace(/\s+/g, ' ').trim().slice(0, MAX_LEN)).filter((s) => s).slice(0, MAX_ITEMS);
  }

  async save(): Promise<void> {
    this.busy.set(true); this.error.set('');
    const w = this.week();
    const data = { wins: this.clean(this.draft.wins), cascading: this.clean(this.draft.cascading), escalation: this.clean(this.draft.escalation) };
    try {
      if (!data.wins.length && !data.cascading.length && !data.escalation.length) {
        const { error } = await sb.from('monday_reports').delete().eq('week_of', w);
        if (error) throw new Error(error.message);
        this.weeks.update((m) => { const c = { ...m }; delete c[w]; return c; });
        this.ui.notify(`Monday Report for ${this.label(w)} cleared.`);
      } else {
        const by = this.auth.name() || this.auth.profile()?.username || '';
        const { data: row, error } = await sb.from('monday_reports')
          .upsert({ week_of: w, ...data, updated_at: new Date().toISOString(), updated_by: by }).select().single();
        if (error) throw new Error(error.message);
        this.weeks.update((m) => ({ ...m, [w]: row as Week }));
        this.ui.notify(`Monday Report for ${this.label(w)} saved.`);
      }
      this.editing.set(false);
    } catch (e) { this.error.set(errMsg(e)); }
    finally { this.busy.set(false); }
  }

  print(): void { window.print(); }
}
