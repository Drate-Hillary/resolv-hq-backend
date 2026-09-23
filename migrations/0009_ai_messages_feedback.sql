-- Backs PATCH /chat/messages/:id/feedback (resolv-hq-customer's thumbs
-- up/down on an assistant reply). Run this against the Supabase project's
-- SQL editor (or via `supabase db push` once the project is linked) —
-- resolv-hq-backend has no live credentials to run it itself.

alter table public.ai_messages
  add column if not exists feedback text
    check (feedback is null or feedback in ('up', 'down'));
