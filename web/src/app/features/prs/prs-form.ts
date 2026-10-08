import { Component, computed, inject, input, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { AuthService } from '../../core/auth.service';
import { errMsg, rows, rpc, sb, signedUrl } from '../../core/supabase';
import { UiService, escapeHtml } from '../../core/ui.service';
import { niceDate, niceStamp, printHtml, statusClass } from '../../shared/format';

interface Item { qty: string | number; unit: string; desc: string; remarks: string; }

@Component({
  selector: 'app-prs-form',
  imports: [FormsModule],
  template: `
  <div class="overlay" (mousedown)="$event.target === $event.currentTarget && closed.emit()">
    <div class="modal">
      <div class="modal-bar no-print"><b>Purchase Requisition Slip</b>
        <span class="btns"><button class="btn pri" (click)="print()" [disabled]="!f()">Print / Save PDF</button><button class="btn" (click)="closed.emit()">Close</button></span></div>
      @if (error()) { <div class="err-box">{{ error() }}</div> }
      @if (!f() && !error()) { <div class="empty"><span class="spin"></span> Opening PRS…</div> }
      @if (f(); as r) {
        <div class="slip">
          <div class="head"><b>RABIES BUSTER ANIMAL BITE CENTER</b><span>PURCHASE REQUISITION SLIP (PRS)</span></div>
          <div class="meta">
            <div><i>PRS Control No.</i> <b>{{ r.control_no }}</b></div><div><i>Status</i> <span [class]="'chip ' + cls(r.status)">{{ r.status }}</span></div>
            <div><i>Branch</i> <b>{{ r.branch_name }}</b></div><div><i>Assigned HQ</i> <b>{{ r.hq_name }}</b></div>
            <div><i>PRS Date</i> <b>{{ nice(r.prs_date) }}</b></div><div><i>Date submitted</i> <b>{{ stamp(r.submitted_at) }}</b></div>
            <div><i>Department</i> <b>{{ r.department || '—' }}</b></div><div><i>Date approved</i> <b>{{ stamp(r.date_approved) || '—' }}</b></div>
            <div><i>Date served</i> <b>{{ nice(r.date_served) || '—' }}</b></div><div><i>DN No.</i> <b>{{ r.dn_numbers.join(', ') || '—' }}</b></div>
          </div>
          @if (editing()) {
            <div class="tbl"><table class="t"><tr><th>#</th><th>Quantity</th><th>Unit</th><th>Description</th><th>Remarks</th><th></th></tr>
              @for (it of items; track $index) {
                <tr><td>{{ $index + 1 }}</td><td style="width:90px"><input type="number" min="0" step="any" [(ngModel)]="it.qty" [name]="'q' + $index"></td>
                  <td style="width:100px"><input [(ngModel)]="it.unit" [name]="'u' + $index" placeholder="vial"></td>
                  <td><input [(ngModel)]="it.desc" [name]="'d' + $index" placeholder="Item description"></td>
                  <td><input [(ngModel)]="it.remarks" [name]="'r' + $index"></td>
                  <td><button type="button" class="btn sm outline-red" (click)="items.splice($index, 1)" aria-label="Remove">×</button></td></tr>
              }
            </table></div>
            <button type="button" class="btn sm" style="margin-top:8px" (click)="items.push({ qty: '', unit: '', desc: '', remarks: '' })">+ Add item</button>
          } @else {
            <div class="tbl"><table class="t"><tr><th>#</th><th class="num">Quantity</th><th>Unit</th><th>Description</th><th>Remarks</th></tr>
              @for (it of items; track $index) { <tr><td>{{ $index + 1 }}</td><td class="num">{{ it.qty }}</td><td>{{ it.unit }}</td><td>{{ it.desc }}</td><td>{{ it.remarks }}</td></tr> }
              @empty { <tr><td colspan="5" class="empty">No line items.</td></tr> }
            </table></div>
            @if (r.remarks) { <p style="font-size:13px"><b>Remarks:</b> {{ r.remarks }}</p> }
          }
          @if (r.rns_action) {
            <div [class]="r.status === 'Returned for Correction' ? 'warn-box' : 'info-box'" style="margin-top:12px"><b>{{ r.rns_action }}</b>
              @if (r.sent_to_hq_at) { <br>Sent to {{ r.hq_name }} on {{ stamp(r.sent_to_hq_at) }} }
              @if (r.rns_note) { <br><b>Note from RNS:</b> {{ r.rns_note }} }</div>
          }
          @if (photoUrl()) { <p><a [href]="photoUrl()" target="_blank" rel="noopener">View scanned PRS / photo</a></p> }
          <div class="sign">
            <div><b>{{ r.prepared_by || ' ' }}</b><span>Prepared by (Personnel-in-Charge)</span></div>
            <div><b>{{ r.reviewed_by || ' ' }}</b><span>Reviewed by (Regional Nurse Supervisor)</span></div>
            <div><b>{{ r.approved_by || ' ' }}</b><span>Approved by (Regional Nurse Supervisor)</span></div>
          </div>
        </div>

        @if (canReview()) {
          <div class="wf no-print"><b>RNS review</b> — edit the items above if needed, then approve and send to {{ r.hq_name }}, or return it to the branch.
            <div class="grid2" style="margin-top:10px">
              <div><label>Department</label><input [(ngModel)]="dept"></div>
              <div><label>PRS remarks</label><input [(ngModel)]="remarks"></div>
              <div class="span-all"><label>Note to branch / HQ (required when returning)</label><textarea [(ngModel)]="note" placeholder="e.g. Reduced Abhayrab to 80 vials based on current stock"></textarea></div>
            </div>
            <div class="btns end" style="margin-top:10px">
              <button class="btn" [disabled]="busy()" (click)="review('save')">Save changes</button>
              <button class="btn outline-red" [disabled]="busy()" (click)="review('return')">Return to branch</button>
              <button class="btn pri" [disabled]="busy()" (click)="review('approve')">Approve &amp; send to HQ</button>
            </div>
          </div>
        }
        @if (canResubmit()) {
          <div class="wf no-print"><b>Returned by your RNS</b> — correct the items above as noted, then resubmit for review.
            <div class="grid2" style="margin-top:10px">
              <div><label>Department</label><input [(ngModel)]="dept"></div>
              <div><label>PRS remarks</label><input [(ngModel)]="remarks"></div>
              <div class="span-all"><label>Reply to your RNS — what did you correct? (required)</label><textarea [(ngModel)]="note"></textarea></div>
            </div>
            <div class="btns end" style="margin-top:10px"><button class="btn pri" [disabled]="busy()" (click)="resubmit()">Resubmit to RNS</button></div>
          </div>
        }
        <div class="flash" [class.ok]="ok()" [class.err]="!ok()">{{ msg() }}</div>
      }
    </div>
  </div>`,
  styles: [`
    .slip .head{text-align:center;border-bottom:3px solid var(--red);padding-bottom:10px;margin-bottom:14px}
    .slip .head b{display:block;color:var(--red);font-size:16px}.slip .head span{display:block;color:var(--blue);font-weight:700;font-size:14px}
    .meta{display:grid;grid-template-columns:1fr 1fr;gap:6px 18px;font-size:13px;margin-bottom:14px}
    .meta div{border-bottom:1px dashed var(--line);padding:4px 0}.meta i{font-style:normal;color:var(--mute);display:inline-block;min-width:118px}
    .sign{display:grid;grid-template-columns:repeat(3,1fr);gap:14px;margin-top:22px;text-align:center;font-size:12px}
    .sign b{display:block;border-bottom:1px solid var(--ink);padding:18px 4px 4px;font-size:13px}.sign span{color:var(--mute)}
    .wf{margin-top:14px;padding:12px 14px;border-radius:12px;background:var(--pri-soft);font-size:13px}
    @media(max-width:640px){.meta{grid-template-columns:1fr}}
  `],
})
export class PrsForm {
  private auth = inject(AuthService);
  private ui = inject(UiService);
  readonly prsId = input.required<string>();
  readonly closed = output<void>();
  readonly changed = output<void>();
  readonly f = signal<any>(null);
  readonly error = signal('');
  readonly msg = signal('');
  readonly ok = signal(false);
  readonly busy = signal(false);
  readonly photoUrl = signal('');
  items: Item[] = [];
  dept = ''; remarks = ''; note = '';
  readonly canReview = computed(() => this.auth.is('RNS', 'Admin') && ['Submitted', 'Under Review', 'Returned for Correction'].includes(this.f()?.status));
  readonly canResubmit = computed(() => this.auth.is('Branch') && this.f()?.status === 'Returned for Correction');
  readonly editing = computed(() => this.canReview() || this.canResubmit());
  readonly nice = niceDate;
  readonly stamp = niceStamp;
  readonly cls = statusClass;

  ngOnInit(): void { this.load(); }

  async load(): Promise<void> {
    try {
      const { data, error } = await sb.from('prs_v').select('*').eq('id', this.prsId()).maybeSingle();
      if (error) throw new Error(error.message);
      if (!data) throw new Error('You do not have access to this PRS.');
      const it = await rows<any>(sb.from('prs_items').select('*').eq('prs_id', this.prsId()).order('line_no'));
      this.items = it.map((x) => ({ qty: x.qty, unit: x.unit ?? '', desc: x.description, remarks: x.remarks ?? '' }));
      if (!this.items.length) this.items.push({ qty: '', unit: '', desc: '', remarks: '' });
      this.dept = data.department ?? ''; this.remarks = data.remarks ?? '';
      this.note = this.auth.is('Branch') ? '' : data.rns_note ?? '';
      if (data.photo_path) this.photoUrl.set(await signedUrl('prs', data.photo_path).catch(() => ''));
      this.f.set(data);
    } catch (e) { this.error.set(errMsg(e)); }
  }

  private payload() {
    return { dept: this.dept, remarks: this.remarks, note: this.note, reply: this.note,
      items: this.items.map((i) => ({ qty: String(i.qty ?? ''), unit: i.unit, desc: i.desc, remarks: i.remarks })) };
  }

  async review(action: 'save' | 'approve' | 'return'): Promise<void> {
    const r = this.f();
    if (action === 'return' && !this.note.trim()) { this.ok.set(false); this.msg.set('Write a note telling the branch what to correct.'); return; }
    if (action === 'approve' && !(await this.ui.confirm({ title: `Approve PRS ${r.control_no}?`, tone: 'ok', ok: 'Approve & send',
      html: `It will be sent to <b>${escapeHtml(r.hq_name)}</b> for serving.` }))) return;
    await this.run(() => rpc('prs_review', { p_id: r.id, p_action: action, p: this.payload() }));
  }

  async resubmit(): Promise<void> {
    if (!this.note.trim()) { this.ok.set(false); this.msg.set('Tell your RNS what you corrected.'); return; }
    if (!(await this.ui.confirm({ title: `Resubmit PRS ${this.f().control_no}?`, ok: 'Resubmit', message: 'It goes back to your RNS for review with your note.' }))) return;
    await this.run(() => rpc('prs_resubmit', { p_id: this.f().id, p: this.payload() }));
  }

  private async run(fn: () => Promise<any>): Promise<void> {
    this.busy.set(true); this.msg.set('');
    try {
      const res = await fn();
      this.ok.set(true); this.msg.set(res.msg);
      this.ui.notify(res.msg);
      this.changed.emit();
      this.f.set(null);
      await this.load();
    } catch (e) { this.ok.set(false); this.msg.set(errMsg(e)); }
    finally { this.busy.set(false); }
  }

  print(): void {
    const r = this.f(); if (!r) return;
    const h = escapeHtml;
    const items = this.items.map((it, i) => `<tr><td>${i + 1}</td><td style="text-align:center">${h(it.qty)}</td><td>${h(it.unit)}</td><td>${h(it.desc)}</td><td>${h(it.remarks)}</td></tr>`).join('');
    printHtml(`<!doctype html><html><head><meta charset="utf-8"><title>${h(r.control_no)}</title><style>
      body{font-family:Arial,sans-serif;color:#111;padding:24px;font-size:13px}h1{text-align:center;color:#C62828;font-size:17px;margin:0}
      h2{text-align:center;color:#1E3A8A;font-size:14px;margin:4px 0 16px;border-bottom:3px solid #C62828;padding-bottom:8px}
      .m{display:grid;grid-template-columns:1fr 1fr;gap:6px 18px;margin-bottom:14px}.m div{border-bottom:1px dashed #ccc;padding:3px 0}
      table{width:100%;border-collapse:collapse}th,td{border:1px solid #333;padding:5px 7px}th{background:#eee}
      .s{display:grid;grid-template-columns:repeat(3,1fr);gap:14px;margin-top:40px;text-align:center;font-size:12px}.s b{display:block;border-bottom:1px solid #111;padding:18px 4px 4px}</style></head><body>
      <h1>RABIES BUSTER ANIMAL BITE CENTER</h1><h2>PURCHASE REQUISITION SLIP (PRS)</h2>
      <div class="m"><div>PRS Control No.: <b>${h(r.control_no)}</b></div><div>Status: <b>${h(r.status)}</b></div>
      <div>Branch: <b>${h(r.branch_name)}</b></div><div>Assigned HQ: <b>${h(r.hq_name)}</b></div>
      <div>PRS Date: <b>${h(niceDate(r.prs_date))}</b></div><div>Department: <b>${h(r.department)}</b></div>
      <div>Date approved: <b>${h(niceStamp(r.date_approved))}</b></div><div>DN No.: <b>${h(r.dn_numbers.join(', '))}</b></div></div>
      <table><tr><th>#</th><th>Quantity</th><th>Unit</th><th>Description</th><th>Remarks</th></tr>${items}</table>
      ${r.remarks ? `<p><b>Remarks:</b> ${h(r.remarks)}</p>` : ''}
      <div class="s"><div><b>${h(r.prepared_by) || '&nbsp;'}</b>Prepared by (Personnel-in-Charge)</div><div><b>${h(r.reviewed_by) || '&nbsp;'}</b>Reviewed by (RNS)</div>
      <div><b>${h(r.approved_by) || '&nbsp;'}</b>Approved by (RNS)</div></div></body></html>`);
  }
}
