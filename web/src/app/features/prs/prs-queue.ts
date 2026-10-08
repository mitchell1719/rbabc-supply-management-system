import { UserType } from '../../core/models';

export interface PrsRow {
  id: string; control_no: string; prs_date: string; branch_id: string; branch_name: string; branch_short: string; hq_code: string;
  department: string | null; prepared_by: string | null; status: string; date_served: string | null; dn_numbers: string[];
  item_count: number; days_open: number | null; rns_action: string | null; rns_note: string | null; sent_to_hq_at: string | null;
}

export function queueFor(type: UserType | null, rows: PrsRow[]): { kind: string; title: string; empty: string; rows: PrsRow[] } | null {
  if (type === 'RNS' || type === 'Admin') {
    return { kind: 'review', title: 'For your review', empty: 'No PRS waiting for your review.',
      rows: rows.filter((r) => r.status === 'Submitted' || r.status === 'Under Review') };
  }
  if (type === 'HQ') {
    return { kind: 'serve', title: 'Approved by RNS — ready to serve', empty: 'No approved PRS waiting to be served.',
      rows: rows.filter((r) => r.status === 'Approved') };
  }
  if (type === 'Branch') {
    return { kind: 'updates', title: 'Updates from your RNS', empty: 'No approved or returned PRS right now.',
      rows: rows.filter((r) => r.status === 'Approved' || r.status === 'Returned for Correction') };
  }
  return null;
}
