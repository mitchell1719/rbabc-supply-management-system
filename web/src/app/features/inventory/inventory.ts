import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { AuthService } from '../../core/auth.service';
import { errMsg, rpc, sb } from '../../core/supabase';
import { UiService, escapeHtml } from '../../core/ui.service';
import { niceDate, num, peso, todayIso } from '../../shared/format';

@Component({
  selector: 'app-inventory',
  imports: [FormsModule],
  template: `
  <div class="pagebar">
    @if (d()?.locations?.length) {
      <div class="seg">@for (l of d().locations; track l.key) { <button type="button" [class.on]="l.key === d().loc" (click)="switchTo(l.key)">{{ l.name }}</button> }</div>
    } @else { <b>{{ d()?.name }}</b> }
    <div class="btns"><button class="btn" (click)="load()">Refresh</button></div>
  </div>
  @if (error()) { <div class="err-box">{{ error() }}</div> }
  @if (!d() && !error()) { <div class="empty"><span class="spin"></span> Loading the inventory…</div> }

  @if (d(); as r) {
    <div class="kpis">
      @if (r.kind === 'CW') {
        <div class="kpi navy"><small>On hand at Central Warehouse</small><b>{{ n(sum(r.products, 'cw')) }}</b><i>units, all products</i></div>
        <div class="kpi"><small>Network stock</small><b>{{ n(sum(r.products, 'cw') + sum(r.products, 'atHqs') + sum(r.products, 'atBranches')) }}</b><i>CW + HQs + branches</i></div>
        <div class="kpi" [class.warn]="lowCount() > 0"><small>Low / no stock SKUs</small><b>{{ lowCount() }}</b><i>at the Central Warehouse</i></div>
        <div class="kpi"><small>Pending purchase orders</small><b>{{ pendingPos() }}</b><i>lines</i></div>
      } @else {
        <div class="kpi navy"><small>On hand at {{ r.name }}</small><b>{{ n(sum(r.products, 'hq')) }}</b><i>units</i></div>
        <div class="kpi"><small>At its branches</small><b>{{ n(sum(r.products, 'branches')) }}</b><i>delivered, per batch</i></div>
        <div class="kpi" [class.warn]="lowCount() > 0"><small>Low / no stock SKUs</small><b>{{ lowCount() }}</b><i>reorder soon</i></div>
        <div class="kpi" [class.warn]="expiring() > 0"><small>Expiring / expired batches</small><b>{{ expiring() }}</b><i>still in stock — deliver first</i></div>
      }
    </div>
    @if (r.kind === 'CW' && negatives().length) {
      <div class="warn-box"><b>{{ negatives().length }} product(s) show negative Central Warehouse stock</b> ({{ negatives().join(', ') }}): the HQs logged receipts that were never received at the Central Warehouse. Add the missing purchase orders (status Received) with the same batch numbers.</div>
    }
    @if (r.canEdit) {
      <div class="btns" style="margin-bottom:10px">
        @if (r.kind === 'HQ') { <button class="btn pri" (click)="openForm('receive')">+ Receive from Central Warehouse</button> }
        @else { <button class="btn pri" (click)="openForm('po')">+ Purchase order / stock in</button><button class="btn" (click)="openForm('transfer')">Transfer to an HQ</button> }
      </div>
    }
    @if (form()) {
      <div class="card" style="margin-bottom:14px">
        @switch (form()) {
          @case ('receive') {
            <h4>Receive stock from the Central Warehouse</h4><p class="sub">Log each batch that arrived. It is added to your HQ stock and can then be picked on a delivery note.</p>
            <div class="grid3">
              <div><label>Date received</label><input type="date" [(ngModel)]="x.date"></div>
              <div><label>DR / transfer no.</label><input [(ngModel)]="x.dr"></div>
              <div><label>Product (SKU)</label><select [(ngModel)]="x.sku" (change)="x.batch = ''"><option value="">Choose…</option>@for (p of r.products; track p.sku) { <option [value]="p.sku">{{ p.sku }} · {{ p.name }}</option> }</select></div>
              <div><label>Batch No.</label><input [(ngModel)]="x.batch" list="ivBatches" (change)="fillExpiry()"></div>
              <div><label>Expiry date</label><input type="date" [(ngModel)]="x.expiry"></div>
              <div><label>Quantity</label><input type="number" min="1" step="any" [(ngModel)]="x.qty"></div>
              <div class="span-all"><label>Remarks</label><input [(ngModel)]="x.remarks"></div>
            </div>
            <datalist id="ivBatches">@for (b of batchesFor(x.sku); track b.batch_no) { <option [value]="b.batch_no">exp {{ nice(b.expiry) }}</option> }</datalist>
          }
          @case ('po') {
            <h4>Purchase order / stock in — Central Warehouse</h4><p class="sub">One line per batch. “Received” adds the batch to the Central Warehouse stock right away; “Pending” only records the order.</p>
            <div class="grid3">
              <div><label>PO date</label><input type="date" [(ngModel)]="x.date"></div>
              <div><label>PO no.</label><input [(ngModel)]="x.po"></div>
              <div><label>Supplier</label><input [(ngModel)]="x.supplier" list="ivSup"><datalist id="ivSup">@for (s of r.suppliers; track s) { <option [value]="s"></option> }</datalist></div>
              <div><label>Product (SKU)</label><select [(ngModel)]="x.sku"><option value="">Choose…</option>@for (p of r.products; track p.sku) { <option [value]="p.sku">{{ p.sku }} · {{ p.name }}</option> }</select></div>
              <div><label>Batch No.</label><input [(ngModel)]="x.batch"></div>
              <div><label>Expiry date</label><input type="date" [(ngModel)]="x.expiry"></div>
              <div><label>Quantity</label><input type="number" min="1" step="any" [(ngModel)]="x.qty"></div>
              <div><label>Unit cost (optional)</label><input type="number" min="0" step="0.01" [(ngModel)]="x.cost"></div>
              <div><label>Status</label><select [(ngModel)]="x.status"><option>Received</option><option>Pending</option></select></div>
              <div class="span-all"><label>Remarks</label><input [(ngModel)]="x.remarks"></div>
            </div>
          }
          @case ('poedit') {
            <h4>Edit purchase order line {{ x.po }}</h4><p class="sub">{{ x.name }} ({{ x.sku }}) · set the status to <b>Received</b> when the stock arrives.</p>
            <div class="grid3">
              <div><label>Status</label><select [(ngModel)]="x.status"><option>Pending</option><option>Received</option><option>Cancelled</option></select></div>
              <div><label>Date received</label><input type="date" [(ngModel)]="x.received"></div>
              <div><label>Quantity</label><input type="number" min="1" step="any" [(ngModel)]="x.qty"></div>
              <div><label>Batch No.</label><input [(ngModel)]="x.batch"></div>
              <div><label>Expiry date</label><input type="date" [(ngModel)]="x.expiry"></div>
              <div><label>Unit cost</label><input type="number" min="0" step="0.01" [(ngModel)]="x.cost"></div>
              <div class="span-all"><label>Remarks</label><input [(ngModel)]="x.remarks"></div>
            </div>
          }
          @case ('transfer') {
            <h4>Transfer stock to an HQ</h4><p class="sub">Sends a batch from the Central Warehouse; it shows in that HQ’s inventory right away.</p>
            <div class="grid3">
              <div><label>To HQ</label><select [(ngModel)]="x.hq"><option value="">Choose HQ…</option>@for (h of r.hqs; track h.code) { <option [value]="h.code">{{ h.name }}</option> }</select></div>
              <div class="span2"><label>Batch (earliest expiry first)</label><select [(ngModel)]="x.batch"><option value="">Choose batch…</option>
                @for (b of cwBatches(); track b.batch_no) { <option [value]="b.batch_no">{{ b.batch_no }} · {{ b.name }} · exp {{ nice(b.expiry) }} · {{ n(b.cw) }} at CW</option> }</select></div>
              <div><label>Quantity</label><input type="number" min="1" step="any" [(ngModel)]="x.qty"></div>
              <div><label>Date</label><input type="date" [(ngModel)]="x.date"></div>
              <div><label>DR / transfer no.</label><input [(ngModel)]="x.dr"></div>
              <div class="span-all"><label>Remarks</label><input [(ngModel)]="x.remarks"></div>
            </div>
          }
        }
        <div class="btns end" style="margin-top:12px"><button class="btn" (click)="form.set('')">Cancel</button><button class="btn pri" [disabled]="busy()" (click)="save()">Save</button></div>
      </div>
    }

    <div class="seg" style="margin-bottom:10px">
      @for (t of tabs(); track t[0]) { <button type="button" [class.on]="tab() === t[0]" (click)="tab.set(t[0])">{{ t[1] }}</button> }
    </div>
    <div class="tools"><input type="search" [(ngModel)]="q" placeholder="Search SKU, product or batch no."></div>
    <div class="tbl">
      @switch (tab()) {
        @case ('products') {
          <table class="t"><tr><th>SKU</th><th>Product</th>
            @if (r.kind === 'CW') { <th class="num">CW on hand</th><th class="num">On order</th><th class="num">At HQs</th><th class="num">At branches</th><th class="num">CW value</th> }
            @else { <th class="num">HQ on hand</th><th class="num">At branches</th><th class="num">Reorder at</th><th class="num">Price / unit</th> }
            <th>Status</th><th class="num">Batches</th><th>Nearest expiry</th></tr>
            @for (p of filt(r.products, ['sku', 'name', 'category']); track p.sku) {
              <tr><td><b>{{ p.sku }}</b></td><td>{{ p.name }}<small>{{ p.category }} · {{ p.uom }}</small></td>
                @if (r.kind === 'CW') { <td class="num" [class.neg]="p.cw < 0"><b>{{ n(p.cw) }}</b></td><td class="num">{{ n(p.onOrder) }}</td><td class="num">{{ n(p.atHqs) }}</td><td class="num">{{ n(p.atBranches) }}</td><td class="num">{{ money(p.cw * p.cost) }}</td> }
                @else { <td class="num"><b>{{ n(p.hq) }}</b></td><td class="num">{{ n(p.branches) }}</td><td class="num">{{ p.reorder ?? '—' }}</td><td class="num">{{ p.price !== null ? money(p.price) : '—' }}@if (r.canEdit) { <button class="btn sm" style="margin-left:6px" (click)="setPrice(p)">Set</button> }</td> }
                <td><span [class]="'chip ' + stockCls(p)">{{ stockStatus(p) }}</span></td><td class="num">{{ p.batches }}</td><td>{{ nice(p.nearest) || '—' }}</td></tr>
            }
          </table>
        }
        @case ('batches') {
          <table class="t"><tr><th>Batch No.</th><th>Product</th><th>Expiry</th><th class="num">Days left</th><th>Alert</th>
            @if (r.kind === 'CW') { <th class="num">Received</th><th class="num">Sent out</th><th class="num">CW on hand</th>@for (h of r.hqs; track h.code) { <th class="num">{{ h.code }}</th> }<th class="num">At branches</th> }
            @else { <th class="num">Received from CW</th><th class="num">HQ on hand</th><th class="num">At branches</th> }</tr>
            @for (b of filt(r.batches, ['batch_no', 'sku', 'name']); track b.batch_no) {
              <tr><td><b>{{ b.batch_no }}</b></td><td>{{ b.name }}<small>{{ b.sku }}</small></td><td>{{ nice(b.expiry) }}</td><td class="num">{{ b.days }}</td>
                <td><span [class]="'chip ' + (b.alert === 'Expired' ? 'bad' : b.alert === 'OK' ? 'ok' : 'warn')">{{ b.alert }}</span></td>
                @if (r.kind === 'CW') { <td class="num">{{ n(b.received) }}</td><td class="num">{{ n(b.delivered) }}</td><td class="num" [class.neg]="b.cw < 0"><b>{{ n(b.cw) }}</b></td>
                  @for (h of r.hqs; track h.code) { <td class="num">{{ n(b.hqs[h.code] ?? 0) }}</td> }<td class="num">{{ n(b.branches) }}</td> }
                @else { <td class="num">{{ n(b.received) }}</td><td class="num"><b>{{ n(b.hq) }}</b></td><td class="num">{{ n(b.branches) }}</td> }</tr>
            }
          </table>
        }
        @case ('pos') {
          <table class="t"><tr><th>Date</th><th>PO no.</th><th>Supplier</th><th>Product</th><th>Batch No.</th><th>Expiry</th><th class="num">Qty</th><th class="num">Unit cost</th><th>Status</th><th>Remarks</th><th></th></tr>
            @for (p of filt(r.pos, ['po_no', 'supplier', 'sku', 'batch_no', 'name']); track p.id) {
              <tr><td>{{ nice(p.po_date) }}</td><td>{{ p.po_no || '—' }}</td><td>{{ p.supplier }}</td><td>{{ p.name }}<small>{{ p.sku }}</small></td><td>{{ p.batch_no || '—' }}</td>
                <td>{{ nice(p.expiry) || '—' }}</td><td class="num">{{ n(p.qty) }}</td><td class="num">{{ money(p.unit_cost) }}</td>
                <td><span [class]="'chip ' + (p.status === 'Received' ? 'ok' : p.status === 'Pending' ? 'warn' : 'bad')">{{ p.status }}</span></td><td>{{ p.remarks }}</td>
                <td>@if (r.canEdit) { <button class="btn sm" [class.pri]="p.status === 'Pending'" (click)="editPo(p)">{{ p.status === 'Pending' ? 'Mark received' : 'Edit' }}</button> }</td></tr>
            }
          </table>
        }
        @case ('receipts') {
          <table class="t"><tr><th>Date</th><th>DR / transfer no.</th><th>Batch No.</th><th>Product</th><th>Expiry</th><th class="num">Qty</th><th>Remarks</th></tr>
            @for (x of filt(r.receipts, ['dr', 'batch', 'name']); track $index) {
              <tr><td>{{ nice(x.date) }}</td><td>{{ x.dr || '—' }}</td><td><b>{{ x.batch }}</b></td><td>{{ x.name }}</td><td>{{ nice(x.expiry) }}</td><td class="num">{{ n(x.qty) }}</td><td>{{ x.remarks }}</td></tr>
            }
          </table>
        }
        @case ('orders') {
          <table class="t"><tr><th>Date</th><th>PRS / DN</th><th>Branch</th><th>Batch No.</th><th>Product</th><th>Expiry</th><th class="num">Qty</th><th>Remarks</th></tr>
            @for (x of filt(r.orders, ['ref', 'branch', 'batch', 'name']); track $index) {
              <tr><td>{{ nice(x.date) }}</td><td>{{ x.ref }}</td><td>{{ x.branch }}</td><td><b>{{ x.batch }}</b></td><td>{{ x.name }}</td><td>{{ nice(x.expiry) }}</td><td class="num">{{ n(x.qty) }}</td><td>{{ x.remarks }}</td></tr>
            }
          </table>
        }
      }
    </div>
  }`,
  styles: [`.neg{color:var(--red-dark)}`],
})
export class Inventory {
  readonly auth = inject(AuthService);
  private ui = inject(UiService);
  readonly d = signal<any>(null);
  readonly error = signal('');
  readonly busy = signal(false);
  readonly form = signal('');
  readonly tab = signal('products');
  private loc = 'CW';
  q = '';
  x: any = {};
  readonly nice = niceDate; readonly money = peso;
  n(v: unknown): string { return num(v, 2); }

  readonly tabs = computed(() => this.d()?.kind === 'CW'
    ? [['products', 'Products'], ['batches', 'Batches'], ['pos', 'Purchase orders']]
    : [['products', 'Products'], ['batches', 'Batches'], ['receipts', 'Received from CW'], ['orders', 'Delivered to branches']]);
  readonly lowCount = computed(() => (this.d()?.products ?? []).filter((p: any) => this.stockStatus(p) !== 'In Stock').length);
  readonly pendingPos = computed(() => (this.d()?.pos ?? []).filter((p: any) => p.status === 'Pending').length);
  readonly expiring = computed(() => (this.d()?.batches ?? []).filter((b: any) => b.alert !== 'OK' && (b.hq ?? b.cw) > 0).length);
  readonly negatives = computed(() => (this.d()?.products ?? []).filter((p: any) => p.cw < 0).map((p: any) => p.name));
  readonly cwBatches = computed(() => (this.d()?.batches ?? []).filter((b: any) => b.cw > 0 && b.alert !== 'Expired'));

  constructor() { this.load(); }

  async load(): Promise<void> {
    this.error.set('');
    try { const r = await rpc('inv_get', { p_loc: this.loc }); this.loc = r.loc; this.d.set(r); }
    catch (e) { this.error.set(errMsg(e)); }
  }
  switchTo(loc: string): void { this.loc = loc; this.form.set(''); this.tab.set('products'); this.d.set(null); this.load(); }

  sum(list: any[], k: string): number { return list.reduce((a, p) => a + (Number(p[k]) || 0), 0); }
  stockStatus(p: any): string {
    const v = this.d()?.kind === 'CW' ? p.cw : p.hq;
    if (v <= 0) return 'No Stock';
    if (p.reorder !== null && p.reorder !== undefined && v <= p.reorder) return 'Low Stock';
    return 'In Stock';
  }
  stockCls(p: any): string { const s = this.stockStatus(p); return s === 'In Stock' ? 'ok' : s === 'Low Stock' ? 'warn' : 'bad'; }
  filt(list: any[], keys: string[]): any[] {
    const q = this.q.trim().toLowerCase();
    return q ? (list ?? []).filter((x) => keys.map((k) => x[k] ?? '').join(' ').toLowerCase().includes(q)) : list ?? [];
  }
  batchesFor(sku: string): any[] { return (this.d()?.batches ?? []).filter((b: any) => !sku || b.sku === sku); }
  fillExpiry(): void { const b = (this.d()?.batches ?? []).find((y: any) => y.batch_no === String(this.x.batch ?? '').trim().toUpperCase()); if (b) { this.x.expiry = b.expiry; this.x.sku = b.sku; } }

  openForm(kind: string): void {
    this.x = { date: todayIso(), status: 'Received', sku: '', batch: '', expiry: '', qty: '', dr: '', remarks: '', hq: '', po: '', supplier: '', cost: '' };
    this.form.set(kind);
  }
  editPo(p: any): void {
    this.x = { id: p.id, po: p.po_no, sku: p.sku, name: p.name, status: p.status === 'Pending' ? 'Received' : p.status, received: p.received_date ?? todayIso(),
      qty: p.qty, batch: p.batch_no ?? '', expiry: p.expiry ?? '', cost: p.unit_cost, remarks: p.remarks ?? '', wasReceived: p.status === 'Received' };
    this.form.set('poedit');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  /** HQ "Price per Unit" — used as the unit cost on the Statement of Account. */
  async setPrice(p: any): Promise<void> {
    const v = await this.ui.prompt({ title: `Price per unit — ${p.name}`, label: 'Price (₱)', required: true, value: p.price !== null ? String(p.price) : '',
      hint: 'Used as the unit cost when this HQ bills the branches on a Statement of Account.' });
    if (v === null) return;
    const price = Number(v);
    if (!(price >= 0)) { this.ui.notify('Enter a valid price.', 'err'); return; }
    const { error } = await sb.from('hq_prices').upsert({ hq_code: this.d().hq, sku: p.sku, price: Math.round(price * 100) / 100 });
    if (error) { this.ui.notify(errMsg(error), 'err'); return; }
    this.ui.notify('Price saved.');
    await this.load();
  }

  async save(): Promise<void> {
    const k = this.form();
    const s = (v: unknown) => (v === null || v === undefined ? '' : String(v));
    if (k === 'poedit' && this.x.wasReceived && this.x.status !== 'Received') {
      const ok = await this.ui.confirm({ title: `Change to ${this.x.status}?`, tone: 'danger', ok: 'Yes, change it',
        html: `<span class="ud-pill">${escapeHtml(this.x.qty)} of batch ${escapeHtml(this.x.batch)} will be taken out of the Central Warehouse stock.</span>` });
      if (!ok) return;
    }
    const fn = { receive: 'inv_hq_receive', po: 'inv_po_add', poedit: 'inv_po_update', transfer: 'inv_transfer' }[k]!;
    const p: Record<string, string> = {};
    for (const [key, v] of Object.entries(this.x)) p[key] = s(v);
    this.busy.set(true);
    try {
      const res = await rpc(fn, { p });
      this.ui.notify(res.msg);
      this.form.set('');
      await this.load();
    } catch (e) { this.ui.notify(errMsg(e), 'err'); }
    finally { this.busy.set(false); }
  }
}
