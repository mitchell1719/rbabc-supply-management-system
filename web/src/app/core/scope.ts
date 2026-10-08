import { AuthService } from './auth.service';
import { rows, sb } from './supabase';

export interface BranchRow { id: string; name: string; short_name: string; code: string | null; hq_code: string; rns_user_id: string | null; }

/** Branches this account monitors (same rule as can_see_branch in the database). */
export async function scopeBranches(auth: AuthService): Promise<BranchRow[]> {
  const p = auth.profile();
  if (!p) return [];
  const all = await rows<BranchRow>(sb.from('branches').select('id, name, short_name, code, hq_code, rns_user_id').eq('active', true).order('name'));
  if (p.type === 'Admin') return all;
  if (p.type === 'Branch') return all.filter((b) => b.id === p.branchId);
  if (p.type === 'HQ') return all.filter((b) => p.hqs.includes(b.hq_code));
  if (p.type === 'RNS') {
    const mine = all.filter((b) => b.rns_user_id === p.id);
    return mine.length ? mine : all.filter((b) => p.hqs.includes(b.hq_code));
  }
  return [];
}

export async function setting<T = any>(key: string, fallback: T): Promise<T> {
  const { data } = await sb.from('app_settings').select('value').eq('key', key).maybeSingle();
  return (data?.value ?? fallback) as T;
}
