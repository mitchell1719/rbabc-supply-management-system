import { Component, inject, signal } from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { errMsg, rpc } from '../../core/supabase';
import { niceDate, niceStamp } from '../../shared/format';

interface PubItem { desc: string; forDesc: string | null; unit: string | null; batch: string | null; expiry: string | null; qty: number; rQty: number | null; condition: string | null; note: string | null; }
interface PubDn { no: string; branch: string; prs: string | null; date: string; mode: string | null; rider: string | null; preparedBy: string | null;
  rr: string | null; rDate: string | null; rBy: string | null; witness: string | null; validatedBy: string | null; validated: string | null;
  discrepancy: string | null; rRemarks: string | null; items: PubItem[]; }
interface PubSoa { no: string; dsm: string; hq: string; from: string | null; to: string | null; }

/** View-only DN & RR of an approved SOA — the link e-mailed to the DSM / OIC / RNS. No prices, no login. */
@Component({
  selector: 'app-soa-public',
  template: `
  <div class="pub">
    <div class="pub-head"><img src="logo.png" alt="" width="40" height="40"><div><b>RB ABC Supply Office</b><small>Delivery notes &amp; receiving reports (view only)</small></div>
      @if (soa()) { <button class="btn sm noprint" (click)="print()">Print / save as PDF</button> }</div>
    @if (loading()) { <div class="empty">Loading…</div> }
    @if (error()) { <div class="err-box">{{ error() }}</div> }
    @if (soa(); as s) {
      <div class="card">
        <h4>{{ s.no }}</h4>
        <p class="sub">{{ s.dsm }} · {{ s.hq }} HQ · {{ nice(s.from) }} to {{ nice(s.to) }} · {{ dns().length }} delivery note(s)</p>
      </div>
      @for (d of dns(); track d.no) {
        <div class="card dn">
          <div class="dn-h"><div><b>DN {{ d.no }}</b><small>{{ d.branch }} · delivered {{ nice(d.date) }}{{ d.prs ? ' · PRS ' + d.prs : '' }}</small></div>
            <div><b>RR {{ d.rr || '—' }}</b><small>{{ d.rDate ? 'received ' + nice(d.rDate) : 'not received yet' }}{{ d.rBy ? ' by ' + d.rBy : '' }}</small></div></div>
          <div class="tbl"><table class="t">
            <tr><th>Description</th><th>Unit</th><th>Batch No.</th><th>Expiry</th><th class="num">Qty sent</th><th class="num">Qty received</th><th>Condition</th></tr>
            @for (i of d.items; track $index) {
              <tr [class.short]="i.rQty !== null && +i.rQty !== +i.qty"><td>{{ i.desc }}@if (i.forDesc && i.forDesc !== i.desc) { <small>instead of {{ i.forDesc }}</small> }</td>
                <td>{{ i.unit }}</td><td>{{ i.batch }}</td><td>{{ nice(i.expiry) }}</td><td class="num">{{ i.qty }}</td><td class="num">{{ i.rQty ?? '—' }}</td>
                <td>{{ i.condition || '—' }}@if (i.note) { <small>{{ i.note }}</small> }</td></tr>
            }
          </table></div>
          <p class="meta">Sent by {{ sentBy(d) }} · prepared by {{ d.preparedBy || '—' }} · witness {{ d.witness || '—' }}
            @if (d.validatedBy) { · validated by {{ d.validatedBy }} {{ stamp(d.validated) }} }</p>
          @if (d.discrepancy) { <p class="meta bad">Discrepancy: {{ d.discrepancy }}</p> }
          @if (d.rRemarks) { <p class="meta">Remarks: {{ d.rRemarks }}</p> }
        </div>
      }
    }
  </div>`,
  styles: [`
    .pub{max-width:980px;margin:0 auto;padding:18px 14px 40px}
    .pub-head{display:flex;align-items:center;gap:12px;margin-bottom:14px}.pub-head b{display:block;font-size:17px}.pub-head small{color:var(--mute)}.pub-head button{margin-left:auto}
    .dn{margin-top:12px}.dn-h{display:flex;justify-content:space-between;gap:16px;flex-wrap:wrap;margin-bottom:8px}.dn-h small{display:block;color:var(--mute);font-size:12.5px}
    .meta{font-size:12.5px;color:var(--mute);margin:8px 0 0}.meta.bad{color:var(--red-dark)}
    @media print{.noprint{display:none}.dn{break-inside:avoid}}
  `],
})
export class SoaPublic {
  private route = inject(ActivatedRoute);
  readonly soa = signal<PubSoa | null>(null);
  readonly dns = signal<PubDn[]>([]);
  readonly loading = signal(true);
  readonly error = signal('');
  readonly nice = niceDate;
  readonly stamp = niceStamp;

  constructor() { this.load(); }

  private async load(): Promise<void> {
    const q = this.route.snapshot.queryParamMap;
    const no = q.get('soa') ?? '', key = q.get('k') ?? '';
    try {
      if (!no || !key) throw new Error('This link is not valid. Ask the Supply Office for a new link.');
      const r = await rpc<{ ok: boolean; msg?: string; soa?: PubSoa; dns?: PubDn[] }>('soa_public', { p_no: no, p_key: key });
      if (!r.ok) throw new Error(r.msg);
      this.soa.set(r.soa!); this.dns.set(r.dns ?? []);
      document.title = r.soa!.no + ' — DN & RR';
    } catch (e) { this.error.set(errMsg(e)); }
    finally { this.loading.set(false); }
  }

  sentBy(d: PubDn): string { return [d.mode, d.rider].filter((x) => !!x).join(' — ') || '—'; }
  print(): void { window.print(); }
}
