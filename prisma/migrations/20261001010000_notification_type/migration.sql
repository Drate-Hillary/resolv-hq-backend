-- Adds a category to notifications so clients can pick an icon / route
-- without parsing the title. Existing rows were all written by the request
-- status-change handler, so they backfill as 'request_update'.
ALTER TABLE public.notifications
  ADD COLUMN IF NOT EXISTS type text NOT NULL DEFAULT 'system';

UPDATE public.notifications SET type = 'request_update' WHERE title = 'Request updated';

-- Unread-first listing per user is the hot query for both clients.
CREATE INDEX IF NOT EXISTS notifications_user_unread_idx
  ON public.notifications (user_id, is_read, created_at DESC);
