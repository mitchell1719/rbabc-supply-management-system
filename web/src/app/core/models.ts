export type UserType = 'Branch' | 'HQ' | 'RNS' | 'Admin' | 'Finance';

export interface Profile {
  id: string;
  username: string;
  displayName: string;
  type: UserType;
  hqs: string[];
  hqNames: string[];
  branchId: string | null;
  branchName: string | null;
  region: string | null;
  email: string | null;
  fullName: string | null;
  position: string | null;
  contact: string | null;
  photoPath: string | null;
  rns: { name: string; email: string | null } | null;
  title: string;
}

export const PRS_STATUSES = ['Submitted', 'Under Review', 'Approved', 'Returned for Correction', 'Partially Served', 'Served', 'Cancelled'];
