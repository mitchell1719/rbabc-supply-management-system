import { Component, computed, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { errMsg, rpc } from '../../core/supabase';
import { downloadText, num, peso, toCsv } from '../../shared/format';

type Order = [number, string, string, number, number, number];
type Dist = [number, string, string, string, string, number, number, number];
interface Agg { name: string; qty: number; total: number; n: number; }

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function group<T>(list: T[], key: (x: T) => string, qty: (x: T) => number, total: (x: T) => number): Agg[] {
  const m = new Map<string, Agg>();
  for (const x of list) {
    const k = key(x);
    const a = m.get(k) ?? { name: k, qty: 0, total: 0, n: 0 };
    a.qty += Number(qty(x)) || 0; a.total += Number(total(x)) || 0; a.n++;
    m.set(k, a);
  }
  return [...m.values()].sort((a, b) => b.total - a.total || b.qty - a.qty);
}

/** Admin report: CW purchases (received POs) and distribution to the branches (delivery notes). */
@Component({
  selector: 'app-report',
  imports: [FormsModule],
  template: `
  <div class="pagebar">
    <div class="btns"><label style="margin:0">Year</label>
      <select [(ngModel)]="year" style="width:auto"><option [ngValue]="0">All years</option>@for (y of years(); track y) { <option [ngValue]="y">{{ y }}</option> }</select>
      <label style="margin:0">Region</label>
      <select [(ngModel)]="region" style="width:auto"><option value="">All regions</option>@for (r of regions(); track r) { <option [value]="r">{{ r }}</option> }</select></div>
    <div class="btns"><small class="muted">{{ built() ? 'Data as of ' + built() : '' }}</small><button class="btn" (click)="load()">Refresh</button>
      <button class="btn" (click)="print()">Print</button></div>
  </div>
  @if (error()) { <div class="err-box" style="margin-bottom:12px">{{ error() }}</div> }
  @if (loading()) { <div class="empty">Building the report…</div> }
  @else {
    <div class="kpis">
      <div class="kpi navy"><small>Purchased (received POs)</small><b>{{ peso(sumT(orders())) }}</b><i>{{ orders().length }} PO line(s)</i></div>
      <div class="kpi"><small>Suppliers</small><b>{{ bySupplier().length }}</b><i>{{ year || 'all years' }}</i></div>
      <div class="kpi"><small>Distributed to branches</small><b>{{ peso(sumD(dist())) }}</b><i>{{ dist().length }} delivered line(s)</i></div>
      <div class="kpi" [class.warn]="noCost() > 0"><small>Delivered lines without a CW cost</small><b>{{ noCost() }}</b><i>not included in the amounts</i></div>
    </div>

    <div class="card">
      <h4>Distribution by month</h4>
      <p class="sub">Value of items delivered to the branches (CW product cost × quantity received).</p>
      <div class="bars">
        @for (m of byMonth(); track m.name) {
          <div class="bar"><div class="fill" [style.height.%]="pctOf(m.total, maxMonth())" [title]="peso(m.total)"></div><small>{{ m.name }}</small></div>
        } @empty { <p class="muted">No deliveries.</p> }
      </div>
    </div>

    <div class="grid2" style="margin-top:14px">
      <div class="card"><div class="hd"><h4>Purchases by supplier</h4><button class="btn sm" (click)="csv('suppliers', bySupplier())">CSV</button></div>
        <table class="t">@for (a of bySupplier(); track a.name) { <tr><td>{{ a.name }}<div class="mini" [style.width.%]="pctOf(a.total, bySupplier()[0].total)"></div></td><td class="num">{{ peso(a.total) }}</td></tr> }
          @empty { <tr><td class="muted">No received purchase orders.</td></tr> }</table></div>
      <div class="card"><div class="hd"><h4>Top items purchased</h4><button class="btn sm" (click)="csv('items-purchased', itemsBought())">CSV</button></div>
        <table class="t">@for (a of itemsBought().slice(0, 15); track a.name) { <tr><td>{{ a.name }}<small>{{ fmt(a.qty) }} unit(s)</small></td><td class="num">{{ peso(a.total) }}</td></tr> }
          @empty { <tr><td class="muted">No data.</td></tr> }</table></div>
      <div class="card"><div class="hd"><h4>Distribution by region</h4><button class="btn sm" (click)="csv('regions', byRegion())">CSV</button></div>
        <table class="t">@for (a of byRegion(); track a.name) { <tr><td>{{ a.name }}<div class="mini" [style.width.%]="pctOf(a.total, byRegion()[0].total)"></div></td><td class="num">{{ peso(a.total) }}</td></tr> }
          @empty { <tr><td class="muted">No data.</td></tr> }</table></div>
      <div class="card"><div class="hd"><h4>Top branches</h4><button class="btn sm" (click)="csv('branches', byBranch())">CSV</button></div>
        <table class="t">@for (a of byBranch().slice(0, 15); track a.name) { <tr><td>{{ a.name }}<small>{{ a.n }} line(s)</small></td><td class="num">{{ peso(a.total) }}</td></tr> }
          @empty { <tr><td class="muted">No data.</td></tr> }</table></div>
      <div class="card span2"><div class="hd"><h4>Items distributed</h4><button class="btn sm" (click)="csv('items-distributed', itemsDist())">CSV</button></div>
        <table class="t"><tr><th>Item</th><th class="num">Quantity</th><th class="num">Value</th></tr>
          @for (a of itemsDist().slice(0, 30); track a.name) { <tr><td>{{ a.name }}</td><td class="num">{{ fmt(a.qty) }}</td><td class="num">{{ peso(a.total) }}</td></tr> }
          @empty { <tr><td class="muted" colspan="3">No data.</td></tr> }</table></div>
    </div>
  }`,
  styles: [`
    .bars{display:flex;align-items:flex-end;gap:6px;height:180px;padding-top:10px;overflow-x:auto}
    .bar{flex:1;min-width:34px;display:flex;flex-direction:column;justify-content:flex-end;align-items:center;height:100%}
    .bar .fill{width:70%;background:var(--pri);border-radius:6px 6px 0 0;min-height:2px}.bar small{font-size:11px;color:var(--mute);margin-top:4px;white-space:nowrap}
    .hd{display:flex;justify-content:space-between;align-items:center;margin-bottom:8px}
    .mini{height:4px;background:var(--pri-soft);border-radius:4px;margin-top:4px}
    .span2{grid-column:span 2}@media (max-width:520px){.span2{grid-column:auto}}
  `],
})
export class Report {
  readonly allOrders = signal<Order[]>([]);
  readonly allDist = signal<Dist[]>([]);
  readonly built = signal('');
  readonly loading = signal(false);
  readonly error = signal('');
  year = new Date().getFullYear();
  region = '';
  readonly peso = peso;

  readonly years = computed(() => [...new Set([...this.allOrders().map((o) => o[0]), ...this.allDist().map((d) => d[0])])].filter((y) => y).sort((a, b) => b - a));
  readonly regions = computed(() => [...new Set(this.allDist().map((d) => d[1]).filter((r) => r))].sort());

  constructor() { this.load(); }

  async load(): Promise<void> {
    this.loading.set(true); this.error.set('');
    try {
      const r = await rpc<{ built: string; orders: Order[]; dist: Dist[] }>('report_data');
      this.allOrders.set(r.orders ?? []); this.allDist.set(r.dist ?? []); this.built.set(r.built);
      if (this.year && !this.years().includes(this.year)) this.year = this.years()[0] ?? 0;
    } catch (e) { this.error.set(errMsg(e)); }
    finally { this.loading.set(false); }
  }

  orders(): Order[] { return this.allOrders().filter((o) => !this.year || o[0] === this.year); }
  dist(): Dist[] { return this.allDist().filter((d) => (!this.year || d[0] === this.year) && (!this.region || d[1] === this.region)); }
  sumT(l: Order[]): number { return l.reduce((a, o) => a + Number(o[5]), 0); }
  sumD(l: Dist[]): number { return l.reduce((a, d) => a + Number(d[6]), 0); }
  noCost(): number { return this.dist().filter((d) => d[7]).length; }
  bySupplier(): Agg[] { return group(this.orders(), (o) => o[1], (o) => o[3], (o) => o[5]); }
  itemsBought(): Agg[] { return group(this.orders(), (o) => o[2], (o) => o[3], (o) => o[5]); }
  byRegion(): Agg[] { return group(this.dist(), (d) => d[1] || '—', (d) => d[5], (d) => d[6]); }
  byBranch(): Agg[] { return group(this.dist(), (d) => d[3], (d) => d[5], (d) => d[6]); }
  itemsDist(): Agg[] { return group(this.dist(), (d) => d[4], (d) => d[5], (d) => d[6]); }
  byMonth(): Agg[] {
    const g = group(this.dist(), (d) => d[2], (d) => d[5], (d) => d[6]).sort((a, b) => a.name.localeCompare(b.name));
    return g.map((a) => ({ ...a, name: MONTHS[Number(a.name.slice(5)) - 1] + (this.year ? '' : ' ' + a.name.slice(2, 4)) }));
  }
  maxMonth(): number { return Math.max(0, ...this.byMonth().map((m) => m.total)); }
  pctOf(v: number, max: number): number { return max > 0 ? Math.max(1, (v / max) * 100) : 0; }
  fmt(v: number): string { return num(v, 2).replace(/\.00$/, ''); }

  csv(name: string, list: Agg[]): void {
    downloadText(`report-${name}-${this.year || 'all'}.csv`, toCsv([['Name', 'Quantity', 'Amount', 'Lines'], ...list.map((a) => [a.name, a.qty, a.total.toFixed(2), a.n])]));
  }
  print(): void { window.print(); }
}
