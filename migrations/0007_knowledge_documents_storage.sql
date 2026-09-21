-- Private storage bucket for uploaded knowledge-base files (PDFs, docs,
-- text files, ...). Run this against the Supabase project's SQL editor (or
-- via `supabase db push` once the project is linked) — resolv-hq-backend
-- has no live credentials to run it itself.
--
-- Only resolv-hq-backend's service-role client (src/lib/supabase.ts) ever
-- touches this bucket — service role bypasses storage RLS entirely, so no
-- storage.objects policies are needed. Files are handed to the admin UI as
-- short-lived signed URLs (see src/lib/knowledge-storage.ts), never a
-- public URL.

insert into storage.buckets (id, name, public)
values ('knowledge-documents', 'knowledge-documents', false)
on conflict (id) do nothing;
