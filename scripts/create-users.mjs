// Creates the starting accounts (Admin, HQs, RNS, Finance and one account per branch).
// Safe to run more than once: existing usernames are skipped.
//
//   SUPABASE_URL=https://xxxx.supabase.co SUPABASE_SERVICE_ROLE_KEY=... DEFAULT_PASSWORD=... node scripts/create-users.mjs
//
// Everyone logs in with the username shown below and DEFAULT_PASSWORD, then changes it in "Change password".
import { createClient } from '@supabase/supabase-js';

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
const password = process.env.DEFAULT_PASSWORD;
if (!url || !key || !password || password.length < 6) {
  console.error('Set SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY and DEFAULT_PASSWORD (6+ characters).');
  process.exit(1);
}
const sb = createClient(url, key, { auth: { persistSession: false } });
const authEmail = (u) => u.trim().toLowerCase().replace(/[^a-z0-9]+/g, '.').replace(/^\.|\.$/g, '') + '@rbabc.local';

const STAFF = [
  { username: 'SUPPLY OFFICE', display: 'Supply Office', type: 'Admin', hqs: [], email: 'rbabcitmitch@gmail.com' },
  { username: 'CEBU HQ', display: 'Cebu HQ', type: 'HQ', hqs: ['CEBU'], email: 'rbabcscocebjay@gmail.com', full: 'Jeremiah C. Soquite', position: 'Supply Officer – Cebu' },
  { username: 'CDO HQ', display: 'CDO HQ', type: 'HQ', hqs: ['CDO'], email: 'rbabcscocdokienth@gmail.com', full: 'Kienth Brayan M. Gapol', position: 'Supply Officer – CDO' },
  { username: 'DAVAO HQ', display: 'Davao HQ', type: 'HQ', hqs: ['DAVAO'], email: 'rbabcscodvoedward@gmail.com', full: 'Edward Sean C. Maravilla', position: 'Supply Officer – Davao' },
  { username: 'PASIG HQ', display: 'Pasig HQ', type: 'HQ', hqs: ['PASIG'], email: 'rbabcscojayson@gmail.com', full: 'Jayson Arzadon', position: 'Supply Officer – Pasig' },
  { username: 'RNS MALDO', display: 'Gabrielle G. Maldo', type: 'RNS', hqs: ['PASIG'], email: 'rbabchqrnsgabrielle@gmail.com' },
  { username: 'RNS DALAPO', display: 'Angelene Q. Dalapo', type: 'RNS', hqs: ['CEBU'], email: 'rbabchqrnsvange@gmail.com' },
  { username: 'RNS PULGO', display: 'Trixiemaxine Pairy Angely M. Pulgo', type: 'RNS', hqs: ['CDO', 'DAVAO'], email: 'rbabchqrnstrixie@gmail.com' },
  { username: 'FINANCE', display: 'Finance Department', type: 'Finance', hqs: [], email: null },
];

async function ensure(u) {
  const { data: existing } = await sb.from('app_users').select('id').ilike('username', u.username).maybeSingle();
  if (existing) { console.log('skip  ', u.username); return existing.id; }
  const { data, error } = await sb.auth.admin.createUser({ email: authEmail(u.username), password, email_confirm: true });
  if (error) throw new Error(`${u.username}: ${error.message}`);
  const { error: e2 } = await sb.from('app_users').insert({
    id: data.user.id, username: u.username, display_name: u.display, type: u.type, hq_codes: u.hqs ?? [],
    branch_id: u.branchId ?? null, email: u.email ?? null, full_name: u.full ?? null, position: u.position ?? null,
  });
  if (e2) { await sb.auth.admin.deleteUser(data.user.id); throw new Error(`${u.username}: ${e2.message}`); }
  console.log('create', u.username);
  return data.user.id;
}

const ids = {};
for (const u of STAFF) ids[u.username] = await ensure(u);

// every branch gets an account named after its short name (e.g. DANAO) and the RNS that covers its HQ
const rnsFor = { PASIG: 'RNS MALDO', CEBU: 'RNS DALAPO', CDO: 'RNS PULGO', DAVAO: 'RNS PULGO' };
const { data: branches, error } = await sb.from('branches').select('id, name, short_name, hq_code, rns_user_id');
if (error) throw error;
for (const b of branches) {
  await ensure({ username: b.short_name, display: b.name, type: 'Branch', hqs: [], branchId: b.id });
  if (!b.rns_user_id && ids[rnsFor[b.hq_code]]) {
    await sb.from('branches').update({ rns_user_id: ids[rnsFor[b.hq_code]] }).eq('id', b.id);
  }
}
console.log(`Done. Log in with a username (e.g. SUPPLY OFFICE, CEBU HQ, RNS DALAPO, DANAO) and the default password.`);
