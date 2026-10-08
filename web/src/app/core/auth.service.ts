import { Injectable, computed, signal } from '@angular/core';
import { Router } from '@angular/router';
import { Profile, UserType } from './models';
import { errMsg, publicUrl, rpc, sb } from './supabase';

@Injectable({ providedIn: 'root' })
export class AuthService {
  readonly profile = signal<Profile | null>(null);
  readonly ready = signal(false);
  readonly type = computed<UserType | null>(() => this.profile()?.type ?? null);
  readonly photoUrl = computed(() => {
    const p = this.profile()?.photoPath;
    return p ? publicUrl('avatars', p) : '';
  });
  readonly name = computed(() => this.profile()?.fullName || this.profile()?.displayName || '');
  private loading: Promise<void> | null = null;

  constructor(private router: Router) {
    sb.auth.onAuthStateChange((event) => {
      if (event === 'SIGNED_OUT') { this.profile.set(null); }
    });
  }

  /** Loads the session (once) — used by the route guards. */
  init(): Promise<void> {
    if (!this.loading) {
      this.loading = (async () => {
        try {
          const { data } = await sb.auth.getSession();
          if (data.session) await this.reload();
        } catch {
          this.profile.set(null);
        } finally {
          this.ready.set(true);
        }
      })();
    }
    return this.loading;
  }

  async reload(): Promise<void> {
    const p = await rpc<Profile | null>('my_profile');
    if (!p) {
      await sb.auth.signOut();
      this.profile.set(null);
      throw new Error('This account is inactive or not set up. Please contact the Supply Office.');
    }
    this.profile.set(p);
  }

  async login(username: string, password: string): Promise<void> {
    const u = username.trim();
    if (!u) throw new Error('Enter your username.');
    const email = await rpc<string | null>('login_email', { p_username: u }).catch((e) => { throw new Error(errMsg(e)); });
    if (email === 'INACTIVE') throw new Error('This account is inactive. Please contact the Supply Office.');
    if (!email) throw new Error('Wrong username or password.');
    const { error } = await sb.auth.signInWithPassword({ email, password });
    if (error) {
      throw new Error(/invalid login/i.test(error.message) ? 'Wrong username or password.'
        : /rate|too many/i.test(error.message) ? 'Too many wrong attempts. Try again in a few minutes.' : error.message);
    }
    await this.reload();
    rpc('log_event', { p_result: 'SUCCESS' }).catch(() => {});
  }

  async logout(): Promise<void> {
    await sb.auth.signOut();
    this.profile.set(null);
    this.router.navigateByUrl('/login');
  }

  /** Checks the current password by signing in again, then sets the new one. */
  async changePassword(current: string, next: string, confirm: string): Promise<string> {
    if (next.length < 6) throw new Error('New password must be at least 6 characters.');
    if (next !== confirm) throw new Error('New passwords do not match.');
    if (next === current) throw new Error('Choose a password different from the current one.');
    const { data } = await sb.auth.getUser();
    const email = data.user?.email;
    if (!email) throw new Error('Session expired. Please log in again.');
    const check = await sb.auth.signInWithPassword({ email, password: current });
    if (check.error) throw new Error('Current password is wrong.');
    const { error } = await sb.auth.updateUser({ password: next });
    if (error) throw new Error(error.message);
    rpc('log_event', { p_result: 'PASSWORD CHANGED' }).catch(() => {});
    return 'Password changed. Use your new password next time you log in.';
  }

  is(...types: UserType[]): boolean {
    const t = this.type();
    return !!t && types.includes(t);
  }
}
