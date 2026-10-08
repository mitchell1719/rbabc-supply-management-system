import { Component, ElementRef, effect, inject, viewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { UiService } from '../core/ui.service';

@Component({
  selector: 'app-dialog-host',
  imports: [FormsModule],
  template: `
  @if (ui.dialog(); as d) {
    <div class="ud-back" (mousedown)="backdrop($event)" (keydown.escape)="ui.close(d.kind === 'alert')">
      <div class="ud-box" [class]="'ud-box ' + d.tone" role="dialog" aria-modal="true" aria-labelledby="udTitle">
        <h4 id="udTitle">{{ d.title }}</h4>
        <div class="ud-msg" [innerHTML]="d.html"></div>
        @if (d.kind === 'prompt') {
          <div class="ud-field">
            <label for="udIn">{{ d.label || 'Note' }} {{ d.required ? '(required)' : '(optional)' }}</label>
            <textarea id="udIn" #field rows="3" [(ngModel)]="d.value" [placeholder]="d.placeholder || ''"></textarea>
            @if (d.hint) { <small>{{ d.hint }}</small> }
          </div>
        }
        <div class="btns end ud-btns">
          @if (d.kind !== 'alert') { <button type="button" class="btn" (click)="ui.close(false)">{{ d.cancel }}</button> }
          <button type="button" #okBtn [class]="'btn pri' + (d.tone === 'danger' ? ' danger' : '')"
                  [disabled]="d.kind === 'prompt' && d.required && !d.value.trim()" (click)="ui.close(true)">{{ d.ok }}</button>
        </div>
      </div>
    </div>
  }
  @if (ui.toast(); as t) {
    <div class="toast" [class.err]="t.tone === 'err'" role="status" (click)="ui.toast.set(null)">{{ t.text }}</div>
  }`,
  styles: [`
    .ud-back{position:fixed;inset:0;z-index:200;background:rgba(16,28,82,.48);display:flex;align-items:center;justify-content:center;padding:16px}
    .ud-box{background:#fff;border-radius:20px;width:min(460px,100%);box-shadow:0 24px 60px rgba(16,28,82,.28);border-top:5px solid var(--navy);padding:22px 22px 18px;max-height:calc(100vh - 32px);overflow:auto}
    .ud-box.danger,.ud-box.warn{border-top-color:var(--red)} .ud-box.ok{border-top-color:#2E9D57}
    h4{margin:0 0 8px;font-size:17px;font-weight:600}
    .ud-msg{font-size:14px;line-height:1.55;color:var(--mute)}
    .ud-field{margin-top:14px} .ud-field small{display:block;margin-top:5px;font-size:11.5px;color:var(--mute)}
    .ud-btns{margin-top:18px}
    .toast{position:fixed;left:50%;bottom:22px;transform:translateX(-50%);z-index:210;max-width:min(640px,calc(100vw - 32px));background:var(--ok-soft);color:var(--ok);border:1px solid #bfe3c8;
      padding:12px 16px;border-radius:14px;font-size:14px;box-shadow:0 10px 30px rgba(16,28,82,.18);cursor:pointer}
    .toast.err{background:var(--red-soft);color:var(--red-dark);border-color:#f3c7c7}
    :host ::ng-deep .ud-pill{display:inline-block;margin-top:8px;padding:8px 12px;border-radius:12px;background:var(--red-soft);color:var(--red-dark);font-size:13px}
    :host ::ng-deep .ud-pill.ok{background:var(--ok-soft);color:var(--ok)} :host ::ng-deep .ud-pill.part{background:var(--warn-soft);color:var(--warn-ink)}
  `],
})
export class DialogHost {
  readonly ui = inject(UiService);
  private field = viewChild<ElementRef<HTMLTextAreaElement>>('field');
  private okBtn = viewChild<ElementRef<HTMLButtonElement>>('okBtn');

  constructor() {
    effect(() => {
      if (!this.ui.dialog()) return;
      setTimeout(() => (this.field()?.nativeElement ?? this.okBtn()?.nativeElement)?.focus(), 30);
    });
  }

  backdrop(e: MouseEvent): void {
    const d = this.ui.dialog();
    if (e.target === e.currentTarget && d && d.kind !== 'alert') this.ui.close(false);
  }
}
