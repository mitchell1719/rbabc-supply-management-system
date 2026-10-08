// Admin account management (needs the service role, so it runs as an Edge Function).
// Called from Admin → Setup → Accounts with the Admin's own session token.
//   { action: 'create', username, displayName, type, hqCodes, branchId, email, password }
//   { action: 'update', userId, displayName, type, hqCodes, branchId, email, active }
//   { action: 'reset_password', userId, password }
import { createClient } from 'npm:@supabase/supabase-js@2';
import { corsHeaders, json } from '../_shared/cors.ts';

const TYPES = ['Branch', 'HQ', 'RNS', 'Admin', 'Finance'];
export const authEmail = (username: string) =>
  username.trim().toLowerCase().replace(/[^a-z0-9]+/g, '.').replace(/^\.|\.$/g, '') + '@rbabc.local';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
  const { data: caller } = await sb.auth.getUser(token);
  if (!caller?.user) return json({ ok: false, msg: 'Session expired. Please log in again.' }, 401);
  const { data: me } = await sb.from('app_users').select('type, active').eq('id', caller.user.id).single();
  if (!me || me.type !== 'Admin' || !me.active) return json({ ok: false, msg: 'Only the Admin manages accounts.' }, 403);

  const b = await req.json().catch(() => ({}));
  const pwOk = (p: unknown) => typeof p === 'string' && p.length >= 6;
  try {
    if (b.action === 'create') {
      const username = String(b.username ?? '').trim().toUpperCase();
      if (!username) return json({ ok: false, msg: 'Enter the username.' });
      if (!TYPES.includes(b.type)) return json({ ok: false, msg: 'Choose the account type.' });
      if (!pwOk(b.password)) return json({ ok: false, msg: 'The password must be at least 6 characters.' });
      if (b.type === 'Branch' && !b.branchId) return json({ ok: false, msg: 'Choose the branch of this account.' });
      const { data: dup } = await sb.from('app_users').select('id').ilike('username', username).maybeSingle();
      if (dup) return json({ ok: false, msg: `${username} already exists.` });
      const { data: created, error } = await sb.auth.admin.createUser({ email: authEmail(username), password: b.password, email_confirm: true });
      if (error || !created.user) return json({ ok: false, msg: error?.message ?? 'Could not create the account.' });
      const { error: e2 } = await sb.from('app_users').insert({
        id: created.user.id, username, display_name: String(b.displayName || username).trim(), type: b.type,
        hq_codes: b.type === 'Branch' ? [] : (b.hqCodes ?? []), branch_id: b.type === 'Branch' ? b.branchId : null,
        email: b.email || null,
      });
      if (e2) { await sb.auth.admin.deleteUser(created.user.id); return json({ ok: false, msg: e2.message }); }
      return json({ ok: true, id: created.user.id, msg: `${username} created. Login: ${username} with the password you set.` });
    }
    if (b.action === 'update') {
      const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
      if (b.displayName !== undefined) patch.display_name = String(b.displayName).trim();
      if (b.type !== undefined) { if (!TYPES.includes(b.type)) return json({ ok: false, msg: 'Unknown type.' }); patch.type = b.type; }
      if (b.hqCodes !== undefined) patch.hq_codes = b.hqCodes;
      if (b.branchId !== undefined) patch.branch_id = b.branchId || null;
      if (b.email !== undefined) patch.email = b.email || null;
      if (b.active !== undefined) patch.active = !!b.active;
      const { error } = await sb.from('app_users').update(patch).eq('id', b.userId);
      if (error) return json({ ok: false, msg: error.message });
      if (b.active === false) await sb.auth.admin.updateUserById(b.userId, { ban_duration: '876000h' });
      if (b.active === true) await sb.auth.admin.updateUserById(b.userId, { ban_duration: 'none' });
      return json({ ok: true, msg: 'Account updated.' });
    }
    if (b.action === 'reset_password') {
      if (!pwOk(b.password)) return json({ ok: false, msg: 'The password must be at least 6 characters.' });
      const { error } = await sb.auth.admin.updateUserById(b.userId, { password: b.password });
      if (error) return json({ ok: false, msg: error.message });
      return json({ ok: true, msg: 'Password reset. Tell the user to change it after logging in.' });
    }
    return json({ ok: false, msg: 'Unknown action.' });
  } catch (e) {
    return json({ ok: false, msg: (e as Error).message }, 500);
  }
});
