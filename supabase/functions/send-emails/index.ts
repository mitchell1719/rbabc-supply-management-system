// Sends the queued e-mails in public.email_outbox through Resend (https://resend.com).
// Secrets: RESEND_API_KEY, MAIL_FROM (e.g. "RB ABC Supply Office <supply@yourdomain.com>"), CRON_SECRET.
// Schedule it every 5 minutes with pg_cron + pg_net (see README.md).
import { createClient } from 'npm:@supabase/supabase-js@2';
import { corsHeaders, json } from '../_shared/cors.ts';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  const secret = Deno.env.get('CRON_SECRET');
  if (!secret || req.headers.get('x-cron-secret') !== secret) return json({ error: 'Not allowed' }, 401);

  const apiKey = Deno.env.get('RESEND_API_KEY');
  const from = Deno.env.get('MAIL_FROM');
  if (!apiKey || !from) return json({ error: 'RESEND_API_KEY and MAIL_FROM are not set' }, 500);

  const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  const { data: rows, error } = await sb.from('email_outbox').select('*')
    .is('sent_at', null).lt('attempts', 5).order('id').limit(50);
  if (error) return json({ error: error.message }, 500);

  let sent = 0, failed = 0;
  for (const m of rows ?? []) {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to: m.to_addr, cc: m.cc_addr?.length ? m.cc_addr : undefined, subject: m.subject, html: m.html }),
    });
    if (res.ok) {
      sent++;
      await sb.from('email_outbox').update({ sent_at: new Date().toISOString(), error: null }).eq('id', m.id);
    } else {
      failed++;
      await sb.from('email_outbox').update({ attempts: m.attempts + 1, error: (await res.text()).slice(0, 500) }).eq('id', m.id);
    }
  }
  return json({ sent, failed });
});
