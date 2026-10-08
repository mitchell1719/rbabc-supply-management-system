import { Component, inject } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { DialogHost } from './shared/dialog-host';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, DialogHost],
  template: `<router-outlet /><app-dialog-host />`,
})
export class App {}
