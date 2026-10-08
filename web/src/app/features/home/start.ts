import { Component, inject } from '@angular/core';
import { Router } from '@angular/router';
import { AuthService } from '../../core/auth.service';

/** Landing page per role: Finance → SOA, HQ → Attendance logger, everyone else → Dashboard. */
@Component({ selector: 'app-start', template: '' })
export class Start {
  constructor() {
    const t = inject(AuthService).type();
    inject(Router).navigateByUrl(t === 'Finance' ? '/soa' : t === 'HQ' ? '/attendance' : '/home', { replaceUrl: true });
  }
}
