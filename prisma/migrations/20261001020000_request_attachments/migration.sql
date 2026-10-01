-- Attachments on support requests. The customer app already uploads to
-- POST /requests/:id/attachments, but there was no table (or route) behind it.
CREATE TABLE IF NOT EXISTS public.request_attachments (
  id              uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  request_id      uuid NOT NULL REFERENCES public.requests (id) ON DELETE CASCADE,
  message_id      uuid REFERENCES public.request_messages (id) ON DELETE SET NULL,
  uploaded_by     uuid REFERENCES public.profiles (id),
  file_name       text NOT NULL,
  file_type       text,
  file_size_bytes integer,
  storage_path    text NOT NULL,
  created_at      timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_request_attachments_request ON public.request_attachments (request_id);

-- Same posture as the other tables: only the backend (service role) touches it.
ALTER TABLE public.request_attachments ENABLE ROW LEVEL SECURITY;
