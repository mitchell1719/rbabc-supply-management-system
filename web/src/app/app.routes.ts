import { Routes } from '@angular/router';
import { authGuard, guestGuard, roleGuard } from './core/guards';
import { Shell } from './features/shell/shell';
import { Login } from './features/login/login';

const r = (roles: string[]) => ({ canActivate: [roleGuard], data: { roles } });

export const routes: Routes = [
  { path: 'login', component: Login, canActivate: [guestGuard] },
  { path: 'soa-view', loadComponent: () => import('./features/soa/soa-public').then((m) => m.SoaPublic) },
  {
    path: '', component: Shell, canActivate: [authGuard],
    children: [
      { path: '', pathMatch: 'full', loadComponent: () => import('./features/home/start').then((m) => m.Start) },
      { path: 'home', ...r(['Branch', 'HQ', 'RNS', 'Admin']), loadComponent: () => import('./features/home/home').then((m) => m.Home) },
      { path: 'prs', ...r(['Branch', 'HQ', 'RNS', 'Admin']), loadComponent: () => import('./features/prs/prs-list').then((m) => m.PrsList) },
      { path: 'prs-new', ...r(['Branch']), loadComponent: () => import('./features/prs/prs-new').then((m) => m.PrsNew) },
      { path: 'wastage', ...r(['Branch', 'HQ', 'RNS', 'Admin']), loadComponent: () => import('./features/wastage/wastage').then((m) => m.Wastage) },
      { path: 'temperature', ...r(['Branch', 'HQ', 'RNS', 'Admin']), loadComponent: () => import('./features/temperature/temperature').then((m) => m.Temperature) },
      { path: 'deliveries', ...r(['HQ', 'Branch', 'RNS', 'Admin']), loadComponent: () => import('./features/deliveries/deliveries').then((m) => m.Deliveries) },
      { path: 'inventory', ...r(['HQ', 'Admin']), loadComponent: () => import('./features/inventory/inventory').then((m) => m.Inventory) },
      { path: 'stockcard', ...r(['Branch', 'RNS', 'HQ', 'Admin']), loadComponent: () => import('./features/stockcard/stockcard').then((m) => m.Stockcard) },
      { path: 'ordered', ...r(['HQ', 'Admin']), loadComponent: () => import('./features/ordered/ordered').then((m) => m.Ordered) },
      { path: 'soa', ...r(['HQ', 'Admin', 'Finance']), loadComponent: () => import('./features/soa/soa').then((m) => m.Soa) },
      { path: 'po', ...r(['Admin', 'Finance']), loadComponent: () => import('./features/po/po').then((m) => m.Po) },
      { path: 'report', ...r(['Admin']), loadComponent: () => import('./features/report/report').then((m) => m.Report) },
      { path: 'monday', ...r(['Admin']), loadComponent: () => import('./features/monday/monday').then((m) => m.Monday) },
      { path: 'attendance', ...r(['HQ']), loadComponent: () => import('./features/attendance/logger').then((m) => m.AttendanceLogger) },
      { path: 'attendance-monitor', ...r(['Admin']), loadComponent: () => import('./features/attendance/monitor').then((m) => m.AttendanceMonitor) },
      { path: 'admin', ...r(['Admin']), loadComponent: () => import('./features/admin/admin').then((m) => m.AdminSetup) },
    ],
  },
  { path: '**', redirectTo: '' },
];
