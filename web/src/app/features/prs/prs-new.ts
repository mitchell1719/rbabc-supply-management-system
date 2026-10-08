import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { AuthService } from '../../core/auth.service';
import { errMsg, rows, rpc, sb } from '../../core/supabase';
import { UiService } from '../../core/ui.service';
import { todayIso } from '../../shared/format';

interface Line { qty: string; unit: string; desc: string; remarks: string; }

@Component({
  selector: 'app-prs-new',
  imports: [FormsModule],
  template: `
  <form class="card" (ngSubmit)="submit()">
    <h4>New Purchase Requisition Slip</h4>
    <p class="sub">{{ auth.profile()?.branchName }} — your RNS is notified by e-mail and reviews it before it goes to your HQ.</p>
    <div class="grid3">
      <div><label for="d">PRS date</label><input id="d" name="d" type="date" [(ngModel)]="date" [max]="today" required></div>
      <div><label for="dep">Department</label><input id="dep" name="dep" [(ngModel)]="dept" placeholder="e.g. ABC / Clinic"></div>
      <div><label for="pb">Prepared by</label><input id="pb" name="pb" [(ngModel)]="preparedBy" required></div>
    </div>
    <datalist id="itemNames">@for (n of names(); track n) { <option [value]="n"></option> }</datalist>
    <div class="tbl" style="margin-top:14px"><table class="t">
      <tr><th>#</th><th>Quantity</th><th>Unit</th><th>Description</th><th>Remarks</th><th></th></tr>
      @for (l of lines; track $index) {
        <tr><td>{{ $index + 1 }}</td>
          <td style="width:100px"><input type="number" min="0" step="any" [(ngModel)]="l.qty" [name]="'q' + $index"></td>
          <td style="width:110px"><input [(ngModel)]="l.unit" [name]="'u' + $index" placeholder="vial"></td>
          <td><input [(ngModel)]="l.desc" [name]="'d' + $index" list="itemNames" placeholder="Item description"></td>
          <td><input [(ngModel)]="l.remarks" [name]="'r' + $index"></td>
          <td><button type="button" class="btn sm outline-red" (click)="remove($index)" aria-label="Remove">×</button></td></tr>
      }
    </table></div>
    <button type="button" class="btn sm" style="margin-top:8px" (click)="lines.push(blank())">+ Add item</button>
    <div class="grid2" style="margin-top:14px">
      <div><label for="rm">Remarks</label><textarea id="rm" name="rm" [(ngModel)]="remarks"></textarea></div>
      <div><label for="ph">Scanned PRS / photo (optional)</label><input id="ph" type="file" accept="image/*,application/pdf" (change)="photo = $any($event.target).files?.[0] ?? null"></div>
    </div>
    <div class="btns end" style="margin-top:14px">
      <button type="button" class="btn" (click)="router.navigateByUrl('/prs')">Cancel</button>
      <button type="submit" class="btn danger" [disabled]="busy()">Submit to RNS</button>
    </div>
    <div class="flash err" style="margin-top:8px">{{ error() }}</div>
  </form>`,
})
export class PrsNew {
  readonly auth = inject(AuthService);
  readonly router = inject(Router);
  private ui = inject(UiService);
  readonly today = todayIso();
  date = this.today;
  dept = '';
  preparedBy = this.auth.profile()?.fullName ?? '';
  remarks = '';
  photo: File | null = null;
  lines: Line[] = [this.blank(), this.blank(), this.blank()];
  readonly names = signal<string[]>([]);
  readonly busy = signal(false);
  readonly error = signal('');

  constructor() {
    rows<{ name: string }>(sb.from('sc_items').select('name').eq('active', true).order('name')).then((r) => this.names.set(r.map((x) => x.name))).catch(() => {});
  }

  blank(): Line { return { qty: '', unit: '', desc: '', remarks: '' }; }
  remove(i: number): void { this.lines.splice(i, 1); if (!this.lines.length) this.lines.push(this.blank()); }

  async submit(): Promise<void> {
    this.busy.set(true); this.error.set('');
    try {
      let photoPath = '';
      if (this.photo) {
        if (this.photo.size > 10 * 1024 * 1024) throw new Error('The photo must be 10 MB or smaller.');
        photoPath = `${this.auth.profile()!.branchId}/${Date.now()}-${this.photo.name.replace(/[^A-Za-z0-9._-]/g, '_').slice(-80)}`;
        const { error } = await sb.storage.from('prs').upload(photoPath, this.photo, { contentType: this.photo.type });
        if (error) throw new Error(error.message);
      }
      const res = await rpc('prs_create', { p: { prsDate: this.date, department: this.dept, preparedBy: this.preparedBy, remarks: this.remarks,
        photoPath, items: this.lines.map((l) => ({ qty: String(l.qty ?? ''), unit: l.unit, desc: l.desc, remarks: l.remarks })) } });
      this.ui.notify(res.msg);
      this.router.navigateByUrl('/prs');
    } catch (e) { this.error.set(errMsg(e)); }
    finally { this.busy.set(false); }
  }
}
