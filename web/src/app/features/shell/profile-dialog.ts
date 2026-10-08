import { LOGO } from '../../shared/brand';
import { Component, inject, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { AuthService } from '../../core/auth.service';
import { errMsg, rpc, sb } from '../../core/supabase';
import { Profile } from '../../core/models';

@Component({
  selector: 'app-profile-dialog',
  imports: [FormsModule],
  template: `
  <div class="overlay" (mousedown)="$event.target === $event.currentTarget && closed.emit()">
    <form class="modal narrow" (ngSubmit)="save()">
      <div class="modal-bar"><b>My profile</b></div>
      <div class="photo">
        <span class="avatar"><img [src]="preview() || logo" [class.def]="!preview()" alt=""></span>
        <div class="btns">
          <button type="button" class="btn sm" (click)="file.click()">Upload photo</button>
          <button type="button" class="btn sm outline-red" (click)="removePhoto()">Remove photo</button>
          <input #file type="file" accept="image/*" class="hidden" (change)="pick($event)">
        </div>
      </div>
      <p class="sub">Account: {{ p.username }} · {{ p.type }}{{ p.hqNames.length ? ' · ' + p.hqNames.join(', ') : '' }}</p>
      <label for="pfName">Full name</label><input id="pfName" name="fn" [(ngModel)]="f.fullName" required maxlength="120" placeholder="e.g. Maria Santos, RN">
      <label for="pfPos" style="margin-top:10px">Position</label><input id="pfPos" name="pos" [(ngModel)]="f.position" maxlength="120">
      <label for="pfC" style="margin-top:10px">Contact number</label><input id="pfC" name="c" [(ngModel)]="f.contact" maxlength="20">
      <label for="pfE" style="margin-top:10px">Email (for notifications)</label><input id="pfE" name="e" type="email" [(ngModel)]="f.email" maxlength="120">
      @if (p.rns) { <div class="info-box" style="margin-top:12px"><b>Your RNS:</b> {{ p.rns.name }}{{ p.rns.email ? ' · ' + p.rns.email : '' }}</div> }
      <div class="btns end" style="margin-top:16px">
        <button type="button" class="btn" (click)="closed.emit()">Close</button>
        <button type="submit" class="btn pri" [disabled]="busy()">Save profile</button>
      </div>
      <div class="flash" [class.ok]="ok()" [class.err]="!ok()" style="margin-top:10px">{{ msg() }}</div>
    </form>
  </div>`,
  styles: [`.photo{display:flex;align-items:center;gap:16px;margin-bottom:8px}
    .avatar{width:84px;height:84px;border-radius:50%;background:var(--pri-soft);color:var(--pri);display:inline-flex;align-items:center;justify-content:center;font-weight:700;font-size:26px;overflow:hidden;border:3px solid var(--pri)}
    .avatar img{width:100%;height:100%;object-fit:cover}`],
})
export class ProfileDialog {
  private auth = inject(AuthService);
  readonly closed = output<void>();
  readonly p: Profile = this.auth.profile()!;
  f = { fullName: this.p.fullName ?? '', position: this.p.position ?? '', contact: this.p.contact ?? '', email: this.p.email ?? '' };
  readonly preview = signal(this.auth.photoUrl());
  readonly busy = signal(false);
  readonly msg = signal('');
  readonly ok = signal(false);
  private photo: Blob | null = null;
  private photoRemoved = false;
  readonly logo = LOGO;

  pick(e: Event): void {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file || !/^image\//.test(file.type)) { this.msg.set('Please choose an image file.'); return; }
    const img = new Image();
    img.onload = () => {
      const size = 240, c = document.createElement('canvas');
      c.width = size; c.height = size;
      const side = Math.min(img.width, img.height);
      const g = c.getContext('2d')!;
      g.fillStyle = '#fff'; g.fillRect(0, 0, size, size);
      g.drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, 0, 0, size, size);
      c.toBlob((b) => { if (b) { this.photo = b; this.photoRemoved = false; this.preview.set(URL.createObjectURL(b)); } }, 'image/jpeg', 0.85);
      URL.revokeObjectURL(img.src);
    };
    img.src = URL.createObjectURL(file);
  }

  removePhoto(): void { this.photo = null; this.photoRemoved = true; this.preview.set(''); }

  async save(): Promise<void> {
    this.busy.set(true); this.msg.set('');
    try {
      const payload: Record<string, unknown> = { ...this.f };
      if (this.photo) {
        const path = `${this.p.id}/photo-${Date.now()}.jpg`;
        const { error } = await sb.storage.from('avatars').upload(path, this.photo, { contentType: 'image/jpeg', upsert: true });
        if (error) throw new Error(error.message);
        payload['photoPath'] = path;
      } else if (this.photoRemoved) {
        payload['photoPath'] = '';
      }
      const old = this.p.photoPath;
      const prof = await rpc<Profile>('profile_save', { p: payload });
      if (old && old !== prof.photoPath) sb.storage.from('avatars').remove([old]).catch(() => {});
      this.auth.profile.set(prof);
      this.ok.set(true); this.msg.set('Profile saved.');
      setTimeout(() => this.closed.emit(), 900);
    } catch (e) {
      this.ok.set(false); this.msg.set(errMsg(e));
    } finally { this.busy.set(false); }
  }
}
