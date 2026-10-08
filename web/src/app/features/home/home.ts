import { Component, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { AuthService } from '../../core/auth.service';
import { errMsg, rows, sb } from '../../core/supabase';
import { niceDate, shortBranch, statusClass } from '../../shared/format';
import { PrsRow, queueFor } from '../prs/prs-queue';
import { Icon } from '../../shared/icon';

interface LinkRow { id: number; name: string; url: string; description: string | null; highlight: boolean; }

@Component({
  selector: 'app-home',
  imports: [RouterLink, Icon],
  template: `
  <section class="welcome">
    <div>
      <h2>{{ greet }}, {{ first() }}</h2>
      <p>{{ blurb() }}</p>
      <div class="btns">
        @if (auth.is('Branch')) { <a class="btn danger" routerLink="/prs-new">Submit a PRS</a> }
        @if (auth.is('RNS', 'Admin', 'HQ')) { <a class="btn pri" routerLink="/prs">{{ auth.is('HQ') ? 'PRS ready to serve' : 'Review PRS' }}</a> }
      </div>
    </div>
    <img src="logo.png" alt="" width="120" height="120">
  </section>

  @if (error()) { <div class="err-box" style="margin-top:14px">{{ error() }}</div> }

  @if (queue(); as q) {
    <div class="section">
      <h3>{{ q.title }} @if (q.rows.length) { <span class="chip bad">{{ q.rows.length }}</span> }</h3>
      <div class="tbl">
        @if (!loaded()) { <div class="empty"><span class="spin"></span> Loading…</div> }
        @else if (!q.rows.length) { <div class="empty">{{ q.empty }}</div> }
        @else {
          <table class="t"><tr><th>PRS Control No.</th><th>PRS Date</th>@if (!auth.is('Branch')) { <th>Branch</th> }<th class="num">Items</th><th>Status</th><th>Note</th></tr>
            @for (r of q.rows.slice(0, 12); track r.id) {
              <tr class="go" [routerLink]="'/prs'" [queryParams]="{ open: r.id }">
                <td><b>{{ r.control_no }}</b></td><td>{{ nice(r.prs_date) }}</td>
                @if (!auth.is('Branch')) { <td>{{ short(r.branch_name) }}</td> }
                <td class="num">{{ r.item_count }}</td><td><span class="chip" [class]="'chip ' + cls(r.status)">{{ r.status }}</span></td>
                <td><small>{{ r.rns_action }}{{ r.rns_note ? ' — ' + r.rns_note : '' }}</small></td></tr>
            }
          </table>
        }
      </div>
    </div>
  }

  <div class="section">
    <h3>PRS status</h3>
    <div class="stats">
      @for (s of counts(); track s.k) { <div class="stat"><b>{{ s.n }}</b>{{ s.k }}</div> }
      @if (loaded() && !counts().length) { <span class="muted">No PRS yet.</span> }
    </div>
  </div>

  <div class="section">
    <h3>Quick links</h3>
    @if (!links().length) { <p class="muted">No links set for your account yet.</p> }
    <div class="grid">
      @for (l of links(); track l.id) {
        <a class="lcard" [class.hl]="l.highlight" [href]="l.url" target="_blank" rel="noopener">
          <app-icon name="link" /><b>{{ l.name }}</b><span>{{ l.description }}</span></a>
      }
    </div>
  </div>`,
  styles: [`
    .welcome{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:14px;align-items:center;background:var(--bg);border-radius:22px;padding:24px 28px}
    .welcome h2{font-family:Fraunces,Georgia,serif;font-size:30px;margin:0 0 10px}
    .welcome p{margin:0 0 14px;color:var(--mute);font-size:14px;line-height:1.6;max-width:60ch}
    .stats{display:flex;flex-wrap:wrap;gap:8px}
    .stat{background:var(--bg);border-radius:14px;padding:10px 14px;font-size:13px}.stat b{font-size:16px;margin-right:6px;color:var(--blue)}
    .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:14px}
    .lcard{display:flex;flex-direction:column;gap:6px;min-height:120px;border-radius:18px;padding:18px;color:#fff;background:var(--pri);text-decoration:none}
    .lcard:nth-child(3n+2){background:var(--blue)} .lcard.hl{background:var(--red)}
    .lcard b{font-size:15px} .lcard span{font-size:12.5px;opacity:.85;line-height:1.45}
    @media(max-width:640px){.welcome{grid-template-columns:1fr}.welcome img{display:none}}
  `],
})
export class Home {
  readonly auth = inject(AuthService);
  readonly prs = signal<PrsRow[]>([]);
  readonly links = signal<LinkRow[]>([]);
  readonly loaded = signal(false);
  readonly error = signal('');
  readonly greet = (() => { const h = Number(new Date().toLocaleString('en-US', { timeZone: 'Asia/Manila', hour: 'numeric', hour12: false })); return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening'; })();
  readonly first = computed(() => {
    const p = this.auth.profile();
    if (p?.fullName) return p.fullName.replace(/^(Dr|Mr|Ms|Mrs)\.?\s+/i, '').split(/[\s,]+/)[0];
    return p?.type === 'Branch' ? shortBranch(p.displayName) : p?.displayName ?? '';
  });
  readonly blurb = computed(() => ({
    Branch: 'Log purchase requests, your daily vial wastage, the refrigerator temperature and your stock card from here.',
    RNS: 'Review and approve your branches’ PRS for HQ, and monitor their vial wastage, refrigerator temperatures, stock cards and deliveries.',
    HQ: 'Serve the PRS your RNS approved, prepare delivery notes, keep your inventory and log your HQ refrigerators.',
    Admin: 'Every HQ and branch in one view: PRS, deliveries, inventory, SOA, purchase orders, wastage and refrigerator logs.',
  } as Record<string, string>)[this.auth.type() ?? ''] ?? '');
  readonly queue = computed(() => queueFor(this.auth.type(), this.prs()));
  readonly counts = computed(() => {
    const m: Record<string, number> = {};
    for (const r of this.prs()) m[r.status] = (m[r.status] ?? 0) + 1;
    return Object.keys(m).sort((a, b) => m[b] - m[a]).map((k) => ({ k, n: m[k] }));
  });
  readonly nice = niceDate;
  readonly short = shortBranch;
  readonly cls = statusClass;

  constructor() { this.load(); }

  private async load(): Promise<void> {
    try {
      const [p, l] = await Promise.all([
        rows<PrsRow>(sb.from('prs_v').select('*').order('submitted_at', { ascending: false }).limit(1000)),
        rows<LinkRow>(sb.from('links').select('id, name, url, description, highlight').order('sort').order('name')),
      ]);
      this.prs.set(p); this.links.set(l);
    } catch (e) { this.error.set(errMsg(e)); }
    finally { this.loaded.set(true); }
  }
}
