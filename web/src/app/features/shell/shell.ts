import { Component, computed, inject, signal } from '@angular/core';
import { NavigationEnd, Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { filter } from 'rxjs';
import { AuthService } from '../../core/auth.service';
import { NAV } from '../../core/nav';
import { Icon } from '../../shared/icon';
import { initials } from '../../shared/format';
import { ProfileDialog } from './profile-dialog';
import { PasswordDialog } from './password-dialog';
import { ChatDrawer } from '../chat/chat-drawer';

@Component({
  selector: 'app-shell',
  imports: [RouterOutlet, RouterLink, RouterLinkActive, Icon, ProfileDialog, PasswordDialog, ChatDrawer],
  template: `
  <div class="app">
    <aside class="side no-print" [class.open]="menuOpen()">
      <div class="brand"><img src="logo.svg" alt="" width="44" height="44"><div>{{ auth.profile()?.title }}<small>Supply Office Management</small></div></div>
      <nav class="views" aria-label="Sections">
        @for (n of nav(); track n.path) {
          <a [routerLink]="'/' + n.path" routerLinkActive="on" (click)="menuOpen.set(false)"><app-icon [name]="n.icon" /><span>{{ n.label }}</span></a>
        }
      </nav>
      <div class="sidenav">
        <button type="button" (click)="showProfile.set(true)"><app-icon name="user" /><span>My profile</span></button>
        <button type="button" (click)="showPw.set(true)"><app-icon name="key" /><span>Change password</span></button>
        <button type="button" (click)="auth.logout()"><app-icon name="out" /><span>Log out</span></button>
      </div>
      <div class="acct"><div class="acct-row"><span>Account</span><b>{{ typeLabel() }}</b></div><small>{{ scope() }}</small></div>
    </aside>
    <main class="main">
      <div class="topbar no-print">
        <button type="button" class="menu" (click)="menuOpen.set(!menuOpen())" aria-label="Menu"><app-icon name="menu" /></button>
        <h1>{{ title() }}</h1>
        <span class="date">{{ today }}</span>
        <button type="button" class="chatbtn" (click)="chatOpen.set(!chatOpen())" title="Chats" aria-label="Open chats"><app-icon name="chat" />
          @if (unread()) { <span class="dot">{{ unread() > 99 ? '99+' : unread() }}</span> }</button>
        <button type="button" class="prof" (click)="showProfile.set(true)" title="My profile">
          <span class="avatar">@if (auth.photoUrl()) { <img [src]="auth.photoUrl()" alt=""> } @else { {{ init() }} }</span>
          <span class="pname">{{ auth.name() }}</span></button>
      </div>
      <router-outlet />
      <footer class="no-print">© 2026 <b>RB ABC Supply Department</b>. All rights reserved. Created by: <b>Mitchell Patotoy</b></footer>
    </main>
  </div>
  @if (showProfile()) { <app-profile-dialog (closed)="showProfile.set(false)" /> }
  @if (showPw()) { <app-password-dialog (closed)="showPw.set(false)" /> }
  <app-chat-drawer [open]="chatOpen()" (closed)="chatOpen.set(false)" (unreadChange)="unread.set($event)" />
  `,
  styles: [`
    .app{display:grid;grid-template-columns:262px minmax(0,1fr);min-height:100vh;max-width:1560px;margin:0 auto;padding:18px}
    .side{background:var(--navy);color:#fff;border-radius:28px 0 0 28px;padding:22px 40px 18px 16px;display:flex;flex-direction:column;gap:12px;position:sticky;top:18px;height:calc(100vh - 36px);overflow:hidden}
    .brand{display:flex;align-items:center;gap:12px;font-family:Fraunces,Georgia,serif;font-size:18px;line-height:1.15;font-weight:700}
    .brand img{background:#fff;border-radius:50%;padding:3px;flex:none}
    .brand small{display:block;font-family:Lexend,sans-serif;font-size:11px;font-weight:400;opacity:.65;margin-top:3px}
    .views{flex:1 1 auto;min-height:0;overflow-y:auto;display:flex;flex-direction:column;gap:2px;margin:8px -10px 0 -16px;padding:2px 10px 8px 16px;scrollbar-width:thin;scrollbar-color:rgba(255,255,255,.22) transparent}
    .views a,.sidenav button{display:flex;align-items:center;gap:12px;width:100%;border:0;background:none;border-radius:14px;color:rgba(255,255,255,.72);font:inherit;font-size:14px;font-weight:500;padding:10px 12px;cursor:pointer;text-align:left;text-decoration:none;position:relative}
    .views a:hover,.sidenav button:hover{background:rgba(255,255,255,.07);color:#fff}
    .views a.on{background:var(--pri);color:#fff;box-shadow:0 10px 20px -10px rgba(43,79,216,.9)}
    .views a.on::before{content:"";position:absolute;left:-16px;top:10px;bottom:10px;width:5px;border-radius:0 5px 5px 0;background:var(--red)}
    .sidenav{flex:none;border-top:1px solid rgba(255,255,255,.1);padding-top:10px;display:flex;flex-direction:column;gap:2px}
    .acct{flex:none;background:var(--navy-2);border-radius:16px;padding:12px 14px}
    .acct-row{display:flex;justify-content:space-between;gap:8px;font-size:12px;color:rgba(255,255,255,.65)} .acct-row b{color:#fff;font-weight:600}
    .acct small{font-size:11.5px;color:rgba(255,255,255,.6)}
    .main{background:#fff;border-radius:28px;margin-left:-28px;padding:22px 28px 0;min-width:0;position:relative;z-index:1;box-shadow:-18px 0 40px -28px rgba(16,28,82,.35)}
    .topbar{display:flex;align-items:center;gap:12px;margin-bottom:18px}
    .topbar h1{font-size:22px;font-weight:600;flex:1;min-width:0}
    .date{font-size:13px;color:var(--mute)}
    .menu{display:none;border:0;background:var(--bg);border-radius:10px;padding:8px;cursor:pointer}
    .chatbtn{position:relative;border:0;background:var(--pri-soft);color:var(--pri);border-radius:50%;width:42px;height:42px;display:flex;align-items:center;justify-content:center;cursor:pointer}
    .dot{position:absolute;top:-2px;right:-2px;min-width:18px;height:18px;border-radius:9px;background:var(--red);color:#fff;font-size:10.5px;font-weight:700;line-height:18px;text-align:center;padding:0 4px}
    .prof{display:flex;align-items:center;gap:8px;border:0;background:var(--bg);border-radius:26px;padding:4px 14px 4px 4px;cursor:pointer;font:inherit;font-size:13px;color:var(--ink)}
    .avatar{width:34px;height:34px;border-radius:50%;background:var(--pri-soft);color:var(--pri);display:inline-flex;align-items:center;justify-content:center;font-weight:700;font-size:12px;overflow:hidden}
    .avatar img{width:100%;height:100%;object-fit:cover}
    .pname{max-width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    footer{text-align:center;font-size:12px;color:var(--mute);padding:28px 0 22px;margin-top:30px;border-top:1px solid var(--line)}
    @media(max-width:900px){
      .app{display:block;padding:0}
      .side{position:fixed;left:0;top:0;bottom:0;z-index:60;width:270px;height:100vh;border-radius:0;transform:translateX(-100%);transition:transform .2s}
      .side.open{transform:none}
      .main{margin:0;border-radius:0;padding:14px 14px 0;box-shadow:none}
      .menu{display:inline-flex} .date,.pname{display:none}
    }
    @media print{.app{display:block;padding:0}.main{margin:0;padding:0;box-shadow:none}}
  `],
})
export class Shell {
  readonly auth = inject(AuthService);
  private router = inject(Router);
  readonly showProfile = signal(false);
  readonly showPw = signal(false);
  readonly chatOpen = signal(false);
  readonly menuOpen = signal(false);
  readonly unread = signal(0);
  readonly url = signal(this.router.url);
  readonly today = new Date().toLocaleDateString('en-US', { timeZone: 'Asia/Manila', weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });

  readonly nav = computed(() => {
    const t = this.auth.type();
    return NAV.filter((n) => t && n.roles.includes(t)).map((n) => ({ ...n, label: (t && n.labels?.[t]) || n.label }));
  });
  readonly title = computed(() => {
    const seg = this.url().split(/[/?#]/)[1] || 'home';
    return this.nav().find((n) => n.path === seg)?.label ?? (seg === 'prs-new' ? 'New purchase request' : 'Dashboard');
  });
  readonly typeLabel = computed(() => ({ Branch: 'Branch · Nurse', HQ: 'Headquarter', RNS: 'Regional Nurse Supervisor', Admin: 'Admin', Finance: 'Finance' } as Record<string, string>)[this.auth.type() ?? ''] ?? '');
  readonly scope = computed(() => {
    const p = this.auth.profile();
    if (!p) return '';
    if (p.type === 'Admin') return 'All HQs';
    if (p.type === 'Branch') return p.branchName ?? '';
    return p.hqNames.join(' · ');
  });
  readonly init = computed(() => initials(this.auth.name()));

  constructor() {
    this.router.events.pipe(filter((e) => e instanceof NavigationEnd)).subscribe((e) => this.url.set((e as NavigationEnd).urlAfterRedirects));
  }
}
