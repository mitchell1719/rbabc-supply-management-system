import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { AuthService } from '../../core/auth.service';
import { errMsg, rows, rpc, sb } from '../../core/supabase';
import { UiService } from '../../core/ui.service';
import { downloadText, niceStamp, shortBranch, todayIso } from '../../shared/format';

type ColType = 'text' | 'number' | 'bool' | 'select' | 'multi' | 'json' | 'textarea';
interface Opt { v: string; l: string; }
interface Col { key: string; label: string; type: ColType; options?: () => Opt[]; required?: boolean; keyCol?: boolean; list?: boolean; hint?: string; }
interface TableCfg { id: string; label: string; table: string; pk: string; order: string[]; cols: Col[]; note: string; canDelete: boolean;
  blank: () => Record<string, any>; afterInsert?: (row: Record<string, any>) => Promise<void>; }
interface User { id: string; username: string; display_name: string; type: string; hq_codes: string[]; branch_id: string | null; email: string | null;
  active: boolean; full_name: string | null; position: string | null; }
interface Hq { code: string; name: string; region: string; email: string | null; }
interface Branch { id: string; name: string; short_name: string; hq_code: string; }

const TYPES = ['Branch', 'HQ', 'RNS', 'Admin', 'Finance'];

/** Admin setup: accounts, branches, HQs, links, DSM groups, products, stock card items, employees, attendance sites,
 *  refrigerators, settings, e-mail outbox, login log and data export. */
@Component({
  selector: 'app-admin',
  imports: [FormsModule],
  template: `
  <div class="pagebar">
    <div class="seg">
      <button type="button" [class.on]="tab() === 'accounts'" (click)="go('accounts')">Accounts</button>
      @for (t of tables; track t.id) { <button type="button" [class.on]="tab() === t.id" (click)="go(t.id)">{{ t.label }}</button> }
      <button type="button" [class.on]="tab() === 'outbox'" (click)="go('outbox')">E-mail outbox</button>
      <button type="button" [class.on]="tab() === 'log'" (click)="go('log')">Login log</button>
      <button type="button" [class.on]="tab() === 'backup'" (click)="go('backup')">Backup</button>
    </div>
  </div>
  @if (error()) { <div class="err-box" style="margin-bottom:12px">{{ error() }}</div> }

  @if (tab() === 'accounts') {
    <div class="pagebar"><div class="tools" style="margin:0"><input type="search" [(ngModel)]="q" placeholder="Search accounts">
      <select [(ngModel)]="typeFilter"><option value="">All types</option>@for (t of types; track t) { <option>{{ t }}</option> }</select></div>
      <button class="btn pri" (click)="newUser()">+ New account</button></div>
    <div class="tbl"><table class="t"><tr><th>Username</th><th>Name</th><th>Type</th><th>HQ / branch</th><th>E-mail</th><th>Status</th><th></th></tr>
      @for (u of shownUsers(); track u.id) {
        <tr><td><b>{{ u.username }}</b></td><td>{{ u.display_name }}@if (u.full_name) { <small>{{ u.full_name }}{{ u.position ? ' · ' + u.position : '' }}</small> }</td><td>{{ u.type }}</td>
          <td>{{ u.type === 'Branch' ? short(branchName(u.branch_id)) : u.hq_codes.join(', ') }}</td><td>{{ u.email || '—' }}</td>
          <td><span [class]="'chip ' + (u.active ? 'ok' : 'bad')">{{ u.active ? 'Active' : 'Inactive' }}</span></td>
          <td><div class="btns"><button class="btn sm" (click)="editUser(u)">Edit</button><button class="btn sm" (click)="resetPw(u)">Reset password</button></div></td></tr>
      } @empty { <tr><td colspan="7" class="empty">No accounts.</td></tr> }
    </table></div>
  }

  @if (cfg(); as c) {
    <div class="pagebar"><p class="sub" style="margin:0;max-width:760px">{{ c.note }}</p>
      <div class="btns"><input type="search" [(ngModel)]="q" placeholder="Search" style="width:200px"><button class="btn" (click)="loadTable()">Refresh</button>
        <button class="btn pri" (click)="add(c)">+ Add</button></div></div>
    <div class="tbl">
      @if (!shownData().length) { <div class="empty">{{ loading() ? 'Loading…' : 'Nothing here yet.' }}</div> }
      @else {
        <table class="t"><tr>@for (col of listCols(c); track col.key) { <th>{{ col.label }}</th> }<th></th></tr>
          @for (r of shownData(); track $index) {
            <tr>@for (col of listCols(c); track col.key) { <td>{{ show(col, r[col.key]) }}</td> }
              <td><div class="btns"><button class="btn sm" (click)="edit(c, r)">Edit</button>
                @if (c.canDelete) { <button class="btn sm outline-red" (click)="remove(c, r)">Delete</button> }</div></td></tr>
          }
        </table>
      }
    </div>
  }

  @if (tab() === 'outbox') {
    <div class="pagebar"><p class="sub" style="margin:0">E-mails queued by the portal. The <b>send-emails</b> Edge Function sends them every few minutes.</p><button class="btn" (click)="loadOutbox()">Refresh</button></div>
    <div class="tbl"><table class="t"><tr><th>Queued</th><th>To</th><th>Subject</th><th>Status</th></tr>
      @for (m of outbox(); track m.id) {
        <tr><td>{{ stamp(m.created_at) }}</td><td>{{ m.to_addr.join(', ') }}@if (m.cc_addr.length) { <small>cc {{ m.cc_addr.join(', ') }}</small> }</td><td>{{ m.subject }}</td>
          <td>@if (m.sent_at) { <span class="chip ok">Sent</span><small>{{ stamp(m.sent_at) }}</small> } @else { <span [class]="'chip ' + (m.error ? 'bad' : 'warn')">{{ m.error ? 'Failed (' + m.attempts + ')' : 'Waiting' }}</span>@if (m.error) { <small>{{ m.error }}</small> } }</td></tr>
      } @empty { <tr><td colspan="4" class="empty">No e-mails.</td></tr> }
    </table></div>
  }

  @if (tab() === 'log') {
    <div class="pagebar"><p class="sub" style="margin:0">Latest 300 log-ins and workflow events.</p><button class="btn" (click)="loadLog()">Refresh</button></div>
    <div class="tbl"><table class="t"><tr><th>When</th><th>Username</th><th>Type</th><th>Event</th></tr>
      @for (l of log(); track l.id) { <tr><td>{{ stamp(l.at) }}</td><td>{{ l.username }}</td><td>{{ l.type }}</td><td>{{ l.result }}</td></tr> }
      @empty { <tr><td colspan="4" class="empty">No entries.</td></tr> }
    </table></div>
  }

  @if (tab() === 'backup') {
    <div class="card">
      <h4>Data backup</h4>
      <p class="sub">Supabase keeps daily database backups (see your project's <b>Database → Backups</b>). You can also download every portal table as one JSON file here and keep it in your Google Drive.
        Uploaded files (photos, attachments, selfies) stay in Supabase Storage.</p>
      <button class="btn pri" [disabled]="busy()" (click)="exportAll()">{{ busy() ? 'Preparing…' : 'Download all data (JSON)' }}</button>
    </div>
  }

  @if (form(); as f) {
    <div class="overlay" role="dialog" aria-modal="true">
      <div class="modal">
        <div class="modal-bar"><b>{{ f.title }}</b></div>
        @if (f.kind === 'user') {
          <div class="grid2">
            <div><label>Username</label><input [(ngModel)]="u.username" [readonly]="!!u.id" placeholder="e.g. DANAO"></div>
            <div><label>Display name</label><input [(ngModel)]="u.displayName" placeholder="e.g. RB ABC Danao Inc."></div>
            <div><label>Account type</label><select [(ngModel)]="u.type">@for (t of types; track t) { <option>{{ t }}</option> }</select></div>
            <div><label>Notification e-mail</label><input type="email" [(ngModel)]="u.email"></div>
            @if (u.type === 'Branch') {
              <div class="span2"><label>Branch</label><select [(ngModel)]="u.branchId"><option value="">Choose…</option>@for (b of branches(); track b.id) { <option [value]="b.id">{{ b.name }}</option> }</select></div>
            } @else if (u.type !== 'Admin' && u.type !== 'Finance') {
              <div class="span2"><label>{{ u.type === 'RNS' ? 'HQs covered' : 'Headquarters' }}</label>
                <div class="checks">@for (h of hqs(); track h.code) { <label><input type="checkbox" [checked]="u.hqCodes.includes(h.code)" (change)="toggle(u.hqCodes, h.code)"> {{ h.name }}</label> }</div></div>
            }
            @if (!u.id) { <div><label>Password</label><input type="text" [(ngModel)]="u.password" placeholder="at least 6 characters" autocomplete="off"></div> }
            @else { <div><label>Status</label><select [(ngModel)]="u.active"><option [ngValue]="true">Active</option><option [ngValue]="false">Inactive (cannot log in)</option></select></div> }
          </div>
          @if (u.type === 'RNS') { <p class="muted" style="font-size:12.5px">Assign the branches this RNS reviews under <b>Branches</b> (column RNS).</p> }
        } @else {
          <div class="grid2">
            @for (col of f.cfg!.cols; track col.key) {
              <div [class.span2]="col.type === 'json' || col.type === 'textarea' || col.type === 'multi'">
                <label>{{ col.label }}@if (col.hint) { <small class="muted"> — {{ col.hint }}</small> }</label>
                @switch (col.type) {
                  @case ('bool') { <select [(ngModel)]="row[col.key]"><option [ngValue]="true">Yes</option><option [ngValue]="false">No</option></select> }
                  @case ('number') { <input type="number" step="any" [(ngModel)]="row[col.key]"> }
                  @case ('select') { <select [(ngModel)]="row[col.key]"><option value="">—</option>@for (o of col.options!(); track o.v) { <option [value]="o.v">{{ o.l }}</option> }</select> }
                  @case ('multi') { <div class="checks tall">@for (o of col.options!(); track o.v) { <label><input type="checkbox" [checked]="(row[col.key] || []).includes(o.v)" (change)="toggleRow(col.key, o.v)"> {{ o.l }}</label> }</div> }
                  @case ('json') { <textarea [(ngModel)]="row[col.key]" rows="5" style="font-family:monospace;font-size:12.5px"></textarea> }
                  @case ('textarea') { <textarea [(ngModel)]="row[col.key]"></textarea> }
                  @default { <input [(ngModel)]="row[col.key]" [readonly]="col.keyCol && !f.isNew"> }
                }
                @if (col.key === 'lat' && f.cfg!.id === 'sites') { <button type="button" class="btn sm" style="margin-top:6px" (click)="here()">Use my current location</button> }
              </div>
            }
          </div>
        }
        <div class="flash err" style="margin-top:8px">{{ formErr() }}</div>
        <div class="btns end" style="margin-top:10px"><button class="btn" (click)="form.set(null)">Cancel</button><button class="btn pri" [disabled]="busy()" (click)="saveForm()">Save</button></div>
      </div>
    </div>
  }`,
  styles: [`
    .checks{display:flex;flex-wrap:wrap;gap:6px 16px;padding:8px 10px;border:1px solid var(--line);border-radius:10px}
    .checks.tall{max-height:220px;overflow:auto}
    .checks label{display:flex;align-items:center;gap:6px;font-weight:400;margin:0;font-size:13px}.checks input{width:auto}
    .seg{max-width:100%}
  `],
})
export class AdminSetup {
  private auth = inject(AuthService);
  private ui = inject(UiService);
  readonly tab = signal('accounts');
  readonly users = signal<User[]>([]);
  readonly hqs = signal<Hq[]>([]);
  readonly branches = signal<Branch[]>([]);
  readonly data = signal<Record<string, any>[]>([]);
  readonly outbox = signal<any[]>([]);
  readonly log = signal<any[]>([]);
  readonly loading = signal(false);
  readonly busy = signal(false);
  readonly error = signal('');
  readonly formErr = signal('');
  readonly form = signal<{ kind: 'user' | 'row'; title: string; cfg?: TableCfg; isNew: boolean; orig?: Record<string, any> } | null>(null);
  q = ''; typeFilter = '';
  row: Record<string, any> = {};
  u = { id: '', username: '', displayName: '', type: 'Branch', email: '', branchId: '', hqCodes: [] as string[], password: '', active: true };
  readonly types = TYPES;
  readonly stamp = niceStamp; readonly short = shortBranch;

  private hqOpts = (): Opt[] => this.hqs().map((h) => ({ v: h.code, l: h.name }));
  private branchOpts = (): Opt[] => this.branches().map((b) => ({ v: b.id, l: b.name }));
  private rnsOpts = (): Opt[] => this.users().filter((x) => x.type === 'RNS' && x.active).map((x) => ({ v: x.id, l: x.full_name || x.display_name }));

  readonly tables: TableCfg[] = [
    { id: 'branches', label: 'Branches', table: 'branches', pk: 'id', order: ['hq_code', 'name'], canDelete: false,
      note: 'Branches and their RNS. A new branch also gets its own refrigerator for the temperature log. Make a Branch account for it under Accounts.',
      blank: () => ({ name: '', short_name: '', code: '', hq_code: '', region: '', rns_user_id: '', active: true }),
      cols: [
        { key: 'name', label: 'Branch name', type: 'text', required: true, list: true, hint: 'e.g. RB ABC Danao Inc.' },
        { key: 'short_name', label: 'Short name', type: 'text', required: true, hint: 'e.g. DANAO' },
        { key: 'code', label: 'Code', type: 'text', list: true, hint: 'used in the BRR no., e.g. DAN' },
        { key: 'hq_code', label: 'Headquarters', type: 'select', options: () => this.hqOpts(), required: true, list: true },
        { key: 'region', label: 'Region', type: 'text', list: true },
        { key: 'rns_user_id', label: 'RNS', type: 'select', options: () => this.rnsOpts(), list: true },
        { key: 'active', label: 'Active', type: 'bool', list: true },
      ],
      afterInsert: async (r) => {
        await sb.from('fridge_locations').insert({ name: r['name'], kind: 'Branch', hq_code: r['hq_code'], branch_id: r['id'], ref_count: 1, ref_names: [] });
      } },
    { id: 'hqs', label: 'HQs', table: 'hqs', pk: 'code', order: ['sort', 'code'], canDelete: false,
      note: 'Headquarters. The e-mail receives the PRS sent to the HQ and SOA notices.',
      blank: () => ({ code: '', name: '', region: '', email: '', sort: 0 }),
      cols: [
        { key: 'code', label: 'Code', type: 'text', required: true, keyCol: true, list: true, hint: 'e.g. CEBU' },
        { key: 'name', label: 'Name', type: 'text', required: true, list: true },
        { key: 'region', label: 'Region', type: 'text', required: true, list: true },
        { key: 'email', label: 'Supply Officer e-mail', type: 'text', list: true },
        { key: 'sort', label: 'Order', type: 'number' },
      ] },
    { id: 'links', label: 'Quick links', table: 'links', pk: 'id', order: ['sort', 'name'], canDelete: true,
      note: 'Links shown on the home page. Choose who sees each link.',
      blank: () => ({ name: '', url: 'https://', show_to: ['All'], hq_only: '', description: '', highlight: false, active: true, sort: 0 }),
      cols: [
        { key: 'name', label: 'Name', type: 'text', required: true, list: true },
        { key: 'url', label: 'URL', type: 'text', required: true, list: true },
        { key: 'show_to', label: 'Show to', type: 'multi', options: () => ['All', ...TYPES].map((t) => ({ v: t, l: t })), list: true },
        { key: 'hq_only', label: 'Only for one HQ', type: 'select', options: () => this.hqOpts() },
        { key: 'description', label: 'Description', type: 'text' },
        { key: 'highlight', label: 'Highlight', type: 'bool' },
        { key: 'active', label: 'Active', type: 'bool', list: true },
        { key: 'sort', label: 'Order', type: 'number' },
      ] },
    { id: 'dsm', label: 'DSM groups', table: 'dsm_groups', pk: 'key', order: ['key'], canDelete: false,
      note: 'District Sales Manager / Branch Manager groups. The HQ makes one SOA per group; the approved SOA is e-mailed to the manager and the OIC.',
      blank: () => ({ key: '', role: 'District Sales Manager', manager_name: '', manager_email: '', oic: '', oic_email: '', rns_name: '', area: '', phone: '', branch_ids: [], active: true }),
      cols: [
        { key: 'key', label: 'Key', type: 'text', required: true, keyCol: true, list: true, hint: 'short unique name, e.g. ANDREA' },
        { key: 'role', label: 'Role', type: 'select', options: () => [{ v: 'District Sales Manager', l: 'District Sales Manager' }, { v: 'Branch Manager', l: 'Branch Manager' }], list: true },
        { key: 'manager_name', label: 'Manager', type: 'text', list: true },
        { key: 'manager_email', label: 'Manager e-mail', type: 'text' },
        { key: 'oic', label: 'OIC', type: 'text', list: true },
        { key: 'oic_email', label: 'OIC e-mail', type: 'text' },
        { key: 'rns_name', label: 'RNS', type: 'text' },
        { key: 'area', label: 'Area', type: 'text', list: true },
        { key: 'phone', label: 'Phone', type: 'text' },
        { key: 'branch_ids', label: 'Branches', type: 'multi', options: () => this.branchOpts(), list: true },
        { key: 'active', label: 'Active', type: 'bool', list: true },
      ] },
    { id: 'products', label: 'Products', table: 'products', pk: 'sku', order: ['name'], canDelete: false,
      note: 'Central Warehouse product list. New products are also added to the branch stock card items.',
      blank: () => ({ sku: '', name: '', category: 'Medical Supplies', uom: '', unit_cost: 0, reorder_point: '', supplier: '', active: true }),
      cols: [
        { key: 'sku', label: 'SKU', type: 'text', required: true, keyCol: true, list: true },
        { key: 'name', label: 'Product name', type: 'text', required: true, list: true },
        { key: 'category', label: 'Category', type: 'select', options: () => ['Vaccine', 'Medicine', 'Medical Supplies', 'Office Supplies', 'Others'].map((x) => ({ v: x, l: x })), list: true },
        { key: 'uom', label: 'UOM', type: 'text', list: true },
        { key: 'unit_cost', label: 'Unit cost (₱)', type: 'number', list: true },
        { key: 'reorder_point', label: 'Re-order point', type: 'number' },
        { key: 'supplier', label: 'Supplier', type: 'text', list: true },
        { key: 'active', label: 'Active', type: 'bool', list: true },
      ] },
    { id: 'sc', label: 'Stock card items', table: 'sc_items', pk: 'id', order: ['category', 'name'], canDelete: false,
      note: 'Items on the branch stock card. Items linked to a product follow its name and unit.',
      blank: () => ({ name: '', category: 'Supplies', description: '', unit: '', reorder_point: '', sku: '', active: true }),
      cols: [
        { key: 'name', label: 'Item', type: 'text', required: true, list: true },
        { key: 'category', label: 'Category', type: 'select', options: () => ['Supplies', 'Vaccine', 'Meds'].map((x) => ({ v: x, l: x })), required: true, list: true },
        { key: 'description', label: 'Description', type: 'text' },
        { key: 'unit', label: 'Unit', type: 'text', list: true },
        { key: 'reorder_point', label: 'Re-order point', type: 'number', list: true },
        { key: 'sku', label: 'Product SKU', type: 'text', list: true },
        { key: 'active', label: 'Active', type: 'bool', list: true },
      ] },
    { id: 'emps', label: 'Employees', table: 'employees', pk: 'id', order: ['hq_code', 'name'], canDelete: false,
      note: 'Supply Officers who log TIME IN / TIME OUT at the HQ.',
      blank: () => ({ id: '', name: '', hq_code: '', active: true }),
      cols: [
        { key: 'id', label: 'Employee ID', type: 'text', required: true, keyCol: true, list: true, hint: 'e.g. RBSO-005' },
        { key: 'name', label: 'Name', type: 'text', required: true, list: true },
        { key: 'hq_code', label: 'Headquarters', type: 'select', options: () => this.hqOpts(), list: true },
        { key: 'active', label: 'Active', type: 'bool', list: true },
      ] },
    { id: 'sites', label: 'Attendance sites', table: 'attendance_sites', pk: 'name', order: ['name'], canDelete: true,
      note: 'Where TIME IN / TIME OUT is allowed: the GPS position must be within the radius. Open this on a phone inside the HQ and use “Use my current location”.',
      blank: () => ({ name: '', hq_code: '', lat: '', lng: '', radius: 100, active: true }),
      cols: [
        { key: 'name', label: 'Name', type: 'text', required: true, keyCol: true, list: true, hint: 'e.g. CEBU HQ' },
        { key: 'hq_code', label: 'Headquarters', type: 'select', options: () => this.hqOpts(), list: true },
        { key: 'lat', label: 'Latitude', type: 'number', list: true },
        { key: 'lng', label: 'Longitude', type: 'number', list: true },
        { key: 'radius', label: 'Radius (m)', type: 'number', required: true, list: true },
        { key: 'active', label: 'Active', type: 'bool', list: true },
      ] },
    { id: 'fridges', label: 'Refrigerators', table: 'fridge_locations', pk: 'id', order: ['kind', 'name'], canDelete: false,
      note: 'Temperature log locations. A branch has one location; set how many refrigerators it has and their names.',
      blank: () => ({ name: '', kind: 'HQ', hq_code: '', branch_id: '', ref_count: 1, ref_names: '[]' }),
      cols: [
        { key: 'name', label: 'Name', type: 'text', required: true, list: true },
        { key: 'kind', label: 'Kind', type: 'select', options: () => [{ v: 'HQ', l: 'HQ' }, { v: 'Branch', l: 'Branch' }], required: true, list: true },
        { key: 'hq_code', label: 'Headquarters', type: 'select', options: () => this.hqOpts(), required: true, list: true },
        { key: 'branch_id', label: 'Branch (kind Branch only)', type: 'select', options: () => this.branchOpts() },
        { key: 'ref_count', label: 'No. of refrigerators', type: 'number', required: true, list: true },
        { key: 'ref_names', label: 'Refrigerator names', type: 'json', hint: 'JSON list, e.g. ["Vaccine ref", "Back-up ref"]', list: true },
      ] },
    { id: 'settings', label: 'Settings', table: 'app_settings', pk: 'key', order: ['key'], canDelete: false,
      note: 'Portal settings. Values are JSON: text in quotes, numbers plain, objects in braces.',
      blank: () => ({ key: '', value: '""', note: '' }),
      cols: [
        { key: 'key', label: 'Key', type: 'text', required: true, keyCol: true, list: true },
        { key: 'value', label: 'Value (JSON)', type: 'json', required: true, list: true },
        { key: 'note', label: 'Note', type: 'text', list: true },
      ] },
  ];

  readonly cfg = computed(() => this.tables.find((t) => t.id === this.tab()) ?? null);

  constructor() { this.loadBase(); }

  private async loadBase(): Promise<void> {
    try {
      const [u, h, b] = await Promise.all([
        rows<User>(sb.from('app_users').select('id, username, display_name, type, hq_codes, branch_id, email, active, full_name, position').order('type').order('username')),
        rows<Hq>(sb.from('hqs').select('*').order('sort').order('code')),
        rows<Branch>(sb.from('branches').select('id, name, short_name, hq_code').order('name')),
      ]);
      this.users.set(u); this.hqs.set(h); this.branches.set(b);
    } catch (e) { this.error.set(errMsg(e)); }
  }

  go(t: string): void {
    this.tab.set(t); this.q = ''; this.error.set(''); this.data.set([]);
    if (this.cfg()) this.loadTable();
    if (t === 'outbox') this.loadOutbox();
    if (t === 'log') this.loadLog();
    if (t === 'accounts') this.loadBase();
  }

  /* ---------- accounts (Edge Function admin-users) ---------- */
  shownUsers(): User[] {
    const q = this.q.trim().toLowerCase();
    return this.users().filter((u) => (!this.typeFilter || u.type === this.typeFilter)
      && (!q || [u.username, u.display_name, u.full_name, u.email, u.hq_codes.join(' '), this.branchName(u.branch_id)].join(' ').toLowerCase().includes(q)));
  }
  branchName(id: string | null): string { return this.branches().find((b) => b.id === id)?.name ?? ''; }
  toggle(list: string[], v: string): void { const i = list.indexOf(v); if (i >= 0) list.splice(i, 1); else list.push(v); }
  newUser(): void {
    this.u = { id: '', username: '', displayName: '', type: 'Branch', email: '', branchId: '', hqCodes: [], password: '', active: true };
    this.formErr.set(''); this.form.set({ kind: 'user', title: 'New account', isNew: true });
  }
  editUser(x: User): void {
    this.u = { id: x.id, username: x.username, displayName: x.display_name, type: x.type, email: x.email ?? '', branchId: x.branch_id ?? '', hqCodes: [...x.hq_codes], password: '', active: x.active };
    this.formErr.set(''); this.form.set({ kind: 'user', title: 'Edit ' + x.username, isNew: false });
  }
  private async callUsers(body: Record<string, unknown>): Promise<string> {
    const { data, error } = await sb.functions.invoke('admin-users', { body });
    let r = data as { ok?: boolean; msg?: string } | null;
    if (error) {
      try { r = await (error as any).context?.json?.(); } catch { r = null; }
      if (!r?.msg) throw new Error(errMsg(error));
    }
    if (!r?.ok) throw new Error(r?.msg || 'The account service did not answer.');
    return r.msg ?? 'Done.';
  }
  async resetPw(x: User): Promise<void> {
    const pw = await this.ui.prompt({ title: 'Reset password', message: `New password for ${x.username} (at least 6 characters):`, ok: 'Reset', required: true });
    if (pw === null) return;
    try { this.ui.notify(await this.callUsers({ action: 'reset_password', userId: x.id, password: pw })); } catch (e) { this.error.set(errMsg(e)); }
  }

  /* ---------- generic tables ---------- */
  async loadTable(): Promise<void> {
    const c = this.cfg();
    if (!c) return;
    this.loading.set(true);
    try {
      let q = sb.from(c.table).select('*');
      for (const o of c.order) q = q.order(o);
      this.data.set(await rows(q.limit(2000)));
    } catch (e) { this.error.set(errMsg(e)); }
    finally { this.loading.set(false); }
  }
  listCols(c: TableCfg): Col[] { return c.cols.filter((x) => x.list); }
  shownData(): Record<string, any>[] {
    const q = this.q.trim().toLowerCase();
    return q ? this.data().filter((r) => JSON.stringify(r).toLowerCase().includes(q)) : this.data();
  }
  show(col: Col, v: any): string {
    if (v === null || v === undefined || v === '') return '—';
    if (col.type === 'bool') return v ? 'Yes' : 'No';
    if (col.type === 'select') return col.key === 'branch_id' || col.key === 'hq_code' ? (col.options!().find((o) => o.v === v)?.l ?? v)
      : col.key === 'rns_user_id' ? (col.options!().find((o) => o.v === v)?.l ?? '(inactive RNS)') : String(v);
    if (col.type === 'multi') {
      const opts = col.options!();
      const names = (v as string[]).map((x) => shortBranch(opts.find((o) => o.v === x)?.l ?? x));
      return names.length > 6 ? names.slice(0, 6).join(', ') + ` +${names.length - 6} more` : names.join(', ');
    }
    if (col.type === 'json') return JSON.stringify(v).slice(0, 120);
    return String(v);
  }
  add(c: TableCfg): void {
    this.row = c.blank();
    this.formErr.set(''); this.form.set({ kind: 'row', title: 'Add — ' + c.label, cfg: c, isNew: true });
  }
  edit(c: TableCfg, r: Record<string, any>): void {
    this.row = { ...r };
    for (const col of c.cols) {
      if (col.type === 'json') this.row[col.key] = JSON.stringify(r[col.key] ?? null, null, 2);
      if (col.type === 'multi') this.row[col.key] = [...(r[col.key] ?? [])];
      if ((col.type === 'select' || col.type === 'text') && this.row[col.key] === null) this.row[col.key] = '';
    }
    this.formErr.set(''); this.form.set({ kind: 'row', title: 'Edit — ' + c.label, cfg: c, isNew: false, orig: r });
  }
  toggleRow(key: string, v: string): void { const l: string[] = this.row[key] ?? (this.row[key] = []); this.toggle(l, v); }
  here(): void {
    if (!navigator.geolocation) { this.formErr.set('This device has no location service.'); return; }
    navigator.geolocation.getCurrentPosition(
      (p) => { this.row['lat'] = Math.round(p.coords.latitude * 1e6) / 1e6; this.row['lng'] = Math.round(p.coords.longitude * 1e6) / 1e6;
        this.formErr.set(`Location set (±${Math.round(p.coords.accuracy)} m).`); },
      () => this.formErr.set('Cannot get your location. Allow location and try again.'), { enableHighAccuracy: true, timeout: 20000 });
  }
  async remove(c: TableCfg, r: Record<string, any>): Promise<void> {
    if (!(await this.ui.confirm({ title: 'Delete', message: `Delete ${r[c.cols[0].key]}?`, ok: 'Delete', tone: 'danger' }))) return;
    const { error } = await sb.from(c.table).delete().eq(c.pk, r[c.pk]);
    if (error) { this.error.set(error.message.includes('foreign key') ? 'It is still used by other records. Set it inactive instead.' : error.message); return; }
    this.ui.notify('Deleted.'); this.loadTable();
  }

  async saveForm(): Promise<void> {
    const f = this.form();
    if (!f) return;
    this.formErr.set(''); this.busy.set(true);
    try {
      if (f.kind === 'user') {
        const u = this.u;
        const body = { displayName: u.displayName, type: u.type, email: u.email.trim(), branchId: u.type === 'Branch' ? u.branchId : '',
          hqCodes: u.type === 'Branch' || u.type === 'Admin' || u.type === 'Finance' ? [] : u.hqCodes };
        if (u.type === 'HQ' && !u.hqCodes.length) throw new Error('Choose the headquarters of this account.');
        const msg = u.id ? await this.callUsers({ action: 'update', userId: u.id, ...body, active: u.active })
          : await this.callUsers({ action: 'create', username: u.username, password: u.password, ...body });
        this.ui.notify(msg);
        await this.loadBase();
      } else {
        const c = f.cfg!;
        const out: Record<string, any> = {};
        for (const col of c.cols) {
          let v = this.row[col.key];
          if (col.type === 'json') {
            try { v = JSON.parse(String(v ?? '').trim() || 'null'); } catch { throw new Error(`${col.label}: not valid JSON.`); }
          } else if (col.type === 'number') v = v === '' || v === null || v === undefined ? null : Number(v);
          else if (col.type === 'select' || col.type === 'text') v = typeof v === 'string' ? (v.trim() === '' ? null : v.trim()) : v;
          if (col.required && (v === null || v === undefined || v === '')) throw new Error(`Enter the ${col.label.toLowerCase()}.`);
          if (col.keyCol && !f.isNew) continue;
          out[col.key] = v;
        }
        if (c.id === 'fridges' && out['kind'] === 'HQ') out['branch_id'] = null;
        if (f.isNew) {
          const { data, error } = await sb.from(c.table).insert(out).select().single();
          if (error) throw new Error(error.message);
          if (c.afterInsert) await c.afterInsert(data as Record<string, any>).catch(() => {});
        } else {
          const { error } = await sb.from(c.table).update(out).eq(c.pk, f.orig![c.pk]);
          if (error) throw new Error(error.message);
        }
        this.ui.notify('Saved.');
        await this.loadTable();
        if (c.id === 'branches' || c.id === 'hqs') await this.loadBase();
      }
      this.form.set(null);
    } catch (e) { this.formErr.set(errMsg(e)); }
    finally { this.busy.set(false); }
  }

  /* ---------- outbox, log, backup ---------- */
  async loadOutbox(): Promise<void> {
    try { this.outbox.set(await rows(sb.from('email_outbox').select('id, to_addr, cc_addr, subject, created_at, sent_at, attempts, error').order('id', { ascending: false }).limit(300))); }
    catch (e) { this.error.set(errMsg(e)); }
  }
  async loadLog(): Promise<void> {
    try { this.log.set(await rows(sb.from('login_log').select('*').order('id', { ascending: false }).limit(300))); }
    catch (e) { this.error.set(errMsg(e)); }
  }
  async exportAll(): Promise<void> {
    this.busy.set(true); this.error.set('');
    try {
      const d = await rpc('admin_export');
      downloadText(`rbabc-portal-backup-${todayIso()}.json`, JSON.stringify({ exportedAt: new Date().toISOString(), by: this.auth.profile()?.username, tables: d }), 'application/json');
    } catch (e) { this.error.set(errMsg(e)); }
    finally { this.busy.set(false); }
  }
}
