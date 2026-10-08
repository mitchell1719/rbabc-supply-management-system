import { DecimalPipe } from '@angular/common';
import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { AuthService } from '../../core/auth.service';
import { BranchRow, scopeBranches } from '../../core/scope';
import { errMsg, rows, rpc, sb } from '../../core/supabase';
import { UiService, escapeHtml } from '../../core/ui.service';
import { addDays, downloadText, niceDate, niceStamp, num, printHtml, shortBranch, toCsv, todayIso } from '../../shared/format';

interface Item { id: number; name: string; category: string; description: string | null; unit: string | null; reorder_point: number | null; sku: string | null; }
interface Entry { id: number; branch_id: string; entry_date: string; item_id: number; batch_no: string | null; source: string | null; received: number; consumed: number;
  remarks: string | null; expiry: string | null; kind: 'DAILY' | 'BEGIN' | 'DN'; logged_by: string | null; }
interface Bal { branch_id: string; item_id: number; balance: number; last_entry: string; }
interface Lock { locked: boolean; by?: string; at?: string; all?: boolean; }

@Component({
  selector: 'app-stockcard',
  imports: [FormsModule, DecimalPipe],
  template: `
  <div class="pagebar">
    <div class="btns">
      @if (!isBranch()) {
        <select [(ngModel)]="branchId" (change)="pickBranch()" style="width:auto;min-width:220px"><option value="">All my branches ({{ branches().length }})</option>
          @for (b of branches(); track b.id) { <option [value]="b.id">{{ short(b.name) }} · {{ b.hq_code }}</option> }</select>
      }
      <div class="seg">@for (s of subs(); track s[0]) { <button type="button" [class.on]="sub() === s[0]" (click)="go(s[0])">{{ s[1] }}</button> }</div>
    </div>
    <div class="btns"><button class="btn" (click)="reload()">Refresh</button></div>
  </div>
  @if (error()) { <div class="err-box">{{ error() }}</div> }
  @if (branchId && lock().locked) {
    <div class="warn-box"><b>Editing is locked</b>{{ lock().by ? ' by ' + lock().by : '' }}{{ lock().all ? ' (all branches)' : '' }}.
      {{ isBranch() ? 'You can still enter today, but past days and beginning balances cannot be changed. Ask your RNS to unlock it for corrections.' : 'The branch can enter today only.' }}</div>
  }

  @if (panel(); as pn) {
    <div class="card" style="margin-bottom:14px">
      @if (pn.kind === 'begin') {
        <h4>Beginning balance — {{ pn.item.name }}</h4><p class="sub">The actual count on hand when the stock card started.</p>
        <div class="grid3">
          <div><label>Beginning balance {{ pn.item.unit ? '(' + pn.item.unit + ')' : '' }}</label><input type="number" min="0" step="any" [(ngModel)]="pf.qty"></div>
          <div><label>Date of the count</label><input type="date" [(ngModel)]="pf.date" [max]="today"></div>
          <div><label>Batch No.</label><input [(ngModel)]="pf.batch"></div>
          <div><label>Expiry date</label><input type="date" [(ngModel)]="pf.expiry"></div>
          <div class="span2"><label>Remarks</label><input [(ngModel)]="pf.remarks"></div>
        </div>
        <div class="btns end" style="margin-top:10px"><button class="btn" (click)="panel.set(null)">Cancel</button><button class="btn pri" (click)="saveBegin()">Save beginning balance</button></div>
      } @else {
        <h4>Add an item to the stock card list</h4><p class="sub">For supplies not in the list. It is added for every branch.</p>
        <div class="grid3">
          <div><label>Item name</label><input [(ngModel)]="pf.name"></div>
          <div><label>Category</label><select [(ngModel)]="pf.category"><option>Supplies</option><option>Vaccine</option><option>Meds</option></select></div>
          <div><label>Unit</label><input [(ngModel)]="pf.unit"></div>
          <div class="span2"><label>Description</label><input [(ngModel)]="pf.desc"></div>
          @if (auth.is('Admin')) { <div><label>Reorder point</label><input type="number" min="0" [(ngModel)]="pf.reorder"></div> }
        </div>
        <div class="btns end" style="margin-top:10px"><button class="btn" (click)="panel.set(null)">Cancel</button><button class="btn pri" (click)="saveItem()">Add item</button></div>
      }
    </div>
  }

  @switch (sub()) {
    @case ('daily') {
      <div class="tools"><label class="inl">Date <input type="date" [(ngModel)]="date" [max]="today" [min]="lock().locked ? today : minDate" [disabled]="lock().locked" (change)="loadDay()"></label>
        <button class="btn sm" (click)="openItem()">+ Add item not in the list</button></div>
      <p class="muted" style="font-size:12.5px">Enter what came <b>in</b> (Received, batch no. and from where) and what went <b>out</b> (Consumed). Deliveries from your HQ are added by themselves once your receiving report is validated — do not type them again.</p>
      <div class="tbl"><table class="t">
        <tr><th>Item</th><th class="num">Balance before</th><th>Batch No.</th><th>Ordered / borrowed from</th><th class="num">Received</th><th class="num">Consumed</th><th class="num">Balance</th><th>Remarks</th></tr>
        @for (it of items(); track it.id) {
          @if ($index === 0 || items()[$index - 1].category !== it.category) { <tr class="group"><td colspan="8">{{ it.category }}</td></tr> }
          <tr [class.neg]="after(it) < 0"><td><b>{{ it.name }}</b><small>{{ [it.description, it.unit].filter(ok).join(' · ') }}</small>
              @if (dnNote(it.id)) { <small style="color:var(--ok)">{{ dnNote(it.id) }}</small> }</td>
            <td class="num">{{ n(before(it.id)) }}</td>
            <td style="width:120px"><input [(ngModel)]="day[it.id].batch"></td>
            <td><input [(ngModel)]="day[it.id].from"></td>
            <td style="width:90px"><input type="number" min="0" step="any" [(ngModel)]="day[it.id].received"></td>
            <td style="width:90px"><input type="number" min="0" step="any" [(ngModel)]="day[it.id].consumed"></td>
            <td class="num"><b [style.color]="after(it) < 0 ? 'var(--red-dark)' : ''">{{ n(after(it)) }}</b></td>
            <td><input [(ngModel)]="day[it.id].remarks"></td></tr>
        }
      </table></div>
      <div class="btns end" style="margin-top:12px"><button class="btn pri" [disabled]="busy()" (click)="saveDay()">Save {{ nice(date) }}</button></div>
    }
    @case ('bal') {
      <div class="tools">
        @if (isBranch()) { <button class="btn sm" (click)="openItem()">+ Add item not in the list</button> }
        @if (canLock() && !lock().all) { <button class="btn sm" (click)="setLock(branchId, !lock().locked)">{{ lock().locked ? 'Unlock editing' : 'Lock editing' }}</button> }
      </div>
      <div class="tbl"><table class="t"><tr><th>Item</th><th>Category</th><th>Unit</th><th class="num">Beginning balance</th><th class="num">Balance</th><th class="num">Reorder point</th><th>Status</th><th>Last entry</th><th></th></tr>
        @for (it of items(); track it.id) {
          <tr><td><b>{{ it.name }}</b></td><td>{{ it.category }}</td><td>{{ it.unit }}</td>
            <td class="num">@if (begin(it.id); as b) { <b>{{ n(b.received) }}</b><small>{{ nice(b.entry_date) }}{{ b.batch_no ? ' · ' + b.batch_no : '' }}</small> } @else { <span class="muted">not set</span> }
              @if (isBranch() && !lock().locked) { <button class="btn sm" (click)="openBegin(it)">{{ begin(it.id) ? 'Edit' : 'Set' }}</button> }</td>
            <td class="num"><b>{{ bal(it.id) ? n(bal(it.id)!.balance) : '—' }}</b></td><td class="num">{{ it.reorder_point ?? '—' }}</td>
            <td><span [class]="'chip ' + statusCls(it)">{{ status(it) }}</span></td><td>{{ nice(bal(it.id)?.last_entry) || '—' }}</td>
            <td><button class="btn sm" (click)="cardItem = it.id; go('card')">Stock card</button></td></tr>
        }
      </table></div>
    }
    @case ('card') {
      <div class="tools"><select [(ngModel)]="cardItem" (change)="loadCard()" style="width:auto">@for (it of items(); track it.id) { <option [ngValue]="it.id">{{ it.name }}</option> }</select>
        <button class="btn sm" (click)="printCard()">Print / Save PDF</button></div>
      <div class="tbl"><table class="t"><tr><th>Date</th><th>Batch No.</th><th>Expiry</th><th>Ordered / borrowed from</th><th class="num">Received</th><th class="num">Consumed</th><th class="num">Balance</th><th>Remarks</th></tr>
        @for (e of card(); track e.id) {
          <tr [class.beg]="e.kind === 'BEGIN'" [class.dn]="e.kind === 'DN'"><td>{{ nice(e.entry_date) }}</td><td>{{ e.batch_no }}</td><td>{{ nice(e.expiry) }}</td><td>{{ e.source }}</td>
            <td class="num">{{ e.received ? n(e.received) : '' }}</td><td class="num">{{ e.consumed ? n(e.consumed) : '' }}</td><td class="num"><b>{{ n(e.run) }}</b></td><td>{{ e.remarks }}</td></tr>
        } @empty { <tr><td colspan="8" class="empty">No entries for this item yet.</td></tr> }
      </table></div>
    }
    @case ('overview') {
      <div class="tools"><select [(ngModel)]="cat" style="width:auto"><option value="all">All categories</option>@for (c of cats(); track c) { <option>{{ c }}</option> }</select>
        @if (auth.is('Admin')) { <button class="btn sm" (click)="openItem()">+ Add item</button>
          <button class="btn sm" (click)="setLock('ALL', !allLocked())">{{ allLocked() ? 'Unlock editing — all branches' : 'Lock editing — all branches' }}</button> }</div>
      <p class="muted" style="font-size:12.5px">Current balance per branch. Red = out of stock · amber = at or below the reorder point · — = no entries yet. Tap a branch to open its stock card.</p>
      <div class="tbl"><table class="t ov"><tr><th>Branch</th><th>Editing</th>@for (it of shownItems(); track it.id) { <th class="num it">{{ it.name }}</th> }</tr>
        @for (b of branches(); track b.id) {
          <tr class="go" (click)="branchId = b.id; pickBranch()"><td><b>{{ short(b.name) }}</b><small>{{ b.hq_code }}</small></td>
            <td><span [class]="'chip ' + (lockOf(b.id) ? 'bad' : 'ok')">{{ lockOf(b.id) ? 'Locked' : 'Open' }}</span></td>
            @for (it of shownItems(); track it.id) {
              <td class="num" [class.out]="cellCls(b.id, it) === 'out'" [class.reo]="cellCls(b.id, it) === 'reo'">{{ cell(b.id, it.id) }}</td>
            }</tr>
        }
      </table></div>
    }
    @case ('use') {
      <div class="tools"><label class="inl">Month <input type="month" [(ngModel)]="uMonth" (change)="loadUse()"></label>
        <select [(ngModel)]="cat" style="width:auto"><option value="all">All categories</option>@for (c of cats(); track c) { <option>{{ c }}</option> }</select>
        <button class="btn sm" (click)="useCsv()">Download CSV</button></div>
      <p class="muted" style="font-size:12.5px">Consumption logged on the daily stock cards of {{ branchId ? short(branchName()) : branches().length + ' branch(es)' }}. "Stock lasts" = balance now ÷ average daily use this month.</p>
      <div class="tbl"><table class="t"><tr><th>Item</th>@for (d of uDays(); track d) { <th class="num d">{{ d }}</th> }<th class="num">Total</th><th class="num">Avg / day</th><th class="num">Balance now</th><th class="num">Stock lasts</th></tr>
        @for (u of usage(); track u.id) {
          <tr><td><b>{{ u.name }}</b><small>{{ u.unit }}</small></td>
            @for (v of u.daily; track $index) { <td class="num d" [style.background]="heat(v, u.max)">{{ v ? n(v) : '' }}</td> }
            <td class="num"><b>{{ n(u.total) }}</b></td><td class="num">{{ n(u.avg) }}</td><td class="num">{{ u.bal === null ? '—' : n(u.bal) }}</td>
            <td class="num">@if (u.cover !== null) { <span [class]="'chip ' + (u.cover < 7 ? 'bad' : u.cover < 14 ? 'warn' : 'ok')">{{ u.cover >= 365 ? '1 yr +' : (u.cover | number: '1.0-0') + ' days' }}</span> } @else { — }</td></tr>
        }
      </table></div>
    }
  }`,
  styles: [`
    .inl{display:flex;align-items:center;gap:6px;margin:0;font-weight:500}
    tr.neg td{background:#FFF7F7} tr.beg td{background:#F6F8FF;font-weight:600} tr.dn td{background:#F1FAF4}
    .ov th.it{white-space:normal;min-width:76px;font-size:11.5px;line-height:1.25}
    .ov td.out{background:var(--red-soft);color:var(--red-dark);font-weight:700} .ov td.reo{background:var(--warn-soft);color:var(--warn-ink);font-weight:600}
    th.d,td.d{min-width:28px;padding-left:3px;padding-right:3px;font-size:11.5px}
  `],
  providers: [],
})
export class Stockcard {
  readonly auth = inject(AuthService);
  private ui = inject(UiService);
  readonly today = todayIso();
  readonly minDate = addDays(this.today, -31);
  readonly isBranch = computed(() => this.auth.is('Branch'));
  readonly canLock = computed(() => this.auth.is('RNS', 'Admin'));
  readonly items = signal<Item[]>([]);
  readonly branches = signal<BranchRow[]>([]);
  readonly balances = signal<Bal[]>([]);
  readonly locks = signal<Record<string, boolean>>({});
  readonly allLocked = signal(false);
  readonly lock = signal<Lock>({ locked: false });
  readonly sub = signal<string>('');
  readonly error = signal('');
  readonly busy = signal(false);
  readonly panel = signal<any>(null);
  readonly card = signal<(Entry & { run: number })[]>([]);
  readonly usage = signal<any[]>([]);
  readonly uDays = signal<number[]>([]);
  branchId = '';
  date = this.today;
  cardItem = 0;
  cat = 'all';
  uMonth = this.today.slice(0, 7);
  day: Record<number, any> = {};
  pf: any = {};
  private after_: Entry[] = [];    // entries on/after the chosen date (for "balance before")
  private begins: Entry[] = [];
  private dayDn: Entry[] = [];
  readonly nice = niceDate; readonly short = shortBranch;
  ok = (x: unknown) => !!x;
  n(v: unknown): string { return num(v, 2); }

  readonly subs = computed(() => this.isBranch() ? [['daily', 'Daily entry'], ['bal', 'Balances'], ['card', 'Stock card']]
    : this.branchIdSig() ? [['overview', 'All branches'], ['bal', 'Balances'], ['card', 'Stock card'], ...(this.canLock() ? [['use', 'Utilization']] : [])]
    : [['overview', 'All branches'], ...(this.canLock() ? [['use', 'Utilization']] : [])]);
  private readonly branchIdSig = signal('');
  readonly cats = computed(() => [...new Set(this.items().map((i) => i.category))]);
  shownItems(): Item[] { return this.items().filter((i) => this.cat === 'all' || i.category === this.cat); }
  branchName(): string { return this.branches().find((b) => b.id === this.branchId)?.name ?? ''; }

  constructor() { this.init(); }

  private async init(): Promise<void> {
    try {
      this.items.set(await rows<Item>(sb.from('sc_items').select('*').eq('active', true).order('category').order('name')));
      this.cardItem = this.items()[0]?.id ?? 0;
      if (this.isBranch()) { this.branchId = this.auth.profile()!.branchId!; this.branchIdSig.set(this.branchId); this.go('daily'); }
      else { this.branches.set(await scopeBranches(this.auth)); this.go('overview'); }
    } catch (e) { this.error.set(errMsg(e)); }
  }

  go(s: string): void {
    this.sub.set(s); this.panel.set(null);
    if (s === 'daily') this.loadDay();
    if (s === 'bal') this.loadBranch();
    if (s === 'card') this.loadCard();
    if (s === 'overview') this.loadOverview();
    if (s === 'use') this.loadUse();
  }
  reload(): void { this.go(this.sub()); }
  pickBranch(): void { this.branchIdSig.set(this.branchId); this.go(this.branchId ? 'bal' : 'overview'); }

  private async loadLock(): Promise<void> {
    if (this.branchId) this.lock.set(await rpc<Lock>('sc_lock_state', { p_branch: this.branchId }));
  }

  private async loadBranch(): Promise<void> {
    try {
      await this.loadLock();
      this.balances.set(await rows<Bal>(sb.from('sc_balances').select('*').eq('branch_id', this.branchId)));
      this.begins = await rows<Entry>(sb.from('sc_entries').select('*').eq('branch_id', this.branchId).eq('kind', 'BEGIN'));
    } catch (e) { this.error.set(errMsg(e)); }
  }

  async loadDay(): Promise<void> {
    try {
      await this.loadBranch();
      if (this.lock().locked) this.date = this.today;
      this.after_ = await rows<Entry>(sb.from('sc_entries').select('*').eq('branch_id', this.branchId).gte('entry_date', this.date));
      this.dayDn = this.after_.filter((e) => e.entry_date === this.date && e.kind === 'DN');
      const d: Record<number, any> = {};
      for (const it of this.items()) {
        const e = this.after_.find((x) => x.item_id === it.id && x.entry_date === this.date && x.kind === 'DAILY');
        d[it.id] = { batch: e?.batch_no ?? '', from: e?.source ?? '', received: e?.received || '', consumed: e?.consumed || '', remarks: e?.remarks ?? '' };
      }
      this.day = d;
    } catch (e) { this.error.set(errMsg(e)); }
  }

  bal(id: number): Bal | undefined { return this.balances().find((b) => b.item_id === id); }
  begin(id: number): Entry | undefined { return this.begins.find((b) => b.item_id === id); }
  before(id: number): number {
    let b = this.bal(id)?.balance ?? 0;
    for (const e of this.after_) if (e.item_id === id && (e.entry_date > this.date || (e.entry_date === this.date && e.kind === 'DAILY'))) b -= e.received - e.consumed;
    return Math.round(b * 100) / 100;
  }
  after(it: Item): number {
    const d = this.day[it.id]; if (!d) return 0;
    const dn = this.dayDn.filter((e) => e.item_id === it.id).reduce((a, e) => a + e.received, 0);
    return Math.round((this.before(it.id) + (Number(d.received) || 0) - (Number(d.consumed) || 0) + (this.date === this.today || true ? 0 : dn)) * 100) / 100;
  }
  dnNote(id: number): string {
    const l = this.dayDn.filter((e) => e.item_id === id);
    return l.length ? 'Received (validated): ' + l.map((e) => `+${num(e.received)} from ${(e.source ?? '').replace(/^HQ · /, '')}`).join(', ') : '';
  }
  status(it: Item): string {
    const b = this.bal(it.id);
    if (!b) return 'No entries';
    return b.balance <= 0 ? 'Out of stock' : it.reorder_point !== null && b.balance <= it.reorder_point ? 'Reorder' : 'OK';
  }
  statusCls(it: Item): string { const s = this.status(it); return s === 'OK' ? 'ok' : s === 'Reorder' ? 'warn' : s === 'Out of stock' ? 'bad' : ''; }

  async saveDay(): Promise<void> {
    const lines = this.items().map((it) => ({ item: it.name, batch: this.day[it.id].batch, from: this.day[it.id].from,
      received: String(this.day[it.id].received ?? ''), consumed: String(this.day[it.id].consumed ?? ''), remarks: this.day[it.id].remarks }));
    this.busy.set(true);
    try { const r = await rpc('sc_save_day', { p_date: this.date, p_lines: lines }); this.ui.notify(r.msg, /Low or out/.test(r.msg) ? 'err' : 'ok'); await this.loadDay(); }
    catch (e) { this.ui.notify(errMsg(e), 'err'); }
    finally { this.busy.set(false); }
  }

  openBegin(it: Item): void {
    const b = this.begin(it.id);
    this.pf = { qty: b?.received ?? '', date: b?.entry_date ?? this.today, batch: b?.batch_no ?? '', expiry: b?.expiry ?? '', remarks: (b?.remarks ?? '').replace(/^Beginning balance( — )?/i, '') };
    this.panel.set({ kind: 'begin', item: it });
  }
  async saveBegin(): Promise<void> {
    try { const r = await rpc('sc_save_begin', { p: { item: this.panel().item.name, qty: String(this.pf.qty ?? ''), date: this.pf.date, batch: this.pf.batch, expiry: this.pf.expiry, remarks: this.pf.remarks } });
      this.ui.notify(r.msg); this.panel.set(null); await this.loadBranch(); }
    catch (e) { this.ui.notify(errMsg(e), 'err'); }
  }
  openItem(): void { this.pf = { name: '', category: 'Supplies', unit: '', desc: '', reorder: '' }; this.panel.set({ kind: 'item' }); }
  async saveItem(): Promise<void> {
    try { const r = await rpc('sc_add_item', { p: { ...this.pf, reorder: String(this.pf.reorder ?? '') } }); this.ui.notify(r.msg); this.panel.set(null);
      this.items.set(await rows<Item>(sb.from('sc_items').select('*').eq('active', true).order('category').order('name'))); this.reload(); }
    catch (e) { this.ui.notify(errMsg(e), 'err'); }
  }

  async setLock(scope: string, on: boolean): Promise<void> {
    const name = scope === 'ALL' ? 'All branches' : shortBranch(this.branches().find((b) => b.id === scope)?.name);
    const ok = await this.ui.confirm({ title: `${on ? 'Lock' : 'Unlock'} stock card editing?`, tone: on ? 'warn' : 'info', ok: on ? 'Lock editing' : 'Unlock editing',
      html: `<b>${escapeHtml(name)}</b><br>` + (on ? '<span class="ud-pill part">The branch can still enter <b>today</b>, but cannot change past days or beginning balances.</span>'
        : '<span class="ud-pill ok">The branch can again correct the last 31 days and edit beginning balances.</span>') });
    if (!ok) return;
    try { const r = await rpc('sc_set_lock', { p_scope: scope, p_locked: on }); this.ui.notify(r.msg); this.reload(); }
    catch (e) { this.ui.notify(errMsg(e), 'err'); }
  }

  async loadCard(): Promise<void> {
    if (!this.cardItem) return;
    try {
      const l = await rows<Entry>(sb.from('sc_entries').select('*').eq('branch_id', this.branchId).eq('item_id', this.cardItem));
      l.sort((a, b) => a.entry_date.localeCompare(b.entry_date) || (a.kind === 'BEGIN' ? 0 : 1) - (b.kind === 'BEGIN' ? 0 : 1) || a.id - b.id);
      let run = 0;
      this.card.set(l.map((e) => ({ ...e, run: (run = Math.round((run + e.received - e.consumed) * 100) / 100) })));
    } catch (e) { this.error.set(errMsg(e)); }
  }
  printCard(): void {
    const it = this.items().find((i) => i.id === this.cardItem); if (!it) return;
    const h = escapeHtml;
    const br = this.isBranch() ? this.auth.profile()?.branchName : this.branchName();
    printHtml(`<!doctype html><html><head><meta charset="utf-8"><title>Stock card</title><style>body{font-family:Arial,sans-serif;font-size:12.5px;padding:20px}
      h2{text-align:center;margin:0 0 12px}table{width:100%;border-collapse:collapse}th,td{border:1px solid #333;padding:4px 6px}th{background:#eee}.n{text-align:right}
      .m{display:grid;grid-template-columns:repeat(4,1fr);gap:6px;margin-bottom:12px}</style></head><body><h2>STOCK CARD</h2>
      <div class="m"><div><b>Branch:</b> ${h(br)}</div><div><b>Item:</b> ${h(it.name)}</div><div><b>Unit:</b> ${h(it.unit)}</div><div><b>Reorder point:</b> ${h(it.reorder_point ?? '—')}</div></div>
      <table><tr><th>Date</th><th>Batch No.</th><th>Expiry</th><th>Ordered / borrowed from</th><th>Received</th><th>Consumed</th><th>Balance</th><th>Remarks</th></tr>
      ${this.card().map((e) => `<tr><td>${h(niceDate(e.entry_date))}</td><td>${h(e.batch_no)}</td><td>${h(niceDate(e.expiry))}</td><td>${h(e.source)}</td>
      <td class="n">${e.received || ''}</td><td class="n">${e.consumed || ''}</td><td class="n"><b>${e.run}</b></td><td>${h(e.remarks)}</td></tr>`).join('')}</table></body></html>`);
  }

  async loadOverview(): Promise<void> {
    try {
      this.balances.set(await rows<Bal>(sb.from('sc_balances').select('*')));
      const locks = await rows<{ scope: string; locked: boolean }>(sb.from('sc_locks').select('scope, locked'));
      const m: Record<string, boolean> = {};
      for (const l of locks) m[l.scope] = l.locked;
      this.allLocked.set(!!m['ALL']);
      this.locks.set(m);
    } catch (e) { this.error.set(errMsg(e)); }
  }
  lockOf(id: string): boolean { return this.allLocked() || !!this.locks()[id]; }
  cell(b: string, item: number): string { const x = this.balances().find((y) => y.branch_id === b && y.item_id === item); return x ? num(x.balance) : '—'; }
  cellCls(b: string, it: Item): string {
    const x = this.balances().find((y) => y.branch_id === b && y.item_id === it.id);
    if (!x) return '';
    return x.balance <= 0 ? 'out' : it.reorder_point !== null && x.balance <= it.reorder_point ? 'reo' : '';
  }

  async loadUse(): Promise<void> {
    if (!/^\d{4}-\d{2}$/.test(this.uMonth)) return;
    const [y, m] = this.uMonth.split('-').map(Number);
    const days = new Date(y, m, 0).getDate();
    const ids = this.branchId ? [this.branchId] : this.branches().map((b) => b.id);
    try {
      const ent = await rows<Entry>(sb.from('sc_entries').select('item_id, entry_date, consumed, branch_id').in('branch_id', ids)
        .gte('entry_date', this.uMonth + '-01').lte('entry_date', `${this.uMonth}-${String(days).padStart(2, '0')}`).gt('consumed', 0).limit(20000));
      const bal = await rows<Bal>(sb.from('sc_balances').select('*').in('branch_id', ids));
      const elapsed = this.uMonth === this.today.slice(0, 7) ? Number(this.today.slice(8)) : days;
      this.uDays.set(Array.from({ length: days }, (_, i) => i + 1));
      this.usage.set(this.shownItems().map((it) => {
        const daily = Array(days).fill(0);
        for (const e of ent) if (e.item_id === it.id) daily[Number(e.entry_date.slice(8)) - 1] += Number(e.consumed);
        const total = daily.reduce((a, b) => a + b, 0), avg = elapsed ? total / elapsed : 0;
        const bs = bal.filter((b) => b.item_id === it.id);
        const b = bs.length ? bs.reduce((a, x) => a + Number(x.balance), 0) : null;
        return { id: it.id, name: it.name, unit: it.unit, daily, total, avg, bal: b, cover: b !== null && avg > 0 ? b / avg : null, max: Math.max(0, ...daily) };
      }));
    } catch (e) { this.error.set(errMsg(e)); }
  }
  heat(v: number, max: number): string { return v > 0 && max > 0 ? `rgba(43,79,216,${(0.08 + 0.45 * v / max).toFixed(2)})` : ''; }
  useCsv(): void {
    const head = ['Item', 'Unit', ...this.uDays().map((d) => `${this.uMonth}-${String(d).padStart(2, '0')}`), 'Total', 'Avg per day', 'Balance now'];
    downloadText(`Stockcard utilization ${this.uMonth}.csv`, toCsv([head, ...this.usage().map((u) => [u.name, u.unit, ...u.daily, u.total, Math.round(u.avg * 100) / 100, u.bal ?? ''])]));
  }
  readonly stamp = niceStamp;
}
