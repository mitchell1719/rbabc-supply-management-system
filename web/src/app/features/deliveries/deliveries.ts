import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { AuthService } from '../../core/auth.service';
import { BranchRow, scopeBranches, setting } from '../../core/scope';
import { errMsg, rows, rpc, sb } from '../../core/supabase';
import { UiService, escapeHtml } from '../../core/ui.service';
import { itemKey, niceDate, niceStamp, printHtml, shortBranch, statusClass, todayIso } from '../../shared/format';

interface Dn { id: string; dn_no: string; delivery_date: string; hq_code: string; hq_name: string; branch_id: string; branch_name: string; prs_no: string | null;
  prs_date: string | null; prepared_by: string | null; approved_by: string | null; status: string; remarks: string | null; mode: string | null; rider: string | null;
  rr_no: string | null; received_date: string | null; received_by: string | null; witness: string | null; discrepancy: string | null; rr_remarks: string | null;
  validated_by: string | null; validated_at: string | null; dispatched_at: string | null; }
interface DnItem { id?: number; line_no?: number; qty: any; unit: string; description: string; batch_no: string; expiry: string; for_description: string;
  r_qty?: any; r_batch?: string; r_expiry?: string; condition?: string; note?: string; requested?: number | null; delivered?: number; }
interface Batch { batch: string; sku: string; name: string; uom: string; expiry: string; hq: number; alert: string; }

const CONDITIONS = ['Good', 'Short', 'Damaged', 'Expired / near expiry', 'Wrong item', 'Not delivered'];

@Component({
  selector: 'app-deliveries',
  imports: [FormsModule],
  template: `
  @if (error()) { <div class="err-box">{{ error() }}</div> }

  @if (mode() === 'list') {
    <div class="pagebar">
      <div class="seg">@for (fl of filters(); track fl[0]) { <button type="button" [class.on]="filter() === fl[0]" (click)="filter.set(fl[0])">{{ fl[1] }} <i>{{ countOf(fl[0]) }}</i></button> }</div>
      <div class="btns"><input type="search" [(ngModel)]="q" placeholder="Search DN, RR, PRS or branch" style="width:240px">
        <button class="btn" (click)="load()">Refresh</button>
        @if (isHq()) { <button class="btn pri" (click)="newDn()">+ New delivery note</button> }</div>
    </div>

    @if (isBranch() && toReceive().length) {
      <div class="section" style="margin-top:0"><h3>Deliveries to receive</h3><div class="cards">
        @for (d of toReceive(); track d.id) {
          <div class="todo"><b>{{ d.dn_no }}</b><small>From {{ d.hq_name }} · delivered {{ nice(d.delivery_date) }}{{ d.prs_no ? ' · PRS ' + d.prs_no : '' }}</small>
            <button class="btn pri sm" (click)="openReceive(d)">Receive &amp; count</button></div>
        }</div></div>
    }
    @if ((isHq() || isAdmin()) && toValidate().length) {
      <div class="section" style="margin-top:0"><h3>Receiving reports to validate</h3><div class="cards">
        @for (d of toValidate(); track d.id) {
          <div class="todo" [class.bad]="!!d.discrepancy"><b>{{ d.rr_no }}</b><small>{{ short(d.branch_name) }} · DN {{ d.dn_no }} · received {{ nice(d.received_date) }}</small>
            <small [style.color]="d.discrepancy ? 'var(--red-dark)' : 'var(--ok)'">{{ d.discrepancy ? 'Discrepancy: ' + d.discrepancy : 'All items match the delivery note' }}</small>
            <span class="btns"><button class="btn sm" (click)="doc(d, 'rr')">View</button><button class="btn pri sm" (click)="validate(d)">Validate</button></span></div>
        }</div></div>
    }
    @if (isHq() && waitingPrs().length) {
      <div class="section" style="margin-top:0"><h3>Approved PRS waiting for delivery</h3><div class="cards">
        @for (p of waitingPrs(); track p.id) {
          <div class="todo blue"><b>{{ p.control_no }}</b><small>{{ short(p.branch_name) }} · PRS {{ nice(p.prs_date) }} · {{ p.item_count }} item(s) · {{ p.status }}</small>
            <button class="btn pri sm" (click)="newDn(p.control_no)">{{ p.status === 'Partially Served' ? 'Deliver the rest' : 'Prepare delivery note' }}</button></div>
        }</div></div>
    }

    <div class="tbl">
      @if (!shown().length) { <div class="empty">{{ loading() ? 'Loading deliveries…' : 'No deliveries match this filter.' }}</div> }
      @else {
        <table class="t"><tr><th>DN Control No.</th><th>Delivery date</th><th>{{ isBranch() ? 'From' : 'Branch' }}</th><th>PRS No.</th><th>Status</th><th>Receiving report</th><th></th></tr>
          @for (d of shown(); track d.id) {
            <tr><td><b>{{ d.dn_no }}</b></td><td>{{ nice(d.delivery_date) }}</td><td>{{ isBranch() ? d.hq_name : short(d.branch_name) }}</td><td>{{ d.prs_no || '—' }}</td>
              <td><span [class]="'chip ' + cls(d.status)">{{ isBranch() && d.status === 'Dispatched' ? 'For receiving' : d.status }}</span>
                @if (d.discrepancy) { <small style="color:var(--red-dark)">{{ d.discrepancy }}</small> }</td>
              <td>{{ d.rr_no || '—' }}@if (d.received_date) { <small>{{ nice(d.received_date) }}</small> }</td>
              <td><div class="btns">
                <button class="btn sm" (click)="doc(d, 'dn')">View DN</button>
                @if (d.rr_no) { <button class="btn sm" (click)="doc(d, 'rr')">View RR</button> }
                @if (isHq() && d.status === 'Prepared') { <button class="btn pri sm" (click)="editDn(d)">Edit / dispatch</button> }
                @if (isBranch() && d.status === 'Dispatched' && !d.rr_no) { <button class="btn pri sm" (click)="openReceive(d)">Receive</button> }
                @if ((isHq() || isAdmin()) && d.rr_no && d.status !== 'Validated') { <button class="btn pri sm" (click)="validate(d)">Validate</button> }
              </div></td></tr>
          }
        </table>
      }
    </div>
  }

  @if (mode() === 'dn') {
    <div class="card">
      <h4>{{ e.id ? 'Delivery note ' + e.no : 'New delivery note' }}</h4>
      <p class="sub">Prepare and verify the approved order, pick the batch of each item from your HQ inventory, then dispatch. The branch sees it once dispatched.</p>
      <datalist id="prsList">@for (p of waitingPrs(); track p.id) { <option [value]="p.control_no">{{ short(p.branch_name) }} · {{ p.status }}</option> }</datalist>
      <datalist id="batchList">@for (b of inv(); track b.batch) { <option [value]="b.batch">{{ b.name }} · exp {{ nice(b.expiry) }} · {{ b.hq }} on hand</option> }</datalist>
      <div class="grid3">
        <div><label>PRS No. <small class="muted">pick or type</small></label><input [(ngModel)]="e.prsNo" list="prsList" (change)="lookupPrs()" placeholder="blank = no PRS"></div>
        <div><label>PRS date</label><input type="date" [(ngModel)]="e.prsDate"></div>
        <div><label>Destination branch</label><select [(ngModel)]="e.branchId"><option value="">Choose branch…</option>
          @for (b of branches(); track b.id) { <option [value]="b.id">{{ short(b.name) }}</option> }</select></div>
        <div><label>Delivery date</label><input type="date" [(ngModel)]="e.date"></div>
        <div><label>Sent by</label><select [(ngModel)]="e.mode">@for (m of modes; track m) { <option>{{ m }}</option> }</select></div>
        <div><label>Rider name / bus &amp; waybill no.</label><input [(ngModel)]="e.rider"></div>
        <div><label>Prepared by (Supply Officer)</label><input [(ngModel)]="e.preparedBy"></div>
        <div><label>Approved by (Supply Director)</label><input [(ngModel)]="e.approvedBy"></div>
        <div><label>Remarks</label><input [(ngModel)]="e.remarks" placeholder="e.g. keep 2–8 °C"></div>
      </div>
      <div class="tbl" style="margin-top:14px"><table class="t">
        <tr><th class="num">Requested</th><th>Deliver now</th><th>Unit</th><th>Description</th><th>Batch No.</th><th>Expiry</th><th></th></tr>
        @for (it of e.items; track $index) {
          <tr [class.short]="isShort(it)">
            <td class="num">@if (it.requested !== null && it.requested !== undefined) { <b>{{ it.requested }}</b>@if (it.delivered) { <small>{{ it.delivered }} sent before</small> } } @else { — }</td>
            <td style="width:96px"><input type="number" min="0" step="any" [(ngModel)]="it.qty"></td>
            <td style="width:90px"><input [(ngModel)]="it.unit"></td>
            <td><input [(ngModel)]="it.description">@if (isSub(it)) { <small style="color:var(--warn-ink)">instead of {{ it.for_description }}</small> }</td>
            <td style="width:170px"><input [(ngModel)]="it.batch_no" list="batchList" (change)="pickBatch(it)"><small [style.color]="batchHint(it).bad ? 'var(--red-dark)' : 'var(--ok)'">{{ batchHint(it).text }}</small></td>
            <td style="width:150px"><input type="date" [(ngModel)]="it.expiry"></td>
            <td>@if (it.requested === null || it.requested === undefined) { <button class="btn sm outline-red" (click)="e.items.splice($index, 1)">×</button> }</td></tr>
        }
      </table></div>
      <div class="btns" style="margin-top:8px"><button class="btn sm" (click)="e.items.push(blankItem())">+ Add item</button>
        <button class="btn sm" (click)="autoFill()">Fill batch no. (earliest expiry)</button></div>
      <p class="muted" style="font-size:12.5px">Enter only what you can send now. Put <b>0</b> for items with no stock — they stay pending on the PRS. No stock of the requested product? Change the <b>Description</b> to what you send instead and pick its batch.</p>
      @if (e.prsNo && hasRequested()) {
        <div [class]="pendingCount() ? 'warn-box' : 'ok-box'">{{ pendingCount() ? 'Partial delivery — ' + pendingCount() + ' item(s) short or not available now.' : 'Complete delivery.' }}
          <div class="btns" style="margin-top:6px"><label style="margin:0">PRS status after dispatch</label>
            <select [(ngModel)]="e.prsStatus" style="width:auto"><option value="">Suggested ({{ pendingCount() ? 'Partially Served' : 'Served' }})</option><option>Served</option><option>Partially Served</option></select></div></div>
      }
      <div class="btns end" style="margin-top:12px">
        <button class="btn" (click)="mode.set('list')">Cancel</button>
        <button class="btn" [disabled]="busy()" (click)="saveDn(false)">Save (prepared)</button>
        <button class="btn pri" [disabled]="busy()" (click)="saveDn(true)">Save &amp; dispatch</button>
      </div>
    </div>
  }

  @if (mode() === 'rr' && rr(); as d) {
    <div class="card">
      <h4>Receiving report for {{ d.dn_no }}</h4>
      <p class="sub">Count what arrived and check each item against the delivery note: quantity, batch number, expiry and condition. Differences are reported to the Supply Office.</p>
      <div class="grid3">
        <div><label>From</label><input [value]="d.hq_name + ' · ' + nice(d.delivery_date)" readonly></div>
        <div><label>Receipt date</label><input type="date" [(ngModel)]="r.receiptDate" [max]="today"></div>
        <div><label>Received by</label><input [(ngModel)]="r.receivedBy"></div>
        <div><label>Witness (HQ)</label><input [(ngModel)]="r.witness" placeholder="e.g. delivery rider"></div>
        <div class="span2"><label>Remarks</label><input [(ngModel)]="r.remarks" placeholder="Shortages, damage, temperature on arrival…"></div>
      </div>
      <div class="tbl" style="margin-top:14px"><table class="t"><tr><th>Description</th><th>Unit</th><th class="num">Qty on DN</th><th>Qty received</th><th>Batch No.</th><th>Expiry</th><th>Condition</th><th>Note</th></tr>
        @for (it of rrItems; track $index) {
          <tr [class.short]="rrDiff(it)"><td>{{ it.description }}</td><td>{{ it.unit }}</td><td class="num">{{ it.qty }}</td>
            <td style="width:90px"><input type="number" min="0" step="any" [(ngModel)]="it.r_qty"></td>
            <td style="width:130px"><input [(ngModel)]="it.r_batch"></td><td style="width:150px"><input type="date" [(ngModel)]="it.r_expiry"></td>
            <td style="width:160px"><select [(ngModel)]="it.condition">@for (c of conditions; track c) { <option>{{ c }}</option> }</select></td>
            <td><input [(ngModel)]="it.note"></td></tr>
        }
      </table></div>
      <div class="btns end" style="margin-top:12px"><button class="btn" (click)="mode.set('list')">Cancel</button>
        <button class="btn pri" [disabled]="busy()" (click)="submitRr()">Submit receiving report</button></div>
    </div>
  }`,
  styles: [`
    .cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:10px;margin-bottom:6px}
    .todo{border:1px solid #F3C7C7;background:#FFF7F7;border-radius:16px;padding:14px 16px;display:flex;flex-direction:column;gap:6px;align-items:flex-start}
    .todo.blue{background:#F6F8FF;border-color:#D8E0FB}.todo.bad{border-color:var(--red)}
    .todo small{color:var(--mute);font-size:12.5px}
    tr.short td{background:#FFF7F7}
  `],
})
export class Deliveries {
  readonly auth = inject(AuthService);
  private ui = inject(UiService);
  readonly today = todayIso();
  readonly isHq = computed(() => this.auth.is('HQ'));
  readonly isBranch = computed(() => this.auth.is('Branch'));
  readonly isAdmin = computed(() => this.auth.is('Admin'));
  readonly list = signal<Dn[]>([]);
  readonly prs = signal<any[]>([]);
  readonly branches = signal<BranchRow[]>([]);
  readonly inv = signal<Batch[]>([]);
  readonly loading = signal(true);
  readonly busy = signal(false);
  readonly error = signal('');
  readonly mode = signal<'list' | 'dn' | 'rr'>('list');
  readonly filter = signal('all');
  readonly rr = signal<Dn | null>(null);
  readonly modes = ['Delivery rider', 'Bus / cargo', 'Pick-up by branch', 'Other'];
  readonly conditions = CONDITIONS;
  q = '';
  e: any = {};
  r: any = {};
  rrItems: DnItem[] = [];
  private director = '';
  readonly nice = niceDate; readonly short = shortBranch; readonly cls = statusClass;

  readonly filters = computed(() => [['all', 'All'], ...(this.isBranch() ? [] : [['Prepared', 'Prepared']]), ['Dispatched', 'Dispatched'],
    ['recv', 'Received'], ['disc', 'With discrepancy'], ['Validated', 'Validated']] as [string, string][]);
  readonly toReceive = computed(() => this.list().filter((d) => d.status === 'Dispatched' && !d.rr_no));
  readonly toValidate = computed(() => this.list().filter((d) => d.rr_no && d.status !== 'Validated'));
  readonly waitingPrs = computed(() => {
    const used = new Set(this.list().map((d) => (d.prs_no ?? '').toUpperCase()));
    return this.prs().filter((p) => p.status === 'Partially Served' || !used.has(p.control_no.toUpperCase()));
  });

  constructor() { this.init(); }

  private async init(): Promise<void> {
    try {
      if (this.isHq()) {
        this.branches.set(await scopeBranches(this.auth));
        this.director = await setting<string>('supply_director_name', '');
      }
      await this.load();
    } catch (e) { this.error.set(errMsg(e)); }
  }

  async load(): Promise<void> {
    this.loading.set(true);
    try {
      this.list.set(await rows<Dn>(sb.from('delivery_notes_v').select('*').order('created_at', { ascending: false }).limit(1000)));
      if (this.isHq()) this.prs.set(await rows(sb.from('prs_v').select('id, control_no, prs_date, branch_name, status, item_count').in('status', ['Approved', 'Partially Served']).order('prs_date')));
    } catch (e) { this.error.set(errMsg(e)); }
    finally { this.loading.set(false); }
  }

  private match(d: Dn, f: string): boolean {
    if (f === 'all') return true;
    if (f === 'recv') return d.status.startsWith('Received');
    if (f === 'disc') return !!d.discrepancy;
    return d.status === f;
  }
  countOf(f: string): number { return this.list().filter((d) => this.match(d, f)).length; }
  shown(): Dn[] {
    const q = this.q.trim().toLowerCase();
    return this.list().filter((d) => this.match(d, this.filter()) && (!q || [d.dn_no, d.rr_no, d.prs_no, d.branch_name, d.hq_name].join(' ').toLowerCase().includes(q)));
  }

  /* ---------- HQ: delivery note editor ---------- */
  blankItem(): DnItem { return { qty: '', unit: '', description: '', batch_no: '', expiry: '', for_description: '', requested: null }; }

  private async loadInv(): Promise<void> {
    try { const r = await rpc('inv_hq_batches'); this.inv.set(r.batches ?? []); }
    catch (e) { this.ui.notify('Could not read your HQ inventory: ' + errMsg(e), 'err'); }
  }

  async newDn(prsNo = ''): Promise<void> {
    this.e = { id: '', no: '', prsNo, prsDate: '', branchId: '', date: this.today, mode: 'Delivery rider', rider: '',
      preparedBy: this.auth.name(), approvedBy: this.director, remarks: '', prsStatus: '', items: [this.blankItem()] };
    this.mode.set('dn');
    await this.loadInv();
    if (prsNo) await this.lookupPrs();
  }

  async editDn(d: Dn): Promise<void> {
    const items = await rows<any>(sb.from('dn_items').select('*').eq('dn_id', d.id).order('line_no'));
    this.e = { id: d.id, no: d.dn_no, prsNo: d.prs_no ?? '', prsDate: d.prs_date ?? '', branchId: d.branch_id, date: d.delivery_date, mode: d.mode || 'Delivery rider',
      rider: d.rider ?? '', preparedBy: d.prepared_by ?? '', approvedBy: d.approved_by ?? '', prsStatus: '',
      remarks: (d.remarks ?? '').replace(/\s*(·\s*)?Not delivered \(no stock yet\):.*$/i, '').replace(/\s*(·\s*)?Sent instead:[^·]*/i, '').trim(),
      items: items.map((i) => ({ qty: i.qty, unit: i.unit ?? '', description: i.description, batch_no: i.batch_no ?? '', expiry: i.expiry ?? '', for_description: i.for_description ?? '', requested: null })) };
    this.mode.set('dn');
    await this.loadInv();
    if (d.prs_no) await this.lookupPrs(true);
  }

  async lookupPrs(keepItems = false): Promise<void> {
    const no = String(this.e.prsNo ?? '').trim().toUpperCase();
    this.e.prsNo = no;
    if (!no) return;
    try {
      const res = await rpc('dn_prs_lookup', { p_prs_no: no, p_editing: this.e.id || null });
      if (!res.ok) { this.ui.notify(res.msg + ' It is saved on the delivery note as typed.', 'err'); return; }
      const p = res.prs;
      this.e.branchId = p.branchId; this.e.prsDate = p.date;
      if (!this.branches().some((b) => b.id === p.branchId)) this.branches.update((l) => [...l, { id: p.branchId, name: p.branch } as BranchRow]);
      const saved: Record<string, DnItem> = {};
      if (keepItems) for (const it of this.e.items as DnItem[]) saved[itemKey(it.for_description || it.description)] = it;
      const used = new Set<string>();
      const items: DnItem[] = p.items.map((i: any) => {
        const k = itemKey(i.desc), s = saved[k];
        if (s) { used.add(k); return { ...s, requested: i.requested, delivered: i.delivered, for_description: i.desc }; }
        return { qty: i.qty, unit: i.unit ?? '', description: i.desc, batch_no: '', expiry: '', for_description: i.desc, requested: i.requested, delivered: i.delivered };
      });
      for (const [k, s] of Object.entries(saved)) if (!used.has(k)) items.push(s);
      this.e.items = items.length ? items : [this.blankItem()];
      if (p.earlier?.length) this.ui.notify('Already delivered on ' + p.earlier.join(', ') + '. Showing what is still pending.');
    } catch (err) { this.ui.notify(errMsg(err), 'err'); }
  }

  hasRequested(): boolean { return (this.e.items as DnItem[]).some((i) => i.requested !== null && i.requested !== undefined); }
  isSub(it: DnItem): boolean { return !!it.for_description && itemKey(it.for_description) !== itemKey(it.description); }
  isShort(it: DnItem): boolean {
    if (it.requested === null || it.requested === undefined) return false;
    return (Number(it.qty) || 0) < it.requested - (it.delivered ?? 0);
  }
  pendingCount(): number { return (this.e.items as DnItem[]).filter((i) => this.isShort(i)).length; }

  private findBatch(b: string): Batch | undefined { const v = (b || '').trim().toUpperCase(); return this.inv().find((x) => x.batch === v); }
  pickBatch(it: DnItem): void {
    const b = this.findBatch(it.batch_no); if (!b) return;
    it.batch_no = b.batch; it.expiry = b.expiry;
    if (!it.description.trim()) it.description = b.name;
    if (!it.unit.trim()) it.unit = b.uom ?? '';
  }
  batchHint(it: DnItem): { text: string; bad: boolean } {
    if (!it.batch_no) return { text: '', bad: false };
    const b = this.findBatch(it.batch_no);
    if (!b) return { text: 'Not in your HQ inventory', bad: true };
    const used = (this.e.items as DnItem[]).filter((x) => (x.batch_no || '').toUpperCase() === b.batch).reduce((a, x) => a + (Number(x.qty) || 0), 0);
    if (b.alert === 'Expired') return { text: 'EXPIRED', bad: true };
    if (used > b.hq) return { text: `Only ${b.hq} on hand`, bad: true };
    return { text: `${b.hq} on hand · ${b.hq - used} left after this`, bad: false };
  }
  autoFill(): void {
    const used: Record<string, number> = {};
    for (const it of this.e.items as DnItem[]) { const b = this.findBatch(it.batch_no); if (b) used[b.batch] = (used[b.batch] ?? 0) + (Number(it.qty) || 0); }
    let n = 0;
    for (const it of this.e.items as DnItem[]) {
      const q = Number(it.qty) || 0;
      if (!q || it.batch_no) continue;
      const k = itemKey(it.description);
      const c = this.inv().filter((b) => b.alert !== 'Expired' && (itemKey(b.name).includes(k) || k.includes(itemKey(b.name))) && b.hq - (used[b.batch] ?? 0) >= q);
      if (!c.length) continue;
      it.batch_no = c[0].batch; it.expiry = c[0].expiry; used[c[0].batch] = (used[c[0].batch] ?? 0) + q; n++;
    }
    this.ui.notify(n ? `${n} batch no.(s) filled — earliest expiry first.` : 'No line could be filled from one batch with enough stock.', n ? 'ok' : 'err');
  }

  async saveDn(dispatch: boolean): Promise<void> {
    const items = (this.e.items as DnItem[]).map((i) => ({ qty: String(i.qty ?? ''), unit: i.unit, desc: i.description, batch: i.batch_no, expiry: i.expiry, forDesc: i.for_description }));
    if (dispatch) {
      const bad = (this.e.items as DnItem[]).filter((i) => Number(i.qty) > 0 && this.batchHint(i).bad);
      if (bad.length) { this.ui.notify('Fix the batch numbers first: ' + bad.map((b) => b.description).join(', '), 'err'); return; }
      const br = this.branches().find((b) => b.id === this.e.branchId);
      const lines = items.filter((i) => Number(i.qty) > 0).length;
      const ok = await this.ui.confirm({ title: 'Dispatch this delivery note?', ok: 'Dispatch',
        html: `Send <b>${lines} item(s)</b> to <b>${escapeHtml(shortBranch(br?.name ?? 'the branch'))}</b>.<br><br>The stock is deducted from your HQ inventory, and the note can no longer be edited after dispatch.` });
      if (!ok) return;
    }
    this.busy.set(true);
    try {
      const res = await rpc('dn_save', { p: { id: this.e.id || null, prsNo: this.e.prsNo, prsDate: this.e.prsDate, branchId: this.e.branchId, date: this.e.date,
        mode: this.e.mode, rider: this.e.rider, preparedBy: this.e.preparedBy, approvedBy: this.e.approvedBy, remarks: this.e.remarks,
        prsStatus: this.e.prsStatus, items }, p_dispatch: dispatch });
      this.ui.notify(res.msg);
      this.mode.set('list');
      await this.load();
    } catch (err) { this.ui.notify(errMsg(err), 'err'); }
    finally { this.busy.set(false); }
  }

  /* ---------- Branch: receiving report ---------- */
  async openReceive(d: Dn): Promise<void> {
    const items = await rows<any>(sb.from('dn_items').select('*').eq('dn_id', d.id).order('line_no'));
    this.rrItems = items.map((i) => ({ ...i, r_qty: i.qty, r_batch: i.batch_no ?? '', r_expiry: i.expiry ?? '', condition: 'Good', note: '' }));
    this.r = { receiptDate: this.today, receivedBy: this.auth.name(), witness: '', remarks: '' };
    this.rr.set(d);
    this.mode.set('rr');
  }
  rrDiff(it: DnItem): boolean {
    return Number(it.r_qty) !== Number(it.qty) || it.condition !== 'Good' || (it.r_batch || '').toUpperCase() !== (it.batch_no || '').toUpperCase() || (it.r_expiry || '') !== (it.expiry || '');
  }
  async submitRr(): Promise<void> {
    const d = this.rr()!;
    const bad = this.rrItems.filter((i) => this.rrDiff(i)).length;
    const ok = await this.ui.confirm({ title: 'Submit the receiving report?', tone: bad ? 'warn' : 'ok', ok: 'Submit report',
      html: `For delivery note <b>${escapeHtml(d.dn_no)}</b>.<br>` + (bad ? `<span class="ud-pill">${bad} item(s) differ from the delivery note and will be reported as discrepancies.</span>`
        : '<span class="ud-pill ok">All items match the delivery note.</span>') });
    if (!ok) return;
    this.busy.set(true);
    try {
      const res = await rpc('rr_submit', { p_dn: d.id, p: { ...this.r, items: this.rrItems.map((i) => ({ rQty: String(i.r_qty ?? ''), rBatch: i.r_batch, rExpiry: i.r_expiry, condition: i.condition, note: i.note })) } });
      this.ui.notify(res.msg);
      this.mode.set('list');
      await this.load();
    } catch (e) { this.ui.notify(errMsg(e), 'err'); }
    finally { this.busy.set(false); }
  }

  /* ---------- HQ / Admin: validate ---------- */
  async validate(d: Dn): Promise<void> {
    const note = await this.ui.prompt({ title: 'Validate receiving report ' + d.rr_no, tone: d.discrepancy ? 'warn' : 'ok', ok: 'Validate',
      html: `For delivery note <b>${escapeHtml(d.dn_no)}</b> to ${escapeHtml(shortBranch(d.branch_name))}.<br>` +
        (d.discrepancy ? `<span class="ud-pill"><b>Discrepancy:</b> ${escapeHtml(d.discrepancy)}</span>` : '<span class="ud-pill ok">All items match the delivery note.</span>'),
      label: d.discrepancy ? 'Action taken' : 'Note for the record', required: !!d.discrepancy, hint: 'Validated deliveries are added to the branch stock card.' });
    if (note === null) return;
    try { const res = await rpc('dn_validate', { p_dn: d.id, p_note: note }); this.ui.notify(res.msg); await this.load(); }
    catch (e) { this.ui.notify(errMsg(e), 'err'); }
  }

  /* ---------- printable documents ---------- */
  async doc(d: Dn, kind: 'dn' | 'rr'): Promise<void> {
    const items = await rows<any>(sb.from('dn_items').select('*').eq('dn_id', d.id).order('line_no'));
    const h = escapeHtml;
    const pad = (rs: string[], n: number, cols: number) => { const o = rs.slice(); while (o.length < n) o.push('<td>&nbsp;</td>'.repeat(cols)); return o.map((r) => `<tr>${r}</tr>`).join(''); };
    const css = `<style>body{font-family:'Times New Roman',Georgia,serif;color:#111;font-size:14px;max-width:760px;margin:20px auto}
      .brand{text-align:center;margin-bottom:18px}.brand b{display:block;font-family:Arial;font-size:26px;color:#E1262D}.brand span{display:block;font-family:Arial;font-weight:700;color:#1C3F94;letter-spacing:1.5px}
      .brand i{font-size:11px;color:#777}h2{text-align:center;font-size:17px;margin:0 0 18px}h2 small{display:block;font-size:13.5px}
      .f{display:grid;grid-template-columns:200px 1fr;gap:6px 10px;margin:0 0 18px;max-width:560px}.f span{border-bottom:1px solid #111;min-height:18px;padding:0 4px}
      table{width:100%;border-collapse:collapse}.it th,.it td{border:1px solid #111;padding:3px 6px;font-size:13px;height:20px}.it caption{border:1px solid #111;border-bottom:0;font-weight:700;padding:3px}
      .sg td{border:1px solid #111;vertical-align:top;height:78px;width:33%;padding:4px 6px;font-size:13px}.sg .nm{display:block;text-align:center;margin-top:14px;font-weight:600}
      .sg .ro{display:block;text-align:center;border-top:1px solid #111;margin-top:4px;font-size:12.5px}.note{background:#FFF200;padding:6px 8px;margin:18px 0 12px;font-size:12.5px}
      .rem{border:1px solid #111;min-height:60px;padding:4px 8px;font-size:13px}.rs{display:flex;justify-content:space-between;gap:30px;margin-top:30px}.rs div{flex:1;max-width:260px}
      .rs span{display:block;border-top:1px solid #111;text-align:center;font-size:13px}.rs em{display:block;text-align:center;font-style:normal;font-weight:600}</style>`;
    const brand = '<div class="brand"><b>RABIES BUSTER</b><span>ANIMAL BITE CENTER</span><i>“Vaccinating people against Rabies since 2019”</i></div>';
    let html: string;
    if (kind === 'dn') {
      const rs = items.map((i) => `<td style="text-align:center">${h(i.qty)}</td><td>${h(i.unit)}</td><td>${h(i.description)}</td><td>${h(i.batch_no)}</td><td>${h(niceDate(i.expiry))}</td>`);
      html = `${brand}<h2>DELIVERY NOTE<small>[HEAD QUARTER – ${h(d.hq_name)}]</small></h2><div class="f"><b>HQDR Control No.:</b><span>${h(d.dn_no)}</span>
        <b>Delivery Date:</b><span>${h(niceDate(d.delivery_date))}</span><b>Destination Branch:</b><span>${h(d.branch_name)}</span>
        <b>Sent by:</b><span>${h([d.mode, d.rider].filter(Boolean).join(' — '))}</span><b>PRS Date:</b><span>${h(niceDate(d.prs_date))}</span><b>PRS No.:</b><span>${h(d.prs_no)}</span></div>
        <table class="it"><caption>Items for Delivery</caption><tr><th>Quantity</th><th>Unit</th><th>Description</th><th>Batch No.</th><th>Expiry Date</th></tr>${pad(rs, 14, 5)}</table>
        <table class="sg"><tr><td><b>Prepared by:</b><span class="nm">${h(d.prepared_by)}</span><span class="ro">Supply Officer</span></td>
        <td><b>Approved by:</b><span class="nm">${h(d.approved_by)}</span><span class="ro">Supply Director</span></td>
        <td><b>Received by:</b><span class="nm">${h(d.received_by)}</span><span class="ro">Branch Receiving Officer / NOD</span></td></tr></table>
        <div class="note">Note: If no confirmation of receipt is provided after receiving the Delivery Note, it will be understood that all items listed above have been received in good order and condition.</div>
        <div class="rem"><b>Remarks:</b> ${h(d.remarks)}</div>`;
    } else {
      const rs = items.map((i) => `<td>${h(i.description)}</td><td>${h(i.unit)}</td><td style="text-align:center">${h(i.r_qty)}${Number(i.r_qty) !== Number(i.qty) ? ` <small>(DN ${h(i.qty)})</small>` : ''}</td>
        <td>${h(i.r_batch)}</td><td>${h(niceDate(i.r_expiry))}</td><td>${h(i.condition)}${i.note ? ' — ' + h(i.note) : ''}</td>`);
      html = `${brand}<h2>RECEIVING REPORT<small>[${h(d.branch_name)}]</small></h2><div class="f"><b>BRR Control No.:</b><span>${h(d.rr_no)}</span>
        <b>Receipt Date:</b><span>${h(niceDate(d.received_date))}</span><b>Delivery Note No.:</b><span>${h(d.dn_no)}</span>
        <b>Purchase Request Date:</b><span>${h(niceDate(d.prs_date))}</span><b>Purchase Request No.:</b><span>${h(d.prs_no)}</span></div>
        <table class="it"><caption>Actual Count upon Receipt</caption><tr><th>Description</th><th>Unit</th><th>Quantity</th><th>Batch No.</th><th>Expiry Date</th><th>Condition</th></tr>${pad(rs, 16, 6)}</table>
        ${d.discrepancy ? `<div class="rem" style="margin-top:12px"><b>Discrepancies:</b> ${h(d.discrepancy)}</div>` : ''}${d.rr_remarks ? `<div class="rem" style="margin-top:8px"><b>Remarks:</b> ${h(d.rr_remarks)}</div>` : ''}
        <div class="rs"><div><b>Received by:</b><em>${h(d.received_by)}</em><span>Name and Signature</span></div><div><b>Witness (HQ):</b><em>${h(d.witness)}</em><span>Name and Signature</span></div></div>
        ${d.validated_by ? `<p style="margin-top:18px;font-size:12.5px">Validated by ${h(d.validated_by)} · ${h(niceStamp(d.validated_at))}</p>` : ''}`;
    }
    printHtml(`<!doctype html><html><head><meta charset="utf-8"><title>${h(kind === 'dn' ? d.dn_no : d.rr_no)}</title>${css}</head><body>${html}</body></html>`);
  }
}
