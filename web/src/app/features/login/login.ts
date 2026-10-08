import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { AuthService } from '../../core/auth.service';
import { errMsg } from '../../core/supabase';

@Component({
  selector: 'app-login',
  imports: [FormsModule],
  template: `
  <div class="wrap">
    <div class="login">
      <div class="top">
        <div class="mark"><img src="logo.png" alt="" width="48" height="48"><span>Rabies Buster<br>Animal Bite Center</span></div>
        <h1>RB ABC Supply Office</h1>
        <p>Purchase requests, deliveries, inventory, stock cards, vial wastage and refrigerator logs for every Rabies Buster branch and headquarter, in one place.</p>
      </div>
      <form (ngSubmit)="submit()" autocomplete="on">
        <h2>Log in</h2>
        <p class="lsub">Use your branch, headquarter or RNS account.</p>
        <label for="u">Username</label>
        <input id="u" name="username" [(ngModel)]="username" autocapitalize="characters" autocomplete="username" required>
        <div class="hint">For example DANAO, CEBU HQ or RNS DALAPO</div>
        <label for="p" style="margin-top:12px">Password</label>
        <div class="pw">
          <input id="p" name="password" [type]="show() ? 'text' : 'password'" [(ngModel)]="password" autocomplete="current-password" required>
          <button type="button" (click)="show.set(!show())">{{ show() ? 'Hide' : 'Show' }}</button>
        </div>
        <button class="btn pri block" type="submit" [disabled]="busy()" style="margin-top:18px">
          @if (busy()) { <span class="spin"></span> } @else { Log in }
        </button>
        <div class="flash err" style="margin-top:12px">{{ error() }}</div>
      </form>
    </div>
    <footer>© 2026 <b>RB ABC Supply Department</b>. All rights reserved. Created by: <b>Mitchell Patotoy</b></footer>
  </div>`,
  styles: [`
    .wrap{min-height:100vh;display:flex;flex-direction:column;justify-content:center;padding:24px 16px}
    .login{max-width:880px;width:100%;margin:0 auto;display:grid;grid-template-columns:1.05fr 1fr;border-radius:28px;overflow:hidden;box-shadow:0 30px 60px -30px rgba(16,28,82,.45);background:#fff}
    .top{background:var(--navy);color:#fff;padding:40px 36px;display:flex;flex-direction:column;gap:14px}
    .mark{display:flex;align-items:center;gap:14px;font-size:13px;line-height:1.3}
    .mark img{background:#fff;border-radius:50%;padding:4px}
    h1{font-family:Fraunces,Georgia,serif;font-size:34px;line-height:1.1;font-weight:700;margin:6px 0 0}
    .top p{font-size:14px;line-height:1.6;opacity:.8;margin:0}
    form{padding:40px 36px}
    h2{font-family:Fraunces,Georgia,serif;font-size:28px}
    .lsub{margin:6px 0 18px;color:var(--mute);font-size:14px}
    .hint{font-size:12px;color:var(--mute);margin-top:6px}
    .pw{position:relative} .pw button{position:absolute;right:6px;top:6px;border:0;background:none;color:var(--pri);font-size:12px;cursor:pointer;padding:6px}
    footer{text-align:center;font-size:12px;color:var(--mute);padding:20px 0 0}
    @media(max-width:640px){.login{grid-template-columns:1fr}.top,form{padding:28px 24px}}
  `],
})
export class Login {
  private auth = inject(AuthService);
  private router = inject(Router);
  username = '';
  password = '';
  readonly show = signal(false);
  readonly busy = signal(false);
  readonly error = signal('');

  async submit(): Promise<void> {
    this.busy.set(true);
    this.error.set('');
    try {
      await this.auth.login(this.username, this.password);
      this.password = '';
      this.router.navigateByUrl('/');
    } catch (e) {
      this.error.set(errMsg(e));
    } finally {
      this.busy.set(false);
    }
  }
}
