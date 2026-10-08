import { Component, inject, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { AuthService } from '../../core/auth.service';
import { errMsg } from '../../core/supabase';

@Component({
  selector: 'app-password-dialog',
  imports: [FormsModule],
  template: `
  <div class="overlay" (mousedown)="$event.target === $event.currentTarget && closed.emit()">
    <form class="modal narrow" (ngSubmit)="save()">
      <div class="modal-bar"><b>Change password</b></div>
      <label for="pc">Current password</label><input id="pc" name="pc" type="password" [(ngModel)]="current" required autocomplete="current-password">
      <label for="pn" style="margin-top:12px">New password</label><input id="pn" name="pn" type="password" [(ngModel)]="next" required minlength="6" autocomplete="new-password">
      <small class="muted">At least 6 characters.</small>
      <label for="pr" style="margin-top:12px">Confirm new password</label><input id="pr" name="pr" type="password" [(ngModel)]="confirm" required autocomplete="new-password">
      <div class="btns end" style="margin-top:16px">
        <button type="button" class="btn" (click)="closed.emit()">Cancel</button>
        <button type="submit" class="btn pri" [disabled]="busy()">Save new password</button>
      </div>
      <div class="flash" [class.ok]="ok()" [class.err]="!ok()" style="margin-top:10px">{{ msg() }}</div>
    </form>
  </div>`,
})
export class PasswordDialog {
  private auth = inject(AuthService);
  readonly closed = output<void>();
  current = ''; next = ''; confirm = '';
  readonly busy = signal(false);
  readonly msg = signal('');
  readonly ok = signal(false);

  async save(): Promise<void> {
    this.busy.set(true); this.msg.set('');
    try {
      this.msg.set(await this.auth.changePassword(this.current, this.next, this.confirm));
      this.ok.set(true);
      setTimeout(() => this.closed.emit(), 1500);
    } catch (e) {
      this.ok.set(false); this.msg.set(errMsg(e));
    } finally { this.busy.set(false); }
  }
}
