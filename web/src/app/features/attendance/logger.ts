import { Component, ElementRef, OnDestroy, computed, inject, signal, viewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { AuthService } from '../../core/auth.service';
import { errMsg, rows, rpc, sb } from '../../core/supabase';
import { UiService } from '../../core/ui.service';
import { niceDate, niceTime, todayIso } from '../../shared/format';

interface Emp { id: string; name: string; hq_code: string | null; }
interface Site { name: string; hq_code: string | null; lat: number | null; lng: number | null; radius: number; }
interface AttRow { id: number; work_date: string; time_in: string; time_out: string | null; hours: number | null; status: string; site: string; remarks: string | null; }
interface Mine { id: string; name: string; today: string; open: AttRow | null; recent: AttRow[]; }

const MAX_ACCURACY = 150;

function distance(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const r = (x: number) => x * Math.PI / 180;
  const a = Math.sin(r(lat2 - lat1) / 2) ** 2 + Math.cos(r(lat1)) * Math.cos(r(lat2)) * Math.sin(r(lng2 - lng1) / 2) ** 2;
  return Math.round(2 * 6371000 * Math.asin(Math.sqrt(a)));
}

/** HQ Attendance Logger: Supply Officers TIME IN / TIME OUT inside the HQ with GPS and a selfie. */
@Component({
  selector: 'app-attendance-logger',
  imports: [FormsModule],
  template: `
  <div class="at-grid">
    <section class="card at-main">
      <div class="clock"><b>{{ clock() }}</b><span>{{ dateText() }}</span></div>
      <label for="emp">Employee</label>
      <select id="emp" [ngModel]="empSel()" (ngModelChange)="pickEmp($event)">
        <option value="">Choose your name…</option>
        @for (e of mineEmps(); track e.id) { <option [value]="e.id">{{ e.name }} ({{ e.id }})</option> }
        @if (otherEmps().length) { <optgroup label="Other headquarters">@for (e of otherEmps(); track e.id) { <option [value]="e.id">{{ e.name }} ({{ e.id }}) · {{ e.hq_code }}</option> }</optgroup> }
        <option value="__other">Other — type Employee ID</option>
      </select>
      @if (empSel() === '__other') { <input [(ngModel)]="otherId" (change)="loadMine()" placeholder="Type Employee ID (e.g. RBSO-001)" style="margin-top:6px" autocomplete="off"> }
      @if (me(); as m) {
        <div class="state" [class.in]="!!m.open">{{ m.open ? m.name + ' is timed in since ' + time(m.open.time_in) + ' at ' + m.open.site : m.name + ' is not timed in today.' }}</div>
      }
      <label for="loc" style="margin-top:12px">Headquarters</label>
      <select id="loc" [(ngModel)]="siteName">@for (s of sites(); track s.name) { <option [value]="s.name">{{ s.name }}</option> }</select>
      <div class="gps" [class]="'gps ' + gps().cls">{{ gps().text }}</div>
      <div class="at-btns">
        <button type="button" class="at-btn in" [disabled]="!canLog() || !!me()?.open" (click)="start('IN')">TIME IN</button>
        <button type="button" class="at-btn out" [disabled]="!canLog() || !me()?.open" (click)="start('OUT')">TIME OUT</button>
      </div>
      <div [class]="'flash ' + (msg().ok ? 'ok' : 'err')" role="status">{{ msg().text }}</div>
      <p class="note">Log while you are inside the HQ. The official time is the server time when you submit.</p>
    </section>
    <section class="card">
      <h4>{{ me() ? me()!.name + ' — last 7 days' : 'My attendance' }}</h4>
      @if (!me()) { <div class="empty">Choose your name to see your time in and time out.</div> }
      @else {
        <div class="tbl"><table class="t"><tr><th>Date</th><th>Time in</th><th>Time out</th><th class="num">Hours</th><th>Status</th></tr>
          @for (r of me()!.recent; track r.id) {
            <tr><td>{{ nice(r.work_date) }}<small>{{ r.site }}</small></td><td>{{ time(r.time_in) }}</td><td>{{ r.time_out ? time(r.time_out) : '—' }}</td>
              <td class="num">{{ r.hours ?? '—' }}</td><td><span [class]="'chip ' + chip(r.status)">{{ r.status }}</span>@if (r.remarks) { <small>{{ r.remarks }}</small> }</td></tr>
          } @empty { <tr><td colspan="5" class="empty">No attendance in the last 7 days.</td></tr> }
        </table></div>
      }
    </section>
  </div>

  @if (cam()) {
    <div class="overlay" role="dialog" aria-modal="true" aria-label="Take a selfie">
      <div class="modal narrow">
        <div class="modal-bar"><b>Take a selfie — TIME {{ action }}</b></div>
        <div class="frame">
          <video #video playsinline autoplay muted [class.hidden]="!!shot()"></video>
          @if (shot()) { <img [src]="shot()" alt="Selfie preview"> }
        </div>
        <div class="flash err">{{ camMsg() }}</div>
        <div class="btns end">
          <button class="btn" (click)="closeCam()">Cancel</button>
          @if (!shot()) {
            <button class="btn" (click)="file.click()">Use camera app</button>
            <button class="btn pri" [disabled]="!streaming()" (click)="snap()">Capture</button>
          } @else {
            <button class="btn" (click)="retake()">Retake</button>
            <button class="btn pri" [disabled]="busy()" (click)="submit()">{{ busy() ? 'Submitting…' : 'Submit' }}</button>
          }
        </div>
      </div>
    </div>
  }
  <input #file type="file" accept="image/*" capture="user" class="hidden" (change)="fromFile($event)">`,
  styles: [`
    .at-grid{display:grid;grid-template-columns:minmax(0,420px) minmax(0,1fr);gap:14px;align-items:start}
    @media (max-width:900px){.at-grid{grid-template-columns:minmax(0,1fr)}}
    .clock{text-align:center;margin-bottom:12px}.clock b{display:block;font-size:40px;font-weight:600;color:var(--navy);font-variant-numeric:tabular-nums}.clock span{color:var(--mute);font-size:13px}
    .state{margin-top:8px;padding:8px 10px;border-radius:10px;background:var(--bg);font-size:13px}.state.in{background:var(--pri-soft);color:var(--pri-dark)}
    .gps{margin-top:8px;padding:8px 10px;border-radius:10px;font-size:12.5px;background:var(--bg);color:var(--mute)}
    .gps.ok{background:var(--ok-soft);color:var(--ok)}.gps.bad{background:var(--red-soft);color:var(--red-dark)}.gps.wait{background:var(--warn-soft);color:var(--warn-ink)}
    .at-btns{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin:14px 0 8px}
    .at-btn{border:0;border-radius:14px;padding:18px 10px;font:inherit;font-size:17px;font-weight:700;color:#fff;cursor:pointer;letter-spacing:.5px}
    .at-btn.in{background:var(--ok)}.at-btn.out{background:var(--red)}.at-btn:disabled{opacity:.4;cursor:not-allowed}
    .note{font-size:12px;color:var(--mute);margin:8px 0 0}
    .frame{background:#000;border-radius:14px;overflow:hidden;aspect-ratio:3/4;display:flex;align-items:center;justify-content:center}
    .frame video,.frame img{width:100%;height:100%;object-fit:cover;transform:scaleX(-1)}.frame img{transform:none}
  `],
})
export class AttendanceLogger implements OnDestroy {
  private auth = inject(AuthService);
  private ui = inject(UiService);
  readonly video = viewChild<ElementRef<HTMLVideoElement>>('video');
  readonly emps = signal<Emp[]>([]);
  readonly sites = signal<Site[]>([]);
  readonly empSel = signal('');
  otherId = '';
  siteName = '';
  readonly me = signal<Mine | null>(null);
  readonly pos = signal<{ lat: number; lng: number; acc: number } | null>(null);
  readonly gpsErr = signal('');
  readonly now = signal(new Date());
  readonly msg = signal<{ text: string; ok: boolean }>({ text: '', ok: true });
  readonly cam = signal(false);
  readonly streaming = signal(false);
  readonly shot = signal('');
  readonly camMsg = signal('');
  readonly busy = signal(false);
  action: 'IN' | 'OUT' = 'IN';
  private blob: Blob | null = null;
  private stream: MediaStream | null = null;
  private watchId: number | null = null;
  private timer: any;
  readonly nice = niceDate; readonly time = niceTime;

  readonly mineEmps = computed(() => this.emps().filter((e) => this.auth.profile()?.hqs.includes(e.hq_code ?? '')));
  readonly otherEmps = computed(() => this.emps().filter((e) => !this.auth.profile()?.hqs.includes(e.hq_code ?? '')));
  readonly clock = computed(() => this.now().toLocaleTimeString('en-US', { timeZone: 'Asia/Manila', hour: '2-digit', minute: '2-digit', second: '2-digit' }));
  readonly dateText = computed(() => this.now().toLocaleDateString('en-US', { timeZone: 'Asia/Manila', weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }));

  constructor() {
    this.timer = setInterval(() => this.now.set(new Date()), 1000);
    this.load();
    this.watchGps();
  }
  ngOnDestroy(): void {
    clearInterval(this.timer);
    if (this.watchId !== null) navigator.geolocation?.clearWatch(this.watchId);
    this.stopStream();
  }

  private async load(): Promise<void> {
    try {
      const [e, s] = await Promise.all([
        rows<Emp>(sb.from('employees').select('id, name, hq_code').eq('active', true).order('name')),
        rows<Site>(sb.from('attendance_sites').select('name, hq_code, lat, lng, radius').eq('active', true).order('name')),
      ]);
      this.emps.set(e); this.sites.set(s);
      const hqs = this.auth.profile()?.hqs ?? [];
      this.siteName = (s.find((x) => x.hq_code && hqs.includes(x.hq_code)) ?? s[0])?.name ?? '';
    } catch (err) { this.msg.set({ text: errMsg(err), ok: false }); }
  }

  private watchGps(): void {
    if (!('geolocation' in navigator)) { this.gpsErr.set('This device has no GPS / location service.'); return; }
    this.watchId = navigator.geolocation.watchPosition(
      (p) => { this.pos.set({ lat: p.coords.latitude, lng: p.coords.longitude, acc: p.coords.accuracy }); this.gpsErr.set(''); },
      (e) => this.gpsErr.set(e.code === 1 ? 'Location is blocked. Allow location for this site in the browser settings, then reload.' : 'Cannot get your location. Turn on GPS, then wait a moment.'),
      { enableHighAccuracy: true, maximumAge: 10000, timeout: 30000 });
  }

  site(): Site | undefined { return this.sites().find((s) => s.name === this.siteName); }
  gps(): { text: string; cls: string } {
    if (this.gpsErr()) return { text: this.gpsErr(), cls: 'bad' };
    const p = this.pos(), s = this.site();
    if (!p) return { text: 'Getting your location…', cls: 'wait' };
    if (p.acc > MAX_ACCURACY) return { text: `GPS signal weak (±${Math.round(p.acc)} m). Go near a window or door and turn on Precise Location.`, cls: 'wait' };
    if (!s || s.lat === null || s.lng === null) return { text: `Location found (±${Math.round(p.acc)} m). The HQ location is not set yet — inform Admin.`, cls: 'bad' };
    const d = distance(p.lat, p.lng, s.lat, s.lng);
    return d <= s.radius ? { text: `You are at ${s.name} (${d} m away · ±${Math.round(p.acc)} m).`, cls: 'ok' }
      : { text: `${d} m from ${s.name} — must be within ${s.radius} m.`, cls: 'bad' };
  }
  empId(): string { return this.empSel() === '__other' ? this.otherId.trim().toUpperCase() : this.empSel(); }
  canLog(): boolean { return !!this.me() && !!this.pos() && !!this.siteName; }
  chip(s: string): string { return s === 'COMPLETE' ? 'ok' : s === 'TIMED IN' ? 'blue' : 'bad'; }

  pickEmp(v: string): void { this.empSel.set(v); this.me.set(null); this.msg.set({ text: '', ok: true }); if (v && v !== '__other') this.loadMine(); }
  async loadMine(): Promise<void> {
    const id = this.empId();
    if (!id) return;
    try { this.me.set(await rpc<Mine>('attendance_for', { p_emp: id })); this.msg.set({ text: '', ok: true }); }
    catch (e) { this.me.set(null); this.msg.set({ text: errMsg(e), ok: false }); }
  }

  async start(action: 'IN' | 'OUT'): Promise<void> {
    this.action = action; this.shot.set(''); this.blob = null; this.camMsg.set(''); this.msg.set({ text: '', ok: true });
    this.cam.set(true);
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: { ideal: 720 }, height: { ideal: 960 } }, audio: false });
      setTimeout(() => {
        const v = this.video()?.nativeElement;
        if (v && this.stream) { v.srcObject = this.stream; v.play().catch(() => {}); this.streaming.set(true); }
      });
    } catch {
      this.camMsg.set('Cannot open the camera here. Tap “Use camera app” to take the selfie.');
    }
  }
  private stopStream(): void { this.stream?.getTracks().forEach((t) => t.stop()); this.stream = null; this.streaming.set(false); }
  closeCam(): void { this.stopStream(); this.cam.set(false); this.shot.set(''); this.blob = null; }

  snap(): void {
    const v = this.video()?.nativeElement;
    if (!v || !v.videoWidth) { this.camMsg.set('The camera is not ready yet.'); return; }
    this.toJpeg(v, v.videoWidth, v.videoHeight, true);
    this.stopStream();
  }
  retake(): void { this.shot.set(''); this.blob = null; this.start(this.action); }
  fromFile(ev: Event): void {
    const input = ev.target as HTMLInputElement;
    const f = input.files?.[0];
    input.value = '';
    if (!f) return;
    const img = new Image();
    img.onload = () => { this.toJpeg(img, img.naturalWidth, img.naturalHeight, false); URL.revokeObjectURL(img.src); };
    img.onerror = () => this.camMsg.set('Could not read that photo.');
    img.src = URL.createObjectURL(f);
    this.stopStream();
    this.cam.set(true);
  }
  private toJpeg(src: CanvasImageSource, w: number, h: number, mirror: boolean): void {
    const scale = Math.min(1, 720 / Math.max(w, h));
    const c = document.createElement('canvas');
    c.width = Math.round(w * scale); c.height = Math.round(h * scale);
    const ctx = c.getContext('2d')!;
    if (mirror) { ctx.translate(c.width, 0); ctx.scale(-1, 1); }
    ctx.drawImage(src, 0, 0, c.width, c.height);
    this.shot.set(c.toDataURL('image/jpeg', 0.8));
    c.toBlob((b) => { this.blob = b; }, 'image/jpeg', 0.8);
  }

  async submit(): Promise<void> {
    const p = this.pos(), id = this.empId();
    if (!this.blob) { this.camMsg.set('Take a selfie first.'); return; }
    if (!p) { this.camMsg.set('Cannot get your location yet.'); return; }
    this.busy.set(true); this.camMsg.set('');
    try {
      const path = `${todayIso()}/${id.replace(/[^A-Za-z0-9-]/g, '_')}-${this.action}-${Date.now()}.jpg`;
      const { error } = await sb.storage.from('attendance').upload(path, this.blob, { contentType: 'image/jpeg' });
      if (error) throw new Error(error.message);
      const r = await rpc<{ msg: string }>('attendance_log', { p: { action: this.action, id, site: this.siteName, lat: p.lat, lng: p.lng, accuracy: p.acc, photoPath: path } });
      this.closeCam();
      this.msg.set({ text: r.msg, ok: true });
      this.ui.notify(r.msg);
      await this.loadMine();
    } catch (e) { this.camMsg.set(errMsg(e)); }
    finally { this.busy.set(false); }
  }
}
