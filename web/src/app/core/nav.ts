import { UserType } from './models';

export interface NavItem { path: string; label: string; icon: string; roles: UserType[]; labels?: Partial<Record<UserType, string>>; }

export const NAV: NavItem[] = [
  { path: 'home', label: 'Dashboard', icon: 'home', roles: ['Branch', 'HQ', 'RNS', 'Admin'] },
  { path: 'attendance', label: 'Attendance logger', icon: 'clock', roles: ['HQ'] },
  { path: 'prs', label: 'Purchase requests', icon: 'prs', roles: ['Branch', 'HQ', 'RNS', 'Admin'] },
  { path: 'inventory', label: 'Inventory', icon: 'box', roles: ['HQ', 'Admin'] },
  { path: 'deliveries', label: 'Deliveries', icon: 'truck', roles: ['HQ', 'Branch', 'RNS', 'Admin'],
    labels: { HQ: 'Delivery notes', Branch: 'Receiving reports' } },
  { path: 'ordered', label: 'Ordered items', icon: 'bars', roles: ['HQ', 'Admin'] },
  { path: 'stockcard', label: 'Stockcard', icon: 'card', roles: ['Branch', 'RNS', 'HQ', 'Admin'] },
  { path: 'wastage', label: 'Vial wastage', icon: 'vial', roles: ['Branch', 'HQ', 'RNS', 'Admin'] },
  { path: 'temperature', label: 'Ref temperature', icon: 'temp', roles: ['Branch', 'HQ', 'RNS', 'Admin'] },
  { path: 'soa', label: 'Statements of Account', icon: 'doc', roles: ['HQ', 'Admin', 'Finance'],
    labels: { HQ: 'For SOA', Admin: 'SOA approval' } },
  { path: 'po', label: 'Purchase orders', icon: 'cart', roles: ['Admin', 'Finance'] },
  { path: 'report', label: 'Report', icon: 'chart', roles: ['Admin'] },
  { path: 'attendance-monitor', label: 'Attendance monitoring', icon: 'users', roles: ['Admin'] },
  { path: 'monday', label: 'Monday report', icon: 'cal', roles: ['Admin'] },
  { path: 'admin', label: 'Setup', icon: 'gear', roles: ['Admin'] },
];

export const ICONS: Record<string, string> = {
  home: '<path d="M3 11 12 4l9 7"/><path d="M5 10v10h14V10"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  prs: '<path d="M9 4h6a1 1 0 0 1 1 1v1H8V5a1 1 0 0 1 1-1Z"/><path d="M8 6H6a1 1 0 0 0-1 1v13a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V7a1 1 0 0 0-1-1h-2"/><path d="M9 12h6M9 16h4"/>',
  box: '<path d="M21 8 12 3 3 8v8l9 5 9-5z"/><path d="M3 8l9 5 9-5"/><path d="M12 13v8"/>',
  truck: '<path d="M3 6h11v10H3z"/><path d="M14 9h4l3 3v4h-7"/><circle cx="7" cy="17.5" r="1.8"/><circle cx="17" cy="17.5" r="1.8"/>',
  bars: '<path d="M4 20V4"/><path d="M4 20h16"/><rect x="7" y="12" width="3" height="5"/><rect x="12" y="8" width="3" height="9"/><rect x="17" y="5" width="3" height="12"/>',
  card: '<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 8h8M8 12h8M8 16h5"/>',
  vial: '<path d="M9 3h6M10 3v5.5L5.6 17a2.7 2.7 0 0 0 2.4 4h8a2.7 2.7 0 0 0 2.4-4L14 8.5V3"/><path d="M7.5 14h9"/>',
  temp: '<path d="M14 14.8V5a2 2 0 1 0-4 0v9.8a4 4 0 1 0 4 0Z"/><path d="M12 9v7"/>',
  doc: '<path d="M6 3h9l3 3v15H6z"/><path d="M15 3v3h3"/><path d="M9 11h6M9 15h6M9 19h3"/>',
  cart: '<path d="M3 4h2l2.4 11.2a2 2 0 0 0 2 1.6h7.7a2 2 0 0 0 2-1.5L21 8H6.2"/><circle cx="10" cy="20" r="1.4"/><circle cx="17" cy="20" r="1.4"/>',
  chart: '<path d="M4 20V10"/><path d="M10 20V4"/><path d="M16 20v-7"/><path d="M22 20H2"/>',
  users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="m16 11 2 2 4-4"/>',
  cal: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.6 1.6 0 0 0-1-1.5 1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.6 1.6 0 0 0 1.5-1 1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H9a1.6 1.6 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V9a1.6 1.6 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1Z"/>',
  chat: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="m11 12 9-9M17 6l3 3M15 8l2 2"/>',
  out: '<path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3"/><path d="M10 17l-5-5 5-5M5 12h11"/>',
  link: '<path d="M14 4h6v6M20 4l-9 9"/><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
};
