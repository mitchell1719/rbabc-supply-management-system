import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { AuthService } from '../../core/auth.service';
import { scopeBranches, setting } from '../../core/scope';
import { errMsg, rows, rpc, sb, signedUrl } from '../../core/supabase';
import { UiService, escapeHtml } from '../../core/ui.service';
import { niceDate, niceStamp, money, peso, printHtml, shortBranch, statusClass, todayIso } from '../../shared/format';

interface SoaRow { id: string; soa_no: string; soa_date: string; hq_code: string; dsm_key: string; dsm_label: string | null; dsm_name: string | null; area: string | null;
  period_from: string | null; period_to: string | null; prs_count: number; dn_count: number; total: number; status: string; prepared_by: string | null;
  submitted_at: string | null; approved_by: string | null; approved_at: string | null; admin_note: string | null; finance_by: string | null; finance_at: string | null;
  finance_ref: string | null; finance_note: string | null; hq_note: string | null; view_key: string; dsm_sent_at: string | null;
  history: { at: string; by: string; action: string; note: string }[]; updated_at: string; }
interface SoaLine { id: number; line_no: number; dn_id: string; dn_item_id: number | null; dn_no: string; prs_no: string | null; prs_date: string | null; branch: string;
  dn_date: string; rr_no: string | null; qty: number; unit: string | null; description: string; batch: string | null; unit_cost: number; total_cost: number; cost_source: string | null; }
interface Att { id: number; soa_id: string; path: string; name: string; mime: string | null; size: number | null; label: string | null; added_by: string | null; added_at: string; }
interface Dsm { key: string; role: string; manager_name: string | null; oic: string | null; area: string | null; branch_ids: string[]; active: boolean; }
interface CandLine { line: number; itemId: number; qty: number; sent: number; unit: string; desc: string; batch: string; condition: string; excluded: boolean; cost: number; src: string; }
interface Cand { id: string; no: string; date: string; branch: string; prs: string | null; prsDate: string | null; rr: string | null; rDate: string | null;
  validatedBy: string | null; discrepancy: string | null; lines: CandLine[]; }
interface Candidates { dsm: { key: string; label: string; area: string | null; branches: string[] }; ready: Cand[];
  waiting: { no: string; branch: string; status: string }[]; onSoa: { no: string; branch: string; soa: string }[]; }

const EDITABLE = ['Draft', 'Returned to HQ', 'Returned by Finance'];

@Component({
  selector: 'app-soa',
  imports: [FormsModule],
  template: `
  @if (error()) { <div class="err-box" style="margin-bottom:12px">{{ error() }}</div> }

  @if (mode() === 'list') {
    <div class="pagebar">
      <div class="seg">@for (f of filters(); track f[0]) { <button type="button" [class.on]="filter() === f[0]" (click)="filter.set(f[0])">{{ f[1] }} <i>{{ countOf(f[0]) }}</i></button> }</div>
      <div class="btns"><input type="search" [(ngModel)]="q" placeholder="Search SOA, DSM or reference" style="width:240px">
        <button class="btn" (click)="load()">Refresh</button>
        @if (isHq()) { <button class="btn pri" (click)="newSoa()">+ New SOA</button> }</div>
    </div>
    <div class="kpis">
      <div class="kpi navy"><small>Statements</small><b>{{ shown().length }}</b><i>in this view</i></div>
      <div class="kpi"><small>Total billed</small><b>{{ peso(sum(shown())) }}</b><i>excluding cancelled</i></div>
      <div class="kpi"><small>Waiting for approval</small><b>{{ countOf('approval') }}</b><i>{{ peso(sum(byStatus(['For Approval']))) }}</i></div>
      <div class="kpi"><small>With Finance</small><b>{{ countOf('finance') }}</b><i>{{ peso(sum(byStatus(['Sent to Finance', 'Received by Finance']))) }}</i></div>
    </div>
    <div class="tbl">
      @if (!shown().length) { <div class="empty">{{ loading() ? 'Loading statements…' : 'No statements of account in this view.' }}</div> }
      @else {
        <table class="t"><tr><th>SOA No.</th><th>Date</th><th>DSM / BM</th><th>HQ</th><th>Period</th><th class="num">PRS</th><th class="num">DN</th><th class="num">Total</th><th>Status</th><th></th></tr>
          @for (s of shown(); track s.id) {
            <tr class="go" (click)="open(s)"><td><b>{{ s.soa_no }}</b></td><td>{{ nice(s.soa_date) }}</td><td>{{ s.dsm_label }}<small>{{ s.area }}</small></td><td>{{ s.hq_code }}</td>
              <td>{{ nice(s.period_from) }} – {{ nice(s.period_to) }}</td><td class="num">{{ s.prs_count }}</td><td class="num">{{ s.dn_count }}</td><td class="num"><b>{{ peso(s.total) }}</b></td>
              <td><span [class]="'chip ' + cls(s.status)">{{ s.status }}</span>@if (s.finance_ref) { <small>Ref. {{ s.finance_ref }}</small> }</td>
              <td><button class="btn sm" (click)="$event.stopPropagation(); open(s)">Open</button></td></tr>
          }
        </table>
      }
    </div>
  }

  @if (mode() === 'build') {
    <div class="card">
      <h4>{{ editing() ? 'Edit ' + editing()!.soa_no : 'New Statement of Account' }}</h4>
      <p class="sub">Choose the District Sales Manager / Branch Manager and the delivery period. Only <b>validated</b> deliveries that are not on another SOA can be billed. Unit costs come from your HQ price list, the CW purchase order of the batch, or the CW product list — you can change them.</p>
      <div class="grid4">
        <div class="span2"><label>DSM / BM group</label><select [(ngModel)]="b.dsm" (change)="cand.set(null)"><option value="">Choose…</option>
          @for (g of dsms(); track g.key) { <option [value]="g.key">{{ dsmName(g) }}{{ g.area ? ' — ' + g.area : '' }}</option> }</select></div>
        <div><label>Deliveries from</label><input type="date" [(ngModel)]="b.from"></div>
        <div><label>to</label><input type="date" [(ngModel)]="b.to"></div>
      </div>
      <div class="btns" style="margin-top:10px"><button class="btn pri" [disabled]="!b.dsm || busy()" (click)="loadCand()">Load deliveries</button></div>
    </div>
    @if (cand(); as c) {
      <div class="card">
        <h4>{{ c.dsm.label }}</h4>
        <p class="sub">{{ c.dsm.area || '' }} · Branches: {{ c.dsm.branches.join(', ') || 'none' }}</p>
        @if (c.waiting.length) { <div class="warn-box">Not validated yet (cannot be billed): @for (w of c.waiting; track w.no) { <b>{{ w.no }}</b> ({{ short(w.branch) }} · {{ w.status }}){{ $last ? '' : ', ' }} }</div> }
        @if (c.onSoa.length) { <div class="info-box">Already on an SOA: @for (w of c.onSoa; track w.no) { {{ w.no }} → <b>{{ w.soa }}</b>{{ $last ? '' : ', ' }} }</div> }
        @if (!c.ready.length) { <div class="empty">No validated deliveries to bill for this group and period.</div> }
        @for (d of c.ready; track d.id) {
          <div class="dn" [class.off]="!picked[d.id]">
            <label class="dn-h"><input type="checkbox" [(ngModel)]="picked[d.id]" style="width:auto">
              <b>{{ d.no }}</b><span>{{ short(d.branch) }} · delivered {{ nice(d.date) }}{{ d.prs ? ' · PRS ' + d.prs : '' }} · RR {{ d.rr }} {{ nice(d.rDate) }}</span></label>
            @if (d.discrepancy) { <small class="bad">Discrepancy: {{ d.discrepancy }}</small> }
            <div class="tbl"><table class="t"><tr><th>Description</th><th>Batch</th><th class="num">Qty</th><th>Unit</th><th style="width:130px">Unit cost</th><th class="num">Total</th><th>Cost source</th></tr>
              @for (l of d.lines; track l.line) {
                <tr [class.short]="l.excluded"><td>{{ l.desc }}@if (l.excluded) { <small>Not billed — {{ l.condition }}</small> }</td><td>{{ l.batch }}</td><td class="num">{{ l.qty }}</td><td>{{ l.unit }}</td>
                  <td>@if (!l.excluded) { <input type="number" min="0" step="0.01" [(ngModel)]="costs[d.id][l.line]" [class.need]="!(+costs[d.id][l.line] > 0)"> }</td>
                  <td class="num">{{ l.excluded ? '—' : peso(lineTotal(d, l)) }}</td><td><small>{{ srcOf(d, l) }}</small></td></tr>
              }
            </table></div>
          </div>
        }
        @if (c.ready.length) {
          <div class="sumbar"><span>{{ pickedCount() }} delivery note(s) ticked</span><b>Total {{ peso(buildTotal()) }}</b></div>
          <label style="margin-top:12px">Note to the Supply Office (optional)</label><textarea [(ngModel)]="b.note" placeholder="e.g. Supplier invoices attached"></textarea>
        }
        <div class="btns end" style="margin-top:12px">
          <button class="btn" (click)="back()">Cancel</button>
          @if (c.ready.length) {
            <button class="btn" [disabled]="busy()" (click)="save(false)">Save draft</button>
            <button class="btn pri" [disabled]="busy()" (click)="save(true)">Submit for approval</button>
          }
        </div>
      </div>
    } @else { <div class="btns end" style="margin-top:12px"><button class="btn" (click)="back()">Cancel</button></div> }
  }

  @if (mode() === 'view' && cur(); as s) {
    <div class="pagebar">
      <button class="btn" (click)="back()">← All statements</button>
      <div class="btns">
        <button class="btn" (click)="print(s)">Print / save as PDF</button>
        @if (s.status !== 'Draft' && s.status !== 'Cancelled' && s.approved_at) { <button class="btn" (click)="copyLink(s)">Copy DN &amp; RR link</button> }
        @if (isHq() && editable(s)) { <button class="btn pri" (click)="edit(s)">Edit</button><button class="btn outline-red" (click)="act(s, 'cancel')">Cancel SOA</button> }
        @if (isAdmin() && s.status === 'For Approval') { <button class="btn outline-red" (click)="act(s, 'return')">Return to HQ</button><button class="btn pri" (click)="act(s, 'approve')">Approve &amp; send to Finance</button> }
        @if (isFinance() && s.status === 'Sent to Finance') { <button class="btn" (click)="act(s, 'receive')">Mark received</button> }
        @if (isFinance() && (s.status === 'Sent to Finance' || s.status === 'Received by Finance')) {
          <button class="btn outline-red" (click)="act(s, 'return')">Return for clarification</button><button class="btn pri" (click)="act(s, 'process')">Mark processed</button> }
      </div>
    </div>
    <div class="card">
      <div class="head"><div><h4>{{ s.soa_no }}</h4><p class="sub">{{ s.dsm_label }} · {{ s.area }} · {{ s.hq_code }} HQ · {{ nice(s.period_from) }} to {{ nice(s.period_to) }}</p></div>
        <div class="right"><span [class]="'chip ' + cls(s.status)">{{ s.status }}</span><div class="big">{{ peso(s.total) }}</div></div></div>
      @if (s.hq_note) { <div class="info-box"><b>HQ note:</b> {{ s.hq_note }}</div> }
      @if (s.admin_note) { <div [class]="s.status === 'Returned to HQ' ? 'warn-box' : 'info-box'"><b>Supply Office:</b> {{ s.admin_note }}</div> }
      @if (s.finance_note || s.finance_ref) { <div [class]="s.status === 'Returned by Finance' ? 'warn-box' : 'ok-box'"><b>Finance:</b> {{ s.finance_note }} {{ s.finance_ref ? '· Ref. ' + s.finance_ref : '' }}</div> }
      <div class="tbl"><table class="t"><tr><th>DN No.</th><th>PRS No.</th><th>Branch</th><th>Date</th><th>Description</th><th>Batch</th><th class="num">Qty</th><th>Unit</th><th class="num">Unit cost</th><th class="num">Total</th></tr>
        @for (l of lines(); track l.id) {
          <tr><td>{{ l.dn_no }}<small>RR {{ l.rr_no }}</small></td><td>{{ l.prs_no || '—' }}</td><td>{{ short(l.branch) }}</td><td>{{ nice(l.dn_date) }}</td><td>{{ l.description }}</td><td>{{ l.batch }}</td>
            <td class="num">{{ l.qty }}</td><td>{{ l.unit }}</td><td class="num">{{ peso(l.unit_cost) }}<small>{{ l.cost_source }}</small></td><td class="num">{{ peso(l.total_cost) }}</td></tr>
        }
        <tr class="group"><td colspan="9" class="right">Total</td><td class="num">{{ peso(s.total) }}</td></tr>
      </table></div>
    </div>
    <div class="grid2" style="margin-top:14px">
      <div class="card">
        <h4>Attachments</h4><p class="sub">Supplier invoices, delivery receipts and other supporting files.</p>
        @for (a of atts(); track a.id) {
          <div class="att"><a href="" (click)="$event.preventDefault(); openAtt(a)">{{ a.name }}</a><small>{{ a.label }} · {{ a.added_by }} · {{ stamp(a.added_at) }}</small>
            @if (canAttach(s)) { <button class="btn sm outline-red" (click)="detach(a)">Remove</button> }</div>
        } @empty { <p class="muted" style="font-size:13px">No files attached.</p> }
        @if (canAttach(s)) {
          <div class="btns" style="margin-top:10px"><select [(ngModel)]="attLabel" style="width:auto"><option>Supplier invoice</option><option>Delivery receipt</option><option>Official receipt</option><option>Other</option></select>
            <input type="file" (change)="attach(s, $event)" style="width:auto"></div>
        }
      </div>
      <div class="card">
        <h4>History</h4>
        @for (h of hist(s); track $index) { <div class="hist"><b>{{ h.action }}</b><small>{{ h.at }} · {{ h.by }}</small>@if (h.note) { <p>{{ h.note }}</p> }</div> }
        @if (s.dsm_sent_at) { <p class="muted" style="font-size:12.5px">E-mailed to the DSM / OIC {{ stamp(s.dsm_sent_at) }}.</p> }
      </div>
    </div>
  }`,
  styles: [`
    .dn{border:1px solid var(--line);border-radius:14px;padding:10px 12px;margin-top:10px}.dn.off{opacity:.6}
    .dn-h{display:flex;align-items:center;gap:10px;font-weight:400;margin-bottom:8px;cursor:pointer}.dn-h span{color:var(--mute);font-size:12.5px}
    .bad{color:var(--red-dark);display:block;margin-bottom:6px}
    input.need{border-color:var(--red)}
    .sumbar{display:flex;justify-content:space-between;align-items:center;margin-top:12px;padding:10px 14px;border-radius:12px;background:var(--pri-soft);color:var(--blue)}
    .head{display:flex;justify-content:space-between;gap:16px;flex-wrap:wrap}.big{font-size:22px;font-weight:600;margin-top:6px}
    .att{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:6px 0;border-top:1px solid var(--line)}.att small{color:var(--mute);flex:1}
    .hist{padding:7px 0;border-top:1px solid var(--line);font-size:13px}.hist small{display:block;color:var(--mute)}.hist p{margin:4px 0 0}
  `],
})
export class Soa {
  private auth = inject(AuthService);
  private ui = inject(UiService);
  readonly mode = signal<'list' | 'build' | 'view'>('list');
  readonly list = signal<SoaRow[]>([]);
  readonly loading = signal(false);
  readonly busy = signal(false);
  readonly error = signal('');
  readonly filter = signal('todo');
  q = '';
  readonly dsms = signal<Dsm[]>([]);
  readonly cand = signal<Candidates | null>(null);
  readonly editing = signal<SoaRow | null>(null);
  readonly cur = signal<SoaRow | null>(null);
  readonly lines = signal<SoaLine[]>([]);
  readonly atts = signal<Att[]>([]);
  b = { dsm: '', from: '', to: '', note: '' };
  picked: Record<string, boolean> = {};
  costs: Record<string, Record<number, any>> = {};
  attLabel = 'Supplier invoice';

  readonly isHq = computed(() => this.auth.type() === 'HQ');
  readonly isAdmin = computed(() => this.auth.type() === 'Admin');
  readonly isFinance = computed(() => this.auth.type() === 'Finance');
  readonly nice = niceDate; readonly stamp = niceStamp; readonly peso = peso; readonly cls = statusClass; readonly short = shortBranch;

  readonly filters = computed<[string, string][]>(() => [
    ['todo', this.isHq() ? 'To do' : this.isAdmin() ? 'For approval' : 'To process'],
    ['approval', 'For approval'], ['finance', 'With Finance'], ['done', 'Processed'], ['all', 'All'],
  ].filter((f, i, a) => a.findIndex((x) => x[1] === f[1]) === i) as [string, string][]);

  shown(): SoaRow[] {
    const q = this.q.trim().toLowerCase();
    return this.list().filter((s) => this.inFilter(s, this.filter()))
      .filter((s) => !q || [s.soa_no, s.dsm_label, s.area, s.hq_code, s.finance_ref, s.status].join(' ').toLowerCase().includes(q));
  }

  constructor() { this.load(); this.loadDsms(); }

  private inFilter(s: SoaRow, f: string): boolean {
    switch (f) {
      case 'todo': return this.isHq() ? EDITABLE.includes(s.status) : this.isAdmin() ? s.status === 'For Approval' || s.status === 'Returned by Finance'
        : s.status === 'Sent to Finance' || s.status === 'Received by Finance';
      case 'approval': return s.status === 'For Approval';
      case 'finance': return s.status === 'Sent to Finance' || s.status === 'Received by Finance';
      case 'done': return s.status === 'Processed by Finance';
      default: return true;
    }
  }
  countOf(f: string): number { return this.list().filter((s) => this.inFilter(s, f)).length; }
  byStatus(st: string[]): SoaRow[] { return this.list().filter((s) => st.includes(s.status)); }
  sum(l: SoaRow[]): number { return l.filter((s) => s.status !== 'Cancelled').reduce((a, s) => a + Number(s.total), 0); }
  editable(s: SoaRow): boolean { return EDITABLE.includes(s.status); }
  canAttach(s: SoaRow): boolean { return (this.isHq() && this.editable(s)) || (this.isAdmin() && s.status !== 'Cancelled'); }
  hist(s: SoaRow) { return (s.history ?? []).slice().reverse(); }
  dsmName(g: Dsm): string {
    const r = /branch/i.test(g.role) ? 'BM' : 'DSM';
    return r + (g.manager_name ? ' ' + g.manager_name : '') + (g.oic ? (g.manager_name ? ' · ' : ' — ') + 'OIC ' + g.oic : '');
  }

  async load(): Promise<void> {
    this.loading.set(true); this.error.set('');
    try { this.list.set(await rows<SoaRow>(sb.from('soas').select('*').order('updated_at', { ascending: false }).limit(1000))); }
    catch (e) { this.error.set(errMsg(e)); }
    finally { this.loading.set(false); }
  }
  private async loadDsms(): Promise<void> {
    if (!this.isHq()) return;
    try {
      const [groups, br] = await Promise.all([rows<Dsm>(sb.from('dsm_groups').select('*').eq('active', true).order('key')), scopeBranches(this.auth)]);
      const mine = new Set(br.map((x) => x.id));
      this.dsms.set(groups.filter((g) => (g.branch_ids ?? []).some((id) => mine.has(id))));
    } catch (e) { this.error.set(errMsg(e)); }
  }

  back(): void { this.mode.set('list'); this.cand.set(null); this.editing.set(null); this.error.set(''); this.load(); }

  newSoa(): void {
    this.editing.set(null); this.cand.set(null); this.picked = {}; this.costs = {};
    const t = todayIso();
    this.b = { dsm: '', from: t.slice(0, 8) + '01', to: t, note: '' };
    this.error.set(''); this.mode.set('build');
  }

  async edit(s: SoaRow): Promise<void> {
    this.editing.set(s); this.picked = {}; this.costs = {};
    this.b = { dsm: s.dsm_key, from: s.period_from ?? '', to: s.period_to ?? '', note: s.hq_note ?? '' };
    this.mode.set('build');
    await this.loadCand();
    // keep the deliveries and the costs entered by the HQ
    const ls = this.lines();
    const c = this.cand();
    if (!c) return;
    for (const d of c.ready) {
      const mine = ls.filter((l) => l.dn_id === d.id);
      this.picked[d.id] = mine.length > 0;
      for (const l of d.lines) {
        const m = mine.find((x) => x.dn_item_id === l.itemId);
        if (m && m.cost_source === 'Entered by HQ') this.costs[d.id][l.line] = Number(m.unit_cost);
      }
    }
  }

  async loadCand(): Promise<void> {
    this.busy.set(true); this.error.set('');
    try {
      const c = await rpc<Candidates>('soa_candidates', { p_dsm: this.b.dsm, p_from: this.b.from || null, p_to: this.b.to || null, p_editing: this.editing()?.id ?? null });
      this.costs = {};
      for (const d of c.ready) {
        this.costs[d.id] = {};
        for (const l of d.lines) this.costs[d.id][l.line] = Number(l.cost) > 0 ? Number(l.cost) : '';
        if (this.picked[d.id] === undefined) this.picked[d.id] = !this.editing();
      }
      this.cand.set(c);
    } catch (e) { this.error.set(errMsg(e)); }
    finally { this.busy.set(false); }
  }

  lineTotal(d: Cand, l: CandLine): number { return Math.round(Number(l.qty) * (Number(this.costs[d.id]?.[l.line]) || 0) * 100) / 100; }
  srcOf(d: Cand, l: CandLine): string {
    const v = this.costs[d.id]?.[l.line];
    if (v === '' || v === null || v === undefined) return 'No cost found — enter it';
    return Math.round(Number(v) * 100) / 100 === Math.round(Number(l.cost) * 100) / 100 ? l.src : 'Entered by HQ';
  }
  pickedCount(): number { return (this.cand()?.ready ?? []).filter((d) => this.picked[d.id]).length; }
  buildTotal(): number {
    let t = 0;
    for (const d of this.cand()?.ready ?? []) if (this.picked[d.id]) for (const l of d.lines) if (!l.excluded) t += this.lineTotal(d, l);
    return t;
  }

  async save(submit: boolean): Promise<void> {
    const c = this.cand();
    if (!c) return;
    const dns = c.ready.filter((d) => this.picked[d.id]).map((d) => {
      const costs: Record<string, string> = {};
      for (const l of d.lines) if (!l.excluded) { const v = this.costs[d.id][l.line]; costs[String(l.line)] = v === '' || v === null || v === undefined ? '' : String(v); }
      return { id: d.id, costs };
    });
    if (submit && !(await this.ui.confirm({ title: 'Submit for approval', message: `Send this SOA (${peso(this.buildTotal())}) to the Supply Office for approval?`, ok: 'Submit' }))) return;
    this.busy.set(true); this.error.set('');
    try {
      const r = await rpc<{ msg: string; id: string }>('soa_save', { p: { id: this.editing()?.id ?? '', dsmKey: this.b.dsm, from: this.b.from, to: this.b.to, note: this.b.note, dns }, p_submit: submit });
      this.ui.notify(r.msg);
      await this.load();
      const s = this.list().find((x) => x.id === r.id);
      this.cand.set(null); this.editing.set(null);
      if (s) await this.open(s); else this.mode.set('list');
    } catch (e) { this.error.set(errMsg(e)); }
    finally { this.busy.set(false); }
  }

  async open(s: SoaRow): Promise<void> {
    this.error.set('');
    try {
      const [ls, at] = await Promise.all([
        rows<SoaLine>(sb.from('soa_lines').select('*').eq('soa_id', s.id).order('line_no')),
        rows<Att>(sb.from('soa_attachments').select('*').eq('soa_id', s.id).order('added_at')),
      ]);
      this.cur.set(s); this.lines.set(ls); this.atts.set(at); this.mode.set('view');
    } catch (e) { this.error.set(errMsg(e)); }
  }
  private async refreshCur(): Promise<void> {
    const id = this.cur()?.id;
    await this.load();
    const s = this.list().find((x) => x.id === id);
    if (s) await this.open(s); else this.back();
  }

  async act(s: SoaRow, action: 'cancel' | 'approve' | 'return' | 'receive' | 'process'): Promise<void> {
    let note = '', ref = '';
    if (action === 'cancel') {
      if (!(await this.ui.confirm({ title: 'Cancel SOA', message: `Cancel ${s.soa_no}? Its deliveries can then be put on a new SOA.`, ok: 'Cancel SOA', tone: 'danger' }))) return;
    } else if (action === 'return') {
      const v = await this.ui.prompt({ title: this.isAdmin() ? 'Return to HQ' : 'Return for clarification', message: 'Write the reason. It is e-mailed with the SOA.', ok: 'Return', tone: 'danger', required: true });
      if (v === null) return; note = v;
    } else if (action === 'approve') {
      const v = await this.ui.prompt({ title: 'Approve SOA', message: `Approve ${s.soa_no} (${peso(s.total)})? It is e-mailed to Finance and to the DSM / OIC. Optional note to Finance:`, ok: 'Approve & send' });
      if (v === null) return; note = v;
    } else if (action === 'receive') {
      const v = await this.ui.prompt({ title: 'Mark received', message: 'Optional note:', ok: 'Mark received' });
      if (v === null) return; note = v;
    } else if (action === 'process') {
      const v = await this.ui.prompt({ title: 'Mark processed', message: 'Voucher / reference no. of the payment processing:', ok: 'Mark processed', required: true });
      if (v === null) return; ref = v;
      if (!ref.trim()) { this.error.set('Enter the voucher / reference no. of the payment processing.'); return; }
    }
    this.busy.set(true); this.error.set('');
    try { const r = await rpc<{ msg: string }>('soa_action', { p_id: s.id, p_action: action, p_note: note, p_ref: ref }); this.ui.notify(r.msg); await this.refreshCur(); }
    catch (e) { this.error.set(errMsg(e)); }
    finally { this.busy.set(false); }
  }

  async attach(s: SoaRow, ev: Event): Promise<void> {
    const input = ev.target as HTMLInputElement;
    const f = input.files?.[0];
    if (!f) return;
    this.error.set('');
    try {
      if (f.size > 15 * 1024 * 1024) throw new Error('The file must be 15 MB or smaller.');
      const path = `${s.id}/${Date.now()}-${f.name.replace(/[^A-Za-z0-9._-]/g, '_').slice(-80)}`;
      const { error } = await sb.storage.from('soa').upload(path, f, { contentType: f.type || 'application/octet-stream' });
      if (error) throw new Error(error.message);
      const r = await rpc<{ msg: string }>('soa_attach', { p_id: s.id, p: { path, name: f.name, mime: f.type, size: f.size, label: this.attLabel } })
        .catch(async (e) => { await sb.storage.from('soa').remove([path]); throw e; });
      this.ui.notify(r.msg);
      this.atts.set(await rows<Att>(sb.from('soa_attachments').select('*').eq('soa_id', s.id).order('added_at')));
    } catch (e) { this.error.set(errMsg(e)); }
    finally { input.value = ''; }
  }
  async detach(a: Att): Promise<void> {
    if (!(await this.ui.confirm({ title: 'Remove file', message: `Remove ${a.name}?`, ok: 'Remove', tone: 'danger' }))) return;
    try {
      const r = await rpc<{ msg: string; path: string }>('soa_detach', { p_att: a.id });
      await sb.storage.from('soa').remove([r.path]);
      this.atts.update((l) => l.filter((x) => x.id !== a.id));
      this.ui.notify(r.msg);
    } catch (e) { this.error.set(errMsg(e)); }
  }
  async openAtt(a: Att): Promise<void> {
    try { window.open(await signedUrl('soa', a.path, 600), '_blank', 'noopener'); } catch (e) { this.error.set(errMsg(e)); }
  }

  async copyLink(s: SoaRow): Promise<void> {
    const url = `${location.origin}/soa-view?soa=${encodeURIComponent(s.soa_no)}&k=${s.view_key}`;
    try { await navigator.clipboard.writeText(url); this.ui.notify('Link copied. It shows the DN & RR only — no prices.'); }
    catch { await this.ui.alert({ title: 'DN & RR link', message: url }); }
  }

  async print(s: SoaRow): Promise<void> {
    const sg = await setting<Record<string, string>>('soa_signers', {});
    const h = escapeHtml;
    const sig = (k: string, role: string) => { const [n, t] = String(sg[k] ?? '').split('|').map((x) => x.trim());
      return `<td><b>${role}:</b><span class="nm">${h(n ?? '')}</span><span class="ro">${h(t ?? '')}</span></td>`; };
    const groups = new Map<string, SoaLine[]>();
    for (const l of this.lines()) { const k = l.dn_no; if (!groups.has(k)) groups.set(k, []); groups.get(k)!.push(l); }
    let body = '';
    for (const [dn, ls] of groups) {
      const sub = ls.reduce((a, l) => a + Number(l.total_cost), 0);
      body += ls.map((l, i) => `<tr>${i === 0 ? `<td rowspan="${ls.length}">${h(l.dn_no)}<br><small>RR ${h(l.rr_no)}</small></td><td rowspan="${ls.length}">${h(l.prs_no ?? '')}</td>
        <td rowspan="${ls.length}">${h(l.branch)}</td><td rowspan="${ls.length}">${h(niceDate(l.dn_date))}</td>` : ''}
        <td>${h(l.description)}</td><td>${h(l.batch ?? '')}</td><td class="n">${h(l.qty)}</td><td>${h(l.unit ?? '')}</td><td class="n">${money(l.unit_cost)}</td><td class="n">${money(l.total_cost)}</td></tr>`).join('');
      body += `<tr class="sub"><td colspan="9" class="n">Subtotal ${h(dn)}</td><td class="n">${money(sub)}</td></tr>`;
    }
    const css = `<style>body{font-family:Arial,sans-serif;color:#111;font-size:12px;margin:18px}
      .brand{text-align:center;margin-bottom:10px}.brand b{display:block;font-size:24px;color:#E1262D}.brand span{display:block;font-weight:700;color:#1C3F94;letter-spacing:1.5px}.brand i{font-size:11px;color:#777}
      h2{text-align:center;font-size:16px;margin:6px 0 14px}.f{display:grid;grid-template-columns:150px 1fr 150px 1fr;gap:4px 10px;margin-bottom:12px}.f span{border-bottom:1px solid #111}
      table{width:100%;border-collapse:collapse}.it th,.it td{border:1px solid #111;padding:3px 5px;vertical-align:top}.it th{background:#1E3A8A;color:#fff}.n{text-align:right;white-space:nowrap}
      .sub td{background:#F2F4FA;font-weight:600}.tot td{font-size:14px;font-weight:700;background:#FFF200}small{color:#555}
      .sg{margin-top:26px}.sg td{border:1px solid #111;vertical-align:top;height:80px;width:33%;padding:4px 6px}.nm{display:block;text-align:center;margin-top:22px;font-weight:700}.ro{display:block;text-align:center;border-top:1px solid #111;margin-top:3px}
      @page{size:landscape;margin:10mm}</style>`;
    const html = `<div class="brand"><b>RABIES BUSTER</b><span>ANIMAL BITE CENTER</span><i>“Vaccinating people against Rabies since 2019”</i></div>
      <h2>STATEMENT OF ACCOUNT</h2>
      <div class="f"><b>SOA No.:</b><span>${h(s.soa_no)}</span><b>Date:</b><span>${h(niceDate(s.soa_date))}</span>
        <b>DSM / BM:</b><span>${h(s.dsm_label ?? '')}</span><b>Area:</b><span>${h(s.area ?? '')}</span>
        <b>Headquarters:</b><span>${h(s.hq_code)}</span><b>Period:</b><span>${h(niceDate(s.period_from))} to ${h(niceDate(s.period_to))}</span>
        <b>No. of PRS:</b><span>${s.prs_count}</span><b>No. of DN:</b><span>${s.dn_count}</span></div>
      <table class="it"><tr><th>DN No.</th><th>PRS No.</th><th>Branch</th><th>Delivery date</th><th>Description</th><th>Batch No.</th><th>Qty</th><th>Unit</th><th>Unit cost</th><th>Total</th></tr>
        ${body}<tr class="tot"><td colspan="9" class="n">GRAND TOTAL</td><td class="n">₱${money(s.total)}</td></tr></table>
      <table class="sg"><tr>${sig('prepared', 'Prepared by')}${sig('reviewed', 'Reviewed by')}${sig('approved', 'Approved by')}</tr></table>
      ${s.finance_ref ? `<p>Processed by Finance — reference ${h(s.finance_ref)} · ${h(niceStamp(s.finance_at))}</p>` : ''}`;
    printHtml(`<!doctype html><html><head><meta charset="utf-8"><title>${h(s.soa_no)}</title>${css}</head><body>${html}</body></html>`);
  }
}
