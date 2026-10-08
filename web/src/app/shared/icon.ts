import { Component, computed, input } from '@angular/core';
import { DomSanitizer } from '@angular/platform-browser';
import { inject } from '@angular/core';
import { ICONS } from '../core/nav';

@Component({
  selector: 'app-icon',
  template: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"
    stroke-linejoin="round" aria-hidden="true" [innerHTML]="svg()"></svg>`,
  styles: [':host{display:inline-flex;width:20px;height:20px;flex:none} svg{width:100%;height:100%}'],
})
export class Icon {
  readonly name = input.required<string>();
  private san = inject(DomSanitizer);
  readonly svg = computed(() => this.san.bypassSecurityTrustHtml(ICONS[this.name()] ?? ''));
}
