import { Component, computed, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { errMsg, rpc } from '../../core/supabase';
import { addDays, downloadText, itemKey, niceDate, shortBranch, statusClass, toCsv, todayIso } from '../../shared/format';

interface OPrs { no: string; date: string; branch: string; hq: string; status: string; approved: string | null; }
type OLine = [number, string, string | null, number | null, number];
interface Row { prs: OPrs; desc: string; unit: string | null; requested: number | null; delivered: number; pending: number; }
interface Sum { key: string; desc: string; unit: string | null; requested: number; delivered: number; pending: number; prsCount: number; branches: string[]; }

/** Items ordered by the branches on approved PRS — what is still to be delivered (HQ / Admin). */
@Component({
  selector: 'app-ordered',
  imports: [FormsModule],
  template: `
  <div class="pagebar">
    <div class="seg"><button type="button" [class.on]="view() === 'sum'" (click)="view.set('sum')">By item</button>
      <button type="button" [class.on]="view() === 'prs'" (click)="view.set('prs')">By PRS</button></div>
    <div class="btns">
      <label style="margin:0">PRS from</label><input type="date" [(ngModel)]="from" style="width:auto">
      <label style="margin:0">to</label><input type="date" [(ngModel)]="to" style="width:auto">
      <button class="btn" (click)="load()">Load</button>
      <button class="btn" [disabled]="!rows().length" (click)="csv()">Download CSV</button>
    </div>
  </div>
  <div class="tools">
    <input type="search" [(ngModel)]="q" placeholder="Search item, PRS or branch">
    <select [(ngModel)]="hq"><option value="">All HQ</option>@for (h of hqs(); track h) { <option [value]="h">{{ h }}</option> }</select>
    <label style="margin:0;display:flex;gap:6px;align-items:center;font-weight:400"><input type="checkbox" [(ngModel)]="pendingOnly" style="width:auto"> Pending only</label>
  </div>
  @if (error()) { <div class="err-box" style="margin-bottom:12px">{{ error() }}</div> }
  <div class="kpis">
    <div class="kpi navy"><small>Approved PRS</small><b>{{ prsShown() }}</b><i>{{ nice(from) }} – {{ nice(to) }}</i></div>
    <div class="kpi"><small>Item lines</small><b>{{ filtered().length }}</b><i>in this view</i></div>
    <div class="kpi"><small>Fully delivered</small><b>{{ doneCount() }}</b><i>lines</i></div>
    <div class="kpi warn"><small>Still pending</small><b>{{ pendingCount() }}</b><i>lines</i></div>
  </div>
  <div class="tbl">
    @if (loading()) { <div class="empty">Loading…</div> }
    @else if (view() === 'sum') {
      @if (!summary().length) { <div class="empty">No ordered items match.</div> }
      @else {
        <table class="t"><tr><th>Item</th><th>Unit</th><th class="num">Ordered</th><th class="num">Delivered</th><th class="num">Pending</th><th class="num">PRS</th><th>Branches</th></tr>
          @for (s of summary(); track s.key + s.unit) {
            <tr [class.short]="s.pending > 0"><td><b>{{ s.desc }}</b></td><td>{{ s.unit }}</td><td class="num">{{ s.requested }}</td><td class="num">{{ s.delivered }}</td>
              <td class="num"><b>{{ s.pending }}</b></td><td class="num">{{ s.prsCount }}</td><td><small>{{ s.branches.join(', ') }}</small></td></tr>
          }
        </table>
      }
    } @else {
      @if (!filtered().length) { <div class="empty">No ordered items match.</div> }
      @else {
        <table class="t"><tr><th>PRS No.</th><th>PRS date</th><th>Branch</th><th>HQ</th><th>Status</th><th>Item</th><th>Unit</th><th class="num">Ordered</th><th class="num">Delivered</th><th class="num">Pending</th></tr>
          @for (r of filtered(); track $index) {
            <tr [class.short]="r.pending > 0"><td><b>{{ r.prs.no }}</b></td><td>{{ nice(r.prs.date) }}</td><td>{{ short(r.prs.branch) }}</td><td>{{ r.prs.hq }}</td>
              <td><span [class]="'chip ' + cls(r.prs.status)">{{ r.prs.status }}</span></td><td>{{ r.desc }}</td><td>{{ r.unit }}</td>
              <td class="num">{{ r.requested ?? '—' }}</td><td class="num">{{ r.delivered }}</td><td class="num"><b>{{ r.pending }}</b></td></tr>
          }
        </table>
      }
    }
  </div>`,
})
export class Ordered {
  readonly view = signal<'sum' | 'prs'>('sum');
  readonly rows = signal<Row[]>([]);
  readonly loading = signal(false);
  readonly error = signal('');
  from = addDays(todayIso(), -60);
  to = todayIso();
  q = ''; hq = ''; pendingOnly = false;
  readonly nice = niceDate; readonly short = shortBranch; readonly cls = statusClass;
  readonly hqs = computed(() => [...new Set(this.rows().map((r) => r.prs.hq))].sort());

  constructor() { this.load(); }

  async load(): Promise<void> {
    this.loading.set(true); this.error.set('');
    try {
      const r = await rpc<{ prs: OPrs[]; lines: OLine[] }>('ordered_items', { p_from: this.from || null, p_to: this.to || null });
      this.rows.set((r.lines ?? []).map(([ix, desc, unit, req, del]) => {
        const requested = req === null ? null : Number(req), delivered = Number(del) || 0;
        return { prs: r.prs[ix], desc, unit, requested, delivered, pending: requested === null ? 0 : Math.max(0, requested - delivered) };
      }));
    } catch (e) { this.error.set(errMsg(e)); }
    finally { this.loading.set(false); }
  }

  filtered(): Row[] {
    const q = this.q.trim().toLowerCase();
    return this.rows().filter((r) => (!this.hq || r.prs.hq === this.hq) && (!this.pendingOnly || r.pending > 0)
      && (!q || [r.desc, r.prs.no, r.prs.branch].join(' ').toLowerCase().includes(q)));
  }
  summary(): Sum[] {
    const m = new Map<string, Sum & { prsSet: Set<string> }>();
    for (const r of this.filtered()) {
      const k = itemKey(r.desc) + '|' + (r.unit ?? '').toLowerCase();
      let s = m.get(k);
      if (!s) { s = { key: k, desc: r.desc, unit: r.unit, requested: 0, delivered: 0, pending: 0, prsCount: 0, branches: [], prsSet: new Set() }; m.set(k, s); }
      s.requested += r.requested ?? 0; s.delivered += r.delivered; s.pending += r.pending;
      s.prsSet.add(r.prs.no);
      const b = shortBranch(r.prs.branch);
      if (!s.branches.includes(b)) s.branches.push(b);
    }
    return [...m.values()].map((s) => ({ ...s, prsCount: s.prsSet.size })).sort((a, b) => b.pending - a.pending || a.desc.localeCompare(b.desc));
  }
  prsShown(): number { return new Set(this.filtered().map((r) => r.prs.no)).size; }
  doneCount(): number { return this.filtered().filter((r) => r.requested !== null && r.pending === 0).length; }
  pendingCount(): number { return this.filtered().filter((r) => r.pending > 0).length; }

  csv(): void {
    const out: unknown[][] = [['PRS No.', 'PRS date', 'Branch', 'HQ', 'PRS status', 'Item', 'Unit', 'Ordered', 'Delivered', 'Pending']];
    for (const r of this.filtered()) out.push([r.prs.no, r.prs.date, r.prs.branch, r.prs.hq, r.prs.status, r.desc, r.unit, r.requested ?? '', r.delivered, r.pending]);
    downloadText(`ordered-items-${this.from || 'all'}-to-${this.to || 'all'}.csv`, toCsv(out));
  }
}
