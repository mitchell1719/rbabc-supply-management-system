import { LOGO } from '../../shared/brand';
import { Component, ElementRef, OnDestroy, effect, inject, input, output, signal, viewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RealtimeChannel } from '@supabase/supabase-js';
import { AuthService } from '../../core/auth.service';
import { errMsg, publicUrl, rpc, sb, signedUrl } from '../../core/supabase';
import { UiService } from '../../core/ui.service';
import { niceStamp, shortBranch } from '../../shared/format';

interface Room { id: string; name: string; kind: 'group' | 'direct'; hint: string; sort: number; }
interface Msg { id: number; room_id: string; user_id: string | null; author: string; author_type: string | null; place: string | null;
  body: string; attachment: any; created_at: string; }

const EMOJI = ['😀','😂','😊','😍','🥰','😉','😎','🤔','😅','😢','😭','😡','🙏','👍','👎','👏','🙌','💪','👋','🤝','❤️','💙','🔥','🎉','✅','❌','⚠️','❗','❓','💉','💊','🩺','🏥','🚑','📦','🚚','📋','📝','📌','⏰','☕'];

@Component({
  selector: 'app-chat-drawer',
  imports: [FormsModule],
  template: `
  @if (open()) {
  <div class="chat" role="dialog" aria-label="Chats">
    <div class="ch"><div><b>Chats</b><small>Message your team</small></div><button type="button" (click)="closed.emit()" aria-label="Close">×</button></div>
    <div class="rooms">
      @for (r of rooms(); track r.id) {
        <button type="button" [class.on]="r.id === room()" [class.dm]="r.kind === 'direct'" (click)="openRoom(r.id)">
          {{ r.name }} @if (unreadOf(r.id)) { <span class="rdot">{{ unreadOf(r.id) }}</span> }
        </button>
      }
    </div>
    <div class="log" #log>
      @if (loading()) { <div class="gempty">Loading messages…</div> }
      @else if (!msgs().length) { <div class="gempty">No messages yet.<br>Start the conversation! 👋</div> }
      @for (m of msgs(); track m.id) {
        <div class="gmsg" [class.mine]="m.user_id === me">
          <span class="av"><img [src]="photo(m.user_id) || logo" [class.def]="!photo(m.user_id)" alt=""></span>
          <div>
            <div class="who"><b>{{ m.user_id === me ? 'You' : m.author }}</b>
              @if (m.author_type) { <span class="tag">{{ tag(m) }}</span> } · {{ stamp(m.created_at) }}</div>
            @if (m.body) { <div class="bub">{{ m.body }}</div> }
            @if (m.attachment; as a) {
              @if (a.kind === 'call') { <div class="att call"><span>📹 Video call</span><a [href]="a.url" target="_blank" rel="noopener">Join</a></div> }
              @else if (a.kind === 'image') { <a class="att img" [href]="fileUrl(a.path)" target="_blank" rel="noopener"><img [src]="fileUrl(a.path)" [alt]="a.name"></a> }
              @else { <a class="att file" [href]="fileUrl(a.path)" target="_blank" rel="noopener">📄 {{ a.name }}</a> }
            }
          </div>
        </div>
      }
    </div>
    @if (emojiOpen()) {
      <div class="emoji">@for (e of emoji; track e) { <button type="button" (click)="text = text + e">{{ e }}</button> }</div>
    }
    @if (pending(); as pf) { <div class="pend">📎 {{ pf.name }} <button type="button" (click)="pending.set(null)">×</button></div> }
    <form (ngSubmit)="send()" autocomplete="off">
      <button type="button" class="tool" (click)="emojiOpen.set(!emojiOpen())" title="Emoji">😊</button>
      <button type="button" class="tool" (click)="file.click()" title="Attach a picture or file (up to 10 MB)">📎</button>
      <button type="button" class="tool" (click)="call()" title="Start a video call">📹</button>
      <input #file type="file" class="hidden" (change)="pick($event)">
      <input name="t" [(ngModel)]="text" [placeholder]="hint()" maxlength="500">
      <button type="submit" class="send" [disabled]="sending()">Send</button>
    </form>
  </div>
  }`,
  styles: [`
    .chat{position:fixed;right:18px;bottom:18px;z-index:80;width:400px;max-width:calc(100vw - 32px);height:min(660px,calc(100vh - 36px));background:#fff;border-radius:18px;box-shadow:0 12px 40px rgba(0,0,0,.25);display:flex;flex-direction:column;overflow:hidden}
    .ch{background:var(--navy);color:#fff;padding:12px 14px;display:flex;align-items:center;border-bottom:4px solid var(--red)}
    .ch b{display:block}.ch small{opacity:.8;font-size:12px}
    .ch button{margin-left:auto;background:none;border:0;color:#fff;font-size:24px;cursor:pointer}
    .rooms{display:flex;gap:6px;padding:8px 10px;border-bottom:1px solid var(--line);overflow-x:auto;flex:none}
    .rooms button{flex:none;border:1px solid var(--line);background:#fff;font:inherit;font-size:12.5px;padding:5px 11px;border-radius:999px;cursor:pointer;white-space:nowrap}
    .rooms button.dm{background:var(--pri-soft);border-color:transparent;color:var(--pri-dark)}
    .rooms button.on{background:var(--navy);color:#fff;border-color:var(--navy)}
    .rdot{display:inline-block;min-width:18px;padding:0 5px;border-radius:9px;background:var(--red);color:#fff;font-size:11px;margin-left:4px}
    .log{flex:1;min-height:0;overflow-y:auto;padding:14px;background:var(--bg);display:flex;flex-direction:column;gap:10px}
    .gempty{margin:auto;color:var(--mute);font-size:13px;text-align:center}
    .gmsg{display:flex;gap:8px;align-items:flex-end;max-width:92%}
    .gmsg.mine{align-self:flex-end;flex-direction:row-reverse}
    .av{width:28px;height:28px;border-radius:50%;flex:none;background:var(--pri-soft);color:var(--pri);font-size:11px;font-weight:700;display:flex;align-items:center;justify-content:center;overflow:hidden}
    .av img{width:100%;height:100%;object-fit:cover}
    .who{font-size:11px;color:var(--mute);margin:0 4px 2px}.gmsg.mine .who{text-align:right}.who b{color:var(--blue)}
    .tag{font-size:10px;padding:0 6px;border-radius:8px;background:var(--red-soft);color:var(--red-dark);margin-left:4px}
    .bub{background:#fff;border:1px solid var(--line);border-radius:14px;border-bottom-left-radius:4px;padding:7px 11px;font-size:13.5px;line-height:1.4;white-space:pre-wrap;word-wrap:break-word}
    .gmsg.mine .bub{background:var(--pri);color:#fff;border-color:var(--pri);border-bottom-left-radius:14px;border-bottom-right-radius:4px}
    .att{display:block;margin-top:4px;max-width:240px}
    .att.img img{max-width:240px;max-height:240px;border-radius:12px;border:1px solid var(--line)}
    .att.file{padding:8px 10px;border:1px solid var(--line);border-radius:12px;background:#fff;font-size:12.5px;text-decoration:none;color:var(--ink)}
    .att.call{display:flex;justify-content:space-between;gap:12px;padding:8px 10px;border-radius:12px;background:var(--ok-soft);color:var(--ok);font-weight:600;font-size:13px}
    .att.call a{background:var(--ok);color:#fff;text-decoration:none;padding:4px 12px;border-radius:999px}
    .emoji{display:grid;grid-template-columns:repeat(auto-fill,minmax(34px,1fr));padding:6px 8px;border-top:1px solid var(--line);max-height:120px;overflow-y:auto}
    .emoji button{border:0;background:none;font-size:20px;cursor:pointer;padding:4px 0}
    .pend{padding:6px 12px;border-top:1px solid var(--line);font-size:12.5px;background:#F6F8FF}
    .pend button{border:0;background:none;color:var(--red);font-size:18px;cursor:pointer}
    form{display:flex;gap:4px;padding:10px;border-top:1px solid var(--line);align-items:center}
    form input[name=t]{flex:1;min-width:0;border-radius:20px}
    .tool{border:0;background:none;font-size:18px;cursor:pointer;padding:4px}
    .send{border:0;background:var(--pri);color:#fff;border-radius:20px;padding:9px 14px;font:inherit;font-weight:600;cursor:pointer}
    @media(max-width:520px){.chat{right:8px;left:8px;width:auto;bottom:8px;height:calc(100vh - 16px)}}
  `],
})
export class ChatDrawer implements OnDestroy {
  private auth = inject(AuthService);
  private ui = inject(UiService);
  readonly open = input(false);
  readonly closed = output<void>();
  readonly unreadChange = output<number>();
  readonly rooms = signal<Room[]>([]);
  readonly room = signal('all');
  readonly msgs = signal<Msg[]>([]);
  readonly loading = signal(false);
  readonly sending = signal(false);
  readonly emojiOpen = signal(false);
  readonly pending = signal<File | null>(null);
  readonly unread = signal<Record<string, number>>({});
  readonly emoji = EMOJI;
  readonly me = this.auth.profile()?.id ?? '';
  text = '';
  private log = viewChild<ElementRef<HTMLDivElement>>('log');
  private channel: RealtimeChannel | null = null;
  private photos: Record<string, string> = {};
  private urls: Record<string, string> = {};
  readonly logo = LOGO;
  readonly stamp = niceStamp;

  constructor() {
    this.start();
    effect(() => { if (this.open()) { this.markSeen(this.room()); this.scroll(); } });
  }

  ngOnDestroy(): void { if (this.channel) sb.removeChannel(this.channel); }

  private seenKey(r: string): string { return `rbabc-chat-seen:${this.me}:${r}`; }
  private seen(r: string): number { try { return Number(localStorage.getItem(this.seenKey(r)) ?? 0); } catch { return 0; } }
  private setSeen(r: string, id: number): void { try { localStorage.setItem(this.seenKey(r), String(id)); } catch { /* private mode */ } }

  private async start(): Promise<void> {
    try {
      this.rooms.set(await rpc<Room[]>('my_chat_rooms'));
      const users = await sb.from('user_directory').select('id, photo_path');
      for (const u of users.data ?? []) if (u.photo_path) this.photos[u.id] = publicUrl('avatars', u.photo_path);
      const counts: Record<string, number> = {};
      await Promise.all(this.rooms().map(async (r) => {
        const s = this.seen(r.id);
        if (!s) {   // first time: older messages count as read
          const last = await sb.from('chat_messages').select('id').eq('room_id', r.id).order('id', { ascending: false }).limit(1);
          this.setSeen(r.id, last.data?.[0]?.id ?? 0);
          return;
        }
        const { count } = await sb.from('chat_messages').select('id', { count: 'exact', head: true }).eq('room_id', r.id).gt('id', s);
        if (count) counts[r.id] = count;
      }));
      this.unread.set(counts);
      this.emitUnread();
      await this.load();
      this.channel = sb.channel('chat-' + this.me)
        .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'chat_messages' }, (p) => this.incoming(p.new as Msg))
        .subscribe();
    } catch (e) {
      console.warn('chat:', errMsg(e));
    }
  }

  private incoming(m: Msg): void {
    if (m.room_id === this.room()) {
      if (!this.msgs().some((x) => x.id === m.id)) this.msgs.update((l) => [...l, m]);
      if (this.open()) { this.markSeen(m.room_id); this.scroll(); return; }
    }
    if (m.user_id === this.me) return;
    this.unread.update((u) => ({ ...u, [m.room_id]: (u[m.room_id] ?? 0) + 1 }));
    this.emitUnread();
  }

  private emitUnread(): void { this.unreadChange.emit(Object.values(this.unread()).reduce((a, b) => a + b, 0)); }

  private markSeen(r: string): void {
    const last = this.msgs().filter((m) => m.room_id === r).at(-1);
    if (last) this.setSeen(r, last.id);
    if (this.unread()[r]) { this.unread.update((u) => ({ ...u, [r]: 0 })); this.emitUnread(); }
  }

  private async load(): Promise<void> {
    this.loading.set(true);
    const r = this.room();
    const { data, error } = await sb.from('chat_messages').select('*').eq('room_id', r).order('id', { ascending: false }).limit(150);
    this.loading.set(false);
    if (error) { this.ui.notify(errMsg(error), 'err'); return; }
    if (r !== this.room()) return;
    this.msgs.set((data ?? []).reverse());
    if (this.open()) this.markSeen(r);
    this.scroll();
  }

  openRoom(id: string): void { this.room.set(id); this.load(); }
  unreadOf(id: string): number { return id === this.room() && this.open() ? 0 : this.unread()[id] ?? 0; }
  hint(): string { return this.rooms().find((r) => r.id === this.room())?.hint ?? 'Message…'; }
  photo(id: string | null): string { return id ? this.photos[id] ?? '' : ''; }
  tag(m: Msg): string { return m.author_type === 'Branch' ? shortBranch(m.place) : m.author_type === 'HQ' ? (m.place ?? '') + ' SO' : m.author_type ?? ''; }

  fileUrl(path: string): string {
    if (!this.urls[path]) {
      this.urls[path] = '';
      signedUrl('chat', path, 3600).then((u) => { this.urls[path] = u; this.msgs.update((l) => [...l]); }).catch(() => {});
    }
    return this.urls[path];
  }

  private scroll(): void { setTimeout(() => { const el = this.log()?.nativeElement; if (el) el.scrollTop = el.scrollHeight; }, 30); }

  pick(e: Event): void {
    const input = e.target as HTMLInputElement;
    const f = input.files?.[0];
    input.value = '';
    if (!f) return;
    if (f.size > 10 * 1024 * 1024) { this.ui.alert('Files can be up to 10 MB.'); return; }
    this.pending.set(f);
  }

  async call(): Promise<void> {
    const name = this.rooms().find((r) => r.id === this.room())?.name ?? 'this chat';
    const yes = await this.ui.confirm({ title: 'Start a video call?', ok: 'Start call',
      message: `A video call link is posted in ${name} so everyone here can join. It opens in a new browser tab (Jitsi Meet — allow the camera and microphone).` });
    if (!yes) return;
    await this.post('', { kind: 'call' }, true);
  }

  async send(): Promise<void> {
    const body = this.text.trim();
    const f = this.pending();
    if (!body && !f) return;
    let att: any = null;
    this.sending.set(true);
    try {
      if (f) {
        const folder = this.room().replace(/[^A-Za-z0-9]/g, '_');
        const path = `${folder}/${Date.now()}-${f.name.replace(/[^A-Za-z0-9._-]/g, '_').slice(-80)}`;
        const { error } = await sb.storage.from('chat').upload(path, f, { contentType: f.type || 'application/octet-stream' });
        if (error) throw new Error(error.message);
        att = { kind: /^image\//.test(f.type) ? 'image' : 'file', path, name: f.name, mime: f.type, size: f.size };
      }
      await this.post(body, att, false);
      this.text = ''; this.pending.set(null); this.emojiOpen.set(false);
    } catch (e) {
      this.ui.notify('Message not sent: ' + errMsg(e), 'err');
    } finally { this.sending.set(false); }
  }

  private async post(body: string, att: any, openCall: boolean): Promise<void> {
    const id = await rpc<number>('chat_post', { p_room: this.room(), p_body: body, p_attach: att });
    const { data } = await sb.from('chat_messages').select('*').eq('id', id).single();
    if (data) this.incoming(data as Msg);
    if (openCall && data?.attachment?.url) window.open(data.attachment.url, '_blank', 'noopener');
  }
}
