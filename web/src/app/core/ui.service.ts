import { Injectable, signal } from '@angular/core';

export type Tone = 'info' | 'ok' | 'warn' | 'danger';
export interface DialogState {
  kind: 'alert' | 'confirm' | 'prompt';
  title: string;
  html: string;
  tone: Tone;
  ok: string;
  cancel: string;
  label?: string;
  placeholder?: string;
  required?: boolean;
  hint?: string;
  value: string;
  resolve: (v: any) => void;
}
export interface DialogOptions {
  title?: string; message?: string; html?: string; tone?: Tone; ok?: string; cancel?: string;
  label?: string; placeholder?: string; required?: boolean; hint?: string; value?: string;
}

/** Portal dialogs (replace the browser's alert / confirm / prompt) and toast messages. */
@Injectable({ providedIn: 'root' })
export class UiService {
  readonly dialog = signal<DialogState | null>(null);
  readonly toast = signal<{ text: string; tone: 'ok' | 'err' } | null>(null);
  private queue: DialogState[] = [];
  private toastTimer: any;

  confirm(o: DialogOptions): Promise<boolean> { return this.open('confirm', o); }
  prompt(o: DialogOptions): Promise<string | null> { return this.open('prompt', o); }
  alert(o: DialogOptions | string): Promise<void> { return this.open('alert', typeof o === 'string' ? { message: o } : o); }

  notify(text: string, tone: 'ok' | 'err' = 'ok'): void {
    clearTimeout(this.toastTimer);
    this.toast.set({ text, tone });
    this.toastTimer = setTimeout(() => this.toast.set(null), tone === 'err' ? 9000 : 6000);
  }

  close(result: boolean): void {
    const d = this.dialog();
    if (!d) return;
    const out = d.kind === 'prompt' ? (result ? d.value : null) : d.kind === 'confirm' ? result : undefined;
    this.dialog.set(this.queue.shift() ?? null);
    d.resolve(out);
  }

  private open(kind: DialogState['kind'], o: DialogOptions): Promise<any> {
    return new Promise((resolve) => {
      const s: DialogState = {
        kind, resolve, tone: o.tone ?? 'info',
        title: o.title ?? (kind === 'alert' ? 'Notice' : kind === 'prompt' ? 'Add a note' : 'Please confirm'),
        html: o.html ?? escapeHtml(o.message ?? '').replace(/\n/g, '<br>'),
        ok: o.ok ?? (kind === 'alert' ? 'OK' : 'Confirm'), cancel: o.cancel ?? 'Cancel',
        label: o.label, placeholder: o.placeholder, required: o.required, hint: o.hint, value: o.value ?? '',
      };
      if (this.dialog()) this.queue.push(s); else this.dialog.set(s);
    });
  }
}

export function escapeHtml(s: unknown): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}
