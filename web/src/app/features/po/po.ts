import { printBrand } from '../../shared/brand';
import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { AuthService } from '../../core/auth.service';
import { errMsg, rpc } from '../../core/supabase';
import { UiService, escapeHtml } from '../../core/ui.service';
import { niceDate, niceStamp, money, peso, printHtml, statusClass, todayIso } from '../../shared/format';

interface PoRow { no: string; date: string; supplier: string | null; items: number; total: number; logStatus?: string | null; status: string; financeRef: string | null; updated: string | null; }
interface Product { sku: string; name: string; uom: string | null; cost: number; supplier: string | null; }
interface PoLine { id: number; sku: string; name: string; uom: string | null; qty: number; cost: number; total: number; status: string; batch: string | null; }
interface PoHead { po_no: string; po_date: string | null; supplier: string | null; address: string | null; contact: string | null; due_date: string | null;
  receipt_date: string | null; expected_date: string | null; payment_terms: string | null; shipping_terms: string | null; notes: string | null; status: string;
  prepared_by?: string | null; submitted_at?: string | null; finance_by?: string | null; finance_at?: string | null; finance_ref?: string | null; finance_note?: string | null;
  history: { at: string; by: string; action: string; note: string }[]; }
interface PoDoc { po: PoHead; lines: PoLine[]; editable: boolean; total: number; signers: Record<string, string> | null; }
interface NewLine { sku: string; qty: any; cost: any; }

@Component({
  selector: 'app-po',
  imports: [FormsModule, RouterLink],
  template: `
  @if (error()) { <div class="err-box" style="margin-bottom:12px">{{ error() }}</div> }

  @if (mode() === 'list') {
    <div class="pagebar">
      <div class="seg">@for (f of filters; track f[0]) { <button type="button" [class.on]="filter() === f[0]" (click)="filter.set(f[0])">{{ f[1] }} <i>{{ countOf(f[0]) }}</i></button> }</div>
      <div class="btns"><input type="search" [(ngModel)]="q" placeholder="Search PO no. or supplier" style="width:220px">
        <button class="btn" (click)="load()">Refresh</button>
        @if (isAdmin()) { <button class="btn pri" (click)="newPo()">+ New PO</button> }</div>
    </div>
    @if (isAdmin() && loose()) { <div class="info-box">{{ loose() }} line(s) in the CW Purchase Orders log have no PO no. yet — set it in <a routerLink="/inventory">Inventory</a>.</div> }
    <div class="tbl">
      @if (!shown().length) { <div class="empty">{{ loading() ? 'Loading purchase orders…' : 'No purchase orders in this view.' }}</div> }
      @else {
        <table class="t"><tr><th>PO No.</th><th>Date</th><th>Supplier</th><th class="num">Items</th><th class="num">Total</th><th>Status</th><th></th></tr>
          @for (p of shown(); track p.no) {
            <tr class="go" (click)="open(p.no)"><td><b>{{ p.no }}</b></td><td>{{ nice(p.date) }}</td><td>{{ p.supplier || '—' }}</td><td class="num">{{ p.items }}</td>
              <td class="num"><b>{{ peso(p.total) }}</b></td>
              <td><span [class]="'chip ' + cls(p.status)">{{ p.status }}</span>@if (p.logStatus) { <small>CW log: {{ p.logStatus }}</small> }@if (p.financeRef) { <small>Ref. {{ p.financeRef }}</small> }</td>
              <td><button class="btn sm" (click)="$event.stopPropagation(); open(p.no)">Open</button></td></tr>
          }
        </table>
      }
    </div>
  }

  @if (mode() === 'new') {
    <div class="card">
      <h4>New purchase order</h4>
      <p class="sub">The items are added to the Central Warehouse Purchase Orders log as <b>Pending</b>. Mark them received in Inventory when the delivery arrives.</p>
      <datalist id="suppliers">@for (s of suppliers(); track s) { <option [value]="s"></option> }</datalist>
      <div class="grid3">
        <div><label>PO control no.</label><input [(ngModel)]="n.no"></div>
        <div><label>PO date</label><input type="date" [(ngModel)]="n.date"></div>
        <div><label>Supplier</label><input [(ngModel)]="n.supplier" list="suppliers"></div>
      </div>
      <div class="tbl" style="margin-top:14px"><table class="t"><tr><th>Product</th><th style="width:110px">Qty</th><th style="width:140px">Unit cost</th><th class="num">Total</th><th></th></tr>
        @for (l of n.lines; track $index) {
          <tr><td><select [(ngModel)]="l.sku" (ngModelChange)="pickSku(l)"><option value="">Choose product…</option>
              @for (p of products(); track p.sku) { <option [value]="p.sku">{{ p.name }} ({{ p.sku }})</option> }</select></td>
            <td><input type="number" min="0" step="any" [(ngModel)]="l.qty"></td><td><input type="number" min="0" step="0.01" [(ngModel)]="l.cost"></td>
            <td class="num">{{ peso((+l.qty || 0) * (+l.cost || 0)) }}</td>
            <td><button class="btn sm outline-red" (click)="n.lines.splice($index, 1)">×</button></td></tr>
        }
        <tr class="group"><td colspan="3" class="right">Total</td><td class="num">{{ peso(newTotal()) }}</td><td></td></tr>
      </table></div>
      <button class="btn sm" style="margin-top:8px" (click)="n.lines.push({ sku: '', qty: '', cost: '' })">+ Add item</button>
      <div class="btns end" style="margin-top:12px"><button class="btn" (click)="back()">Cancel</button><button class="btn pri" [disabled]="busy()" (click)="create()">Create PO</button></div>
    </div>
  }

  @if (mode() === 'doc' && doc(); as d) {
    <div class="pagebar">
      <button class="btn" (click)="back()">← All purchase orders</button>
      <div class="btns">
        <button class="btn" (click)="print(d)">Print / save as PDF</button>
        @if (d.editable) {
          <button class="btn" [disabled]="busy()" (click)="saveHead(d)">Save details</button>
          @if (d.po.status !== 'Not generated') { <button class="btn outline-red" (click)="act(d, 'cancel')">Cancel PO</button> }
          <button class="btn pri" [disabled]="busy()" (click)="submit(d)">{{ d.po.status === 'Returned by Finance' ? 'Re-send to Finance' : 'Submit to Finance' }}</button>
        }
        @if (isFinance() && d.po.status === 'Sent to Finance') { <button class="btn" (click)="act(d, 'receive')">Mark received</button> }
        @if (isFinance() && (d.po.status === 'Sent to Finance' || d.po.status === 'Received by Finance')) {
          <button class="btn outline-red" (click)="act(d, 'return')">Return for clarification</button><button class="btn pri" (click)="act(d, 'process')">Mark processed</button> }
      </div>
    </div>
    <div class="card">
      <div class="head"><div><h4>{{ d.po.po_no }}</h4><p class="sub">{{ d.po.supplier || 'No supplier' }} · {{ nice(d.po.po_date) }}{{ d.po.prepared_by ? ' · prepared by ' + d.po.prepared_by : '' }}</p></div>
        <div class="right"><span [class]="'chip ' + cls(d.po.status)">{{ d.po.status }}</span><div class="big">{{ peso(d.total) }}</div></div></div>
      @if (d.po.finance_note || d.po.finance_ref) { <div [class]="d.po.status === 'Returned by Finance' ? 'warn-box' : 'ok-box'"><b>Finance:</b> {{ d.po.finance_note }} {{ d.po.finance_ref ? '· Ref. ' + d.po.finance_ref : '' }}</div> }
      @if (d.editable) {
        <div class="grid3">
          <div><label>PO date</label><input type="date" [(ngModel)]="h.date"></div>
          <div class="span2"><label>Supplier company name</label><input [(ngModel)]="h.supplier"></div>
          <div class="span2"><label>Supplier address</label><input [(ngModel)]="h.address"></div>
          <div><label>Contact person / no.</label><input [(ngModel)]="h.contact"></div>
          <div><label>Due date</label><input type="date" [(ngModel)]="h.due"></div>
          <div><label>Expected delivery</label><input type="date" [(ngModel)]="h.expected"></div>
          <div><label>Receipt date</label><input type="date" [(ngModel)]="h.receipt"></div>
          <div><label>Payment terms</label><input [(ngModel)]="h.payment" placeholder="e.g. 30 days"></div>
          <div><label>Shipping terms</label><input [(ngModel)]="h.shipping"></div>
          <div class="span2"><label>Notes</label><input [(ngModel)]="h.notes"></div>
        </div>
        <p class="muted" style="font-size:12.5px">Items and unit costs come from the CW Purchase Orders log — change them in <a routerLink="/inventory">Inventory</a>.</p>
      } @else {
        <div class="grid3 ro">
          <div><small>Address</small>{{ d.po.address || '—' }}</div><div><small>Contact</small>{{ d.po.contact || '—' }}</div><div><small>Due date</small>{{ nice(d.po.due_date) || '—' }}</div>
          <div><small>Expected delivery</small>{{ nice(d.po.expected_date) || '—' }}</div><div><small>Payment terms</small>{{ d.po.payment_terms || '—' }}</div><div><small>Shipping terms</small>{{ d.po.shipping_terms || '—' }}</div>
          @if (d.po.notes) { <div class="span2"><small>Notes</small>{{ d.po.notes }}</div> }
        </div>
      }
      <div class="tbl" style="margin-top:12px"><table class="t"><tr><th>#</th><th>SKU</th><th>Item</th><th>UOM</th><th class="num">Qty</th><th class="num">Unit cost</th><th class="num">Total</th><th>CW status</th></tr>
        @for (l of d.lines; track $index) {
          <tr [class.short]="!(+l.cost > 0)"><td>{{ $index + 1 }}</td><td>{{ l.sku }}</td><td>{{ l.name }}@if (l.batch) { <small>Batch {{ l.batch }}</small> }</td><td>{{ l.uom }}</td>
            <td class="num">{{ l.qty }}</td><td class="num">{{ peso(l.cost) }}</td><td class="num">{{ peso(l.total) }}</td><td>{{ l.status }}</td></tr>
        } @empty { <tr><td colspan="8" class="empty">No active lines.</td></tr> }
        <tr class="group"><td colspan="6" class="right">Total</td><td class="num">{{ peso(d.total) }}</td><td></td></tr>
      </table></div>
    </div>
    <div class="card"><h4>History</h4>
      @for (x of hist(d); track $index) { <div class="hist"><b>{{ x.action }}</b><small>{{ x.at }} · {{ x.by }}</small>@if (x.note) { <p>{{ x.note }}</p> }</div> }
      @empty { <p class="muted" style="font-size:13px">Not submitted yet.</p> }
    </div>
  }`,
  styles: [`
    .head{display:flex;justify-content:space-between;gap:16px;flex-wrap:wrap}.big{font-size:22px;font-weight:600;margin-top:6px}
    .ro>div{font-size:13.5px}.ro small{display:block;color:var(--mute);font-size:12px}
    .hist{padding:7px 0;border-top:1px solid var(--line);font-size:13px}.hist small{display:block;color:var(--mute)}.hist p{margin:4px 0 0}
  `],
})
export class Po {
  private auth = inject(AuthService);
  private ui = inject(UiService);
  readonly mode = signal<'list' | 'new' | 'doc'>('list');
  readonly list = signal<PoRow[]>([]);
  readonly products = signal<Product[]>([]);
  readonly suppliers = signal<string[]>([]);
  readonly loose = signal(0);
  readonly nextNo = signal('');
  readonly doc = signal<PoDoc | null>(null);
  readonly loading = signal(false);
  readonly busy = signal(false);
  readonly error = signal('');
  readonly filter = signal('todo');
  q = '';
  n: { no: string; date: string; supplier: string; lines: NewLine[] } = { no: '', date: '', supplier: '', lines: [] };
  h: Record<string, string> = {};
  readonly isAdmin = computed(() => this.auth.type() === 'Admin');
  readonly isFinance = computed(() => this.auth.type() === 'Finance');
  readonly nice = niceDate; readonly peso = peso; readonly cls = statusClass;
  readonly filters: [string, string][] = [['todo', 'To do'], ['finance', 'With Finance'], ['done', 'Processed'], ['all', 'All']];

  constructor() { this.load(); }

  private match(p: PoRow, f: string): boolean {
    if (f === 'todo') return this.isAdmin() ? ['Not generated', 'Draft', 'Returned by Finance'].includes(p.status) : ['Sent to Finance', 'Received by Finance'].includes(p.status);
    if (f === 'finance') return ['Sent to Finance', 'Received by Finance'].includes(p.status);
    if (f === 'done') return p.status === 'Processed by Finance';
    return true;
  }
  countOf(f: string): number { return this.list().filter((p) => this.match(p, f)).length; }
  shown(): PoRow[] {
    const q = this.q.trim().toLowerCase();
    return this.list().filter((p) => this.match(p, this.filter()) && (!q || [p.no, p.supplier, p.financeRef].join(' ').toLowerCase().includes(q)));
  }
  hist(d: PoDoc) { return (d.po.history ?? []).slice().reverse(); }

  async load(): Promise<void> {
    this.loading.set(true); this.error.set('');
    try {
      const r = await rpc<{ list: PoRow[]; loose?: number; nextNo?: string; products?: Product[]; suppliers?: string[] }>('po_list');
      this.list.set(r.list ?? []); this.loose.set(r.loose ?? 0); this.nextNo.set(r.nextNo ?? '');
      this.products.set(r.products ?? []); this.suppliers.set(r.suppliers ?? []);
    } catch (e) { this.error.set(errMsg(e)); }
    finally { this.loading.set(false); }
  }
  back(): void { this.mode.set('list'); this.doc.set(null); this.error.set(''); this.load(); }

  newPo(): void {
    this.n = { no: this.nextNo(), date: todayIso(), supplier: '', lines: [{ sku: '', qty: '', cost: '' }, { sku: '', qty: '', cost: '' }, { sku: '', qty: '', cost: '' }] };
    this.error.set(''); this.mode.set('new');
  }
  pickSku(l: NewLine): void {
    const p = this.products().find((x) => x.sku === l.sku);
    if (p && (l.cost === '' || l.cost === null)) l.cost = Number(p.cost) > 0 ? Number(p.cost) : '';
    if (p?.supplier && !this.n.supplier) this.n.supplier = p.supplier;
  }
  newTotal(): number { return this.n.lines.reduce((a, l) => a + (Number(l.qty) || 0) * (Number(l.cost) || 0), 0); }

  async create(): Promise<void> {
    this.busy.set(true); this.error.set('');
    try {
      const r = await rpc<{ msg: string; no: string }>('po_create', { p: { no: this.n.no, date: this.n.date, supplier: this.n.supplier,
        lines: this.n.lines.filter((l) => l.sku).map((l) => ({ sku: l.sku, qty: String(l.qty ?? ''), cost: String(l.cost ?? '') })) } });
      this.ui.notify(r.msg);
      await this.open(r.no);
    } catch (e) { this.error.set(errMsg(e)); }
    finally { this.busy.set(false); }
  }

  async open(no: string): Promise<void> {
    this.error.set('');
    try {
      const d = await rpc<PoDoc>('po_doc', { p_no: no });
      const p = d.po;
      this.h = { date: p.po_date ?? '', supplier: p.supplier ?? '', address: p.address ?? '', contact: p.contact ?? '', due: p.due_date ?? '',
        receipt: p.receipt_date ?? '', expected: p.expected_date ?? '', payment: p.payment_terms ?? '', shipping: p.shipping_terms ?? '', notes: p.notes ?? '' };
      this.doc.set(d); this.mode.set('doc');
    } catch (e) { this.error.set(errMsg(e)); }
  }

  async saveHead(d: PoDoc): Promise<void> {
    this.busy.set(true); this.error.set('');
    try { const r = await rpc<{ msg: string }>('po_save', { p_no: d.po.po_no, p: this.h }); this.ui.notify(r.msg); await this.open(d.po.po_no); }
    catch (e) { this.error.set(errMsg(e)); }
    finally { this.busy.set(false); }
  }

  async submit(d: PoDoc): Promise<void> {
    const note = await this.ui.prompt({ title: 'Submit to Finance', message: `Send ${d.po.po_no} (${peso(d.total)}) to Finance? The details above are saved with it. Optional note:`, ok: 'Submit' });
    if (note === null) return;
    this.busy.set(true); this.error.set('');
    try { const r = await rpc<{ msg: string }>('po_submit', { p_no: d.po.po_no, p: { ...this.h, note } }); this.ui.notify(r.msg); await this.open(d.po.po_no); }
    catch (e) { this.error.set(errMsg(e)); }
    finally { this.busy.set(false); }
  }

  async act(d: PoDoc, action: 'cancel' | 'receive' | 'process' | 'return'): Promise<void> {
    let note = '', ref = '';
    if (action === 'cancel') {
      if (!(await this.ui.confirm({ title: 'Cancel PO', message: `Cancel ${d.po.po_no}?`, ok: 'Cancel PO', tone: 'danger' }))) return;
    } else if (action === 'receive') {
      if (!(await this.ui.confirm({ title: 'Mark received', message: `Mark ${d.po.po_no} as received by Finance?`, ok: 'Mark received' }))) return;
    } else if (action === 'process') {
      const v = await this.ui.prompt({ title: 'Mark processed', message: 'Voucher / reference no.:', ok: 'Mark processed', required: true });
      if (v === null) return; ref = v;
    } else {
      const v = await this.ui.prompt({ title: 'Return for clarification', message: 'What needs clarification?', ok: 'Return', tone: 'danger', required: true });
      if (v === null) return; note = v;
    }
    this.busy.set(true); this.error.set('');
    try { const r = await rpc<{ msg: string }>('po_action', { p_no: d.po.po_no, p_action: action, p_note: note, p_ref: ref }); this.ui.notify(r.msg); await this.open(d.po.po_no); }
    catch (e) { this.error.set(errMsg(e)); }
    finally { this.busy.set(false); }
  }

  print(d: PoDoc): void {
    const h = escapeHtml, p = d.po, sg = d.signers ?? {};
    const live = d.editable ? { ...p, po_date: this.h['date'] || p.po_date, supplier: this.h['supplier'] || p.supplier, address: this.h['address'] || p.address,
      contact: this.h['contact'] || p.contact, due_date: this.h['due'] || p.due_date, expected_date: this.h['expected'] || p.expected_date,
      payment_terms: this.h['payment'] || p.payment_terms, shipping_terms: this.h['shipping'] || p.shipping_terms, notes: this.h['notes'] || p.notes } : p;
    const sig = (k: string, role: string) => { const [n, t] = String(sg[k] ?? '').split('|').map((x) => x.trim());
      return `<td><b>${role}:</b><span class="nm">${h(n ?? '')}</span><span class="ro">${h(t ?? '')}</span></td>`; };
    const contact = String(sg['contact'] ?? '').split('|').map((x) => x.trim()).filter((x) => x);
    const rowsHtml = d.lines.map((l, i) => `<tr><td>${i + 1}</td><td>${h(l.sku)}</td><td>${h(l.name)}</td><td>${h(l.uom ?? '')}</td><td class="n">${h(l.qty)}</td><td class="n">${money(l.cost)}</td><td class="n">${money(l.total)}</td></tr>`).join('');
    const css = `<style>body{font-family:Arial,sans-serif;color:#111;font-size:12.5px;max-width:800px;margin:18px auto}
      .brand{text-align:center;margin-bottom:10px}.brand b{display:block;font-size:24px;color:#E1262D}.brand span{display:block;font-weight:700;color:#1C3F94;letter-spacing:1.5px}.brand i{font-size:11px;color:#777}
      h2{text-align:center;font-size:17px;margin:6px 0 14px}.f{display:grid;grid-template-columns:140px 1fr 130px 1fr;gap:5px 10px;margin-bottom:14px}.f span{border-bottom:1px solid #111;min-height:16px}
      table{width:100%;border-collapse:collapse}.it th,.it td{border:1px solid #111;padding:4px 6px}.it th{background:#1E3A8A;color:#fff}.n{text-align:right;white-space:nowrap}
      .tot td{font-weight:700;font-size:14px;background:#FFF200}.sg{margin-top:26px}.sg td{border:1px solid #111;vertical-align:top;height:80px;width:33%;padding:4px 6px}
      .nm{display:block;text-align:center;margin-top:22px;font-weight:700}.ro{display:block;text-align:center;border-top:1px solid #111;margin-top:3px}.ct{margin-top:16px;font-size:12px}</style>`;
    const html = `${printBrand()}<h2>PURCHASE ORDER</h2>
      <div class="f"><b>PO No.:</b><span>${h(p.po_no)}</span><b>PO Date:</b><span>${h(niceDate(live.po_date))}</span>
        <b>Supplier:</b><span>${h(live.supplier ?? '')}</span><b>Due date:</b><span>${h(niceDate(live.due_date))}</span>
        <b>Address:</b><span>${h(live.address ?? '')}</span><b>Expected delivery:</b><span>${h(niceDate(live.expected_date))}</span>
        <b>Contact:</b><span>${h(live.contact ?? '')}</span><b>Payment terms:</b><span>${h(live.payment_terms ?? '')}</span>
        <b>Ship to:</b><span>Central Warehouse</span><b>Shipping terms:</b><span>${h(live.shipping_terms ?? '')}</span></div>
      <table class="it"><tr><th>#</th><th>SKU</th><th>Item description</th><th>UOM</th><th>Qty</th><th>Unit cost</th><th>Amount</th></tr>${rowsHtml}
        <tr class="tot"><td colspan="6" class="n">TOTAL</td><td class="n">₱${money(d.total)}</td></tr></table>
      ${live.notes ? `<p><b>Notes:</b> ${h(live.notes)}</p>` : ''}
      <table class="sg"><tr>${sig('prepared', 'Prepared by')}${sig('reviewed', 'Reviewed by')}${sig('approved', 'Approved by')}</tr></table>
      ${contact.length ? `<p class="ct">For inquiries: ${contact.map((x) => h(x)).join(' · ')}</p>` : ''}
      ${p.finance_ref ? `<p class="ct">Processed by Finance — reference ${h(p.finance_ref)} · ${h(niceStamp(p.finance_at ?? null))}</p>` : ''}`;
    printHtml(`<!doctype html><html><head><meta charset="utf-8"><title>${h(p.po_no)}</title>${css}</head><body>${html}</body></html>`);
  }
}
