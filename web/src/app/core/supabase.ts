import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { environment } from '../../environments/environment';

export const sb: SupabaseClient = createClient(environment.supabaseUrl, environment.supabaseAnonKey, {
  auth: { persistSession: true, autoRefreshToken: true, storageKey: 'rbabc-portal-auth' },
});

/** Message of a Supabase / PostgREST error (the workflow functions raise readable messages). */
export function errMsg(e: unknown): string {
  const m = (e as { message?: string })?.message ?? String(e);
  return m.replace(/^TypeError: Failed to fetch$/, 'Cannot reach the server. Check your internet connection.');
}

/** Calls a database function and returns its result, throwing a readable Error on failure. */
export async function rpc<T = any>(fn: string, args: Record<string, unknown> = {}): Promise<T> {
  const { data, error } = await sb.rpc(fn, args);
  if (error) throw new Error(error.message);
  return data as T;
}

/** Runs a select and throws a readable Error on failure. */
export async function rows<T = any>(q: PromiseLike<{ data: T[] | null; error: { message: string } | null }>): Promise<T[]> {
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return data ?? [];
}

export async function signedUrl(bucket: string, path: string, seconds = 3600): Promise<string> {
  const { data, error } = await sb.storage.from(bucket).createSignedUrl(path, seconds);
  if (error) throw new Error(error.message);
  return data.signedUrl;
}

export function publicUrl(bucket: string, path: string): string {
  return sb.storage.from(bucket).getPublicUrl(path).data.publicUrl;
}
