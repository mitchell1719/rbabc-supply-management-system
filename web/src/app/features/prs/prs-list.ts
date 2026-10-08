import { Component, computed, inject, input, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { AuthService } from '../../core/auth.service';
import { errMsg, rows, sb } from '../../core/supabase';
import { niceDate, shortBranch, statusClass } from '../../shared/format';
import { PrsRow, queueFor } from './prs-queue';
import { PrsForm } from './prs-form';

@Component({
  selector: 'app-prs-list',
  imports: [FormsModule, RouterLink, PrsForm],
  template: `
  <div class="pagebar">
    <div class="seg">
      <button type="button" [class.on]="tab() === 'queue'" (click)="tab.set('queue')">{{ queue()?.title }} <i>{{ queue()?.rows?.length ?? 0 }}</i></button>
      <button type="button" [class.on]="tab() === 'all'" (click)="tab.set('all')">All PRS <i>{{ all().length }}</i></button>
      @if (!auth.is('Branch')) { <button type="button" [class.on]="tab() === 'branches'" (click)="tab.set('branches')">Branches</button> }
    </div>
    <div class="btns">
      <button type="button" class="btn" (click)="load()">Refresh</button>
      @if (auth.is('Branch')) { <a class="btn danger" routerLink="/prs-new">+ Submit a PRS</a> }
    </div>
  </div>
  @if (error()) { <div class="err-box">{{ error() }}</div> }

  @if (tab() === 'queue' && queue(); as q) {
    <div class="tbl">
      @if (loading()) { <div class="empty"><span class="spin"></span> Loading PRS…</div> }
      @else if (!q.rows.length) { <div class="empty">{{ q.empty }}</div> }
      @else {
        <table class="t"><tr><th></th><th>PRS Control No.</th><th>PRS Date</th>@if (!isBranch()) { <th>Branch</th> }
          <th class="num">Items</th><th>Prepared by</th><th>Status</th><th>{{ q.kind === 'review' ? 'Days open' : 'RNS' }}</th></tr>
          @for (r of q.rows; track r.id) {
            <tr><td><button class="btn sm" [class.danger]="q.kind === 'review' || r.status === 'Returned for Correction'" (click)="openId.set(r.id)">
                {{ q.kind === 'review' ? 'Review' : r.status === 'Returned for Correction' ? 'Fix & resubmit' : 'View' }}</button>
                @if (q.kind === 'review' && (r.rns_action ?? '').startsWith('Resubmitted')) { <small class="chip bad" style="margin-top:4px">Resubmitted</small> }</td>
              <td><b>{{ r.control_no }}</b></td><td>{{ nice(r.prs_date) }}</td>@if (!isBranch()) { <td>{{ short(r.branch_name) }}</td> }
              <td class="num">{{ r.item_count }}</td><td>{{ r.prepared_by }}</td><td><span [class]="'chip ' + cls(r.status)">{{ r.status }}</span></td>
              <td>@if (q.kind === 'review') { {{ r.days_open }} } @else { <small>{{ r.rns_action }}@if (r.rns_note) { <br><b>Note:</b> {{ r.rns_note }} }</small> }</td></tr>
          }
        </table>
      }
    </div>
  }

  @if (tab() === 'all') {
    <div class="tools">
      <input type="search" [(ngModel)]="q" placeholder="Search PRS no., prepared by, department">
      @if (!isBranch()) {
        <select [(ngModel)]="branch"><option value="">All branches</option>@for (b of branchList(); track b) { <option [value]="b">{{ short(b) }}</option> }</select>
      }
      <select [(ngModel)]="status"><option value="">All statuses</option>@for (s of statusList(); track s) { <option>{{ s }}</option> }</select>
      <label class="inl">From <input type="date" [(ngModel)]="from"></label>
      <label class="inl">To <input type="date" [(ngModel)]="to"></label>
      <button type="button" class="btn sm" (click)="q = ''; branch = ''; status = ''; from = ''; to = ''">Clear</button>
    </div>
    <p class="muted small">Showing {{ filtered().length }} of {{ all().length }} PRS</p>
    <div class="tbl">
      @if (!filtered().length) { <div class="empty">{{ loading() ? 'Loading…' : all().length ? 'No PRS match these filters.' : 'No PRS submitted yet.' }}</div> }
      @else {
        <table class="t"><tr><th></th><th>PRS Control No.</th><th>PRS Date</th>@if (!isBranch()) { <th>Branch</th> }<th class="num">Items</th>
          <th>Status</th><th>Date served</th><th>DN No.</th><th class="num">Days open</th></tr>
          @for (r of filtered(); track r.id) {
            <tr><td><button class="btn sm" (click)="openId.set(r.id)">View</button></td><td><b>{{ r.control_no }}</b></td><td>{{ nice(r.prs_date) }}</td>
              @if (!isBranch()) { <td>{{ short(r.branch_name) }}</td> }<td class="num">{{ r.item_count }}</td>
              <td><span [class]="'chip ' + cls(r.status)">{{ r.status }}</span></td><td>{{ nice(r.date_served) }}</td>
              <td><small>{{ r.dn_numbers.join(', ') }}</small></td><td class="num">{{ r.days_open ?? '' }}</td></tr>
          }
        </table>
      }
    </div>
  }

  @if (tab() === 'branches') {
    <div class="tbl">
      <table class="t"><tr><th>Branch</th><th class="num">Total PRS</th><th class="num">For review</th><th class="num">Open</th><th class="num">Open &gt; 7 days</th><th class="num">Served</th><th>Last PRS</th></tr>
        @for (b of summary(); track b.name) {
          <tr><td><b>{{ short(b.name) }}</b><small>{{ b.hq }}</small></td><td class="num">{{ b.total }}</td><td class="num">{{ b.review }}</td><td class="num">{{ b.open }}</td>
            <td class="num" [style.color]="b.over7 ? 'var(--red-dark)' : ''"><b>{{ b.over7 }}</b></td><td class="num">{{ b.served }}</td><td>{{ nice(b.last) }}</td></tr>
        } @empty { <tr><td colspan="7" class="empty">No branches in your scope.</td></tr> }
      </table>
    </div>
  }

  @if (openId(); as id) { <app-prs-form [prsId]="id" (closed)="openId.set(null)" (changed)="load()" /> }
  `,
  styles: [`.inl{display:flex;align-items:center;gap:6px;margin:0;font-weight:500;color:var(--mute)} .small{font-size:12.5px;margin:0 0 8px}`],
})
export class PrsList {
  readonly auth = inject(AuthService);
  readonly open = input<string>();             // ?open=<prs id>
  readonly all = signal<PrsRow[]>([]);
  readonly branches = signal<{ id: string; name: string; hq_code: string }[]>([]);
  readonly loading = signal(true);
  readonly error = signal('');
  readonly tab = signal<'queue' | 'all' | 'branches'>('queue');
  readonly openId = signal<string | null>(null);
  q = ''; branch = ''; status = ''; from = ''; to = '';
  readonly isBranch = computed(() => this.auth.is('Branch'));
  readonly queue = computed(() => queueFor(this.auth.type(), this.all()));
  readonly branchList = computed(() => [...new Set(this.all().map((r) => r.branch_name))].sort());
  readonly statusList = computed(() => [...new Set(this.all().map((r) => r.status))].sort());
  readonly nice = niceDate;
  readonly short = shortBranch;
  readonly cls = statusClass;

  readonly summary = computed(() => {
    const m: Record<string, any> = {};
    for (const b of this.branches()) m[b.id] = { name: b.name, hq: b.hq_code, total: 0, review: 0, open: 0, over7: 0, served: 0, last: '' };
    for (const r of this.all()) {
      const s = m[r.branch_id] ?? (m[r.branch_id] = { name: r.branch_name, hq: r.hq_code, total: 0, review: 0, open: 0, over7: 0, served: 0, last: '' });
      s.total++;
      if (r.status === 'Served') s.served++;
      const open = r.status !== 'Served' && r.status !== 'Cancelled';
      if (open) s.open++;
      if (open && (r.days_open ?? 0) > 7) s.over7++;
      if (r.status === 'Submitted' || r.status === 'Under Review') s.review++;
      if (r.prs_date > s.last) s.last = r.prs_date;
    }
    return Object.values(m).sort((a: any, b: any) => (a.hq + a.name).localeCompare(b.hq + b.name));
  });

  filtered(): PrsRow[] {
    const q = this.q.trim().toLowerCase();
    return this.all().filter((r) =>
      (!this.branch || r.branch_name === this.branch) && (!this.status || r.status === this.status) &&
      (!this.from || r.prs_date >= this.from) && (!this.to || r.prs_date <= this.to) &&
      (!q || `${r.control_no} ${r.prepared_by ?? ''} ${r.department ?? ''} ${r.branch_name}`.toLowerCase().includes(q)));
  }

  constructor() { this.load(); }

  ngOnInit(): void { if (this.open()) this.openId.set(this.open()!); }

  async load(): Promise<void> {
    this.loading.set(true); this.error.set('');
    try {
      const [p, b] = await Promise.all([
        rows<PrsRow>(sb.from('prs_v').select('*').order('submitted_at', { ascending: false }).limit(2000)),
        this.auth.is('Branch') ? Promise.resolve([]) : rows(sb.from('branches').select('id, name, hq_code').eq('active', true)),
      ]);
      // RNS / HQ only list branches in their scope (the PRS RLS already scopes the PRS)
      const t = this.auth.type();
      const hqs = this.auth.profile()?.hqs ?? [];
      const me = this.auth.profile()?.id;
      let scoped = b as any[];
      if (t === 'HQ') scoped = scoped.filter((x) => hqs.includes(x.hq_code));
      if (t === 'RNS') {
        const mine = await rows(sb.from('branches').select('id, name, hq_code').eq('rns_user_id', me!));
        scoped = mine.length ? mine : scoped.filter((x) => hqs.includes(x.hq_code));
      }
      this.all.set(p); this.branches.set(scoped);
    } catch (e) { this.error.set(errMsg(e)); }
    finally { this.loading.set(false); }
  }
}
