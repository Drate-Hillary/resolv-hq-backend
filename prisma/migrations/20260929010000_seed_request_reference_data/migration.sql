-- Both tables were empty in production — nothing here overwrites real data.
-- Names are chosen to match what the app already hardcodes elsewhere, not
-- arbitrary new taxonomy:
--   * status names must be exactly submitted/processing/review/needs_info/
--     completed — resolv-hq-customer's STATUS_COPY map and CSAT trigger
--     (request.status === "completed") key off these exact strings.
--   * category names must exactly match classifyRequest()'s possible
--     outputs (src/lib/classify.ts) — resolveCategoryId() does a
--     case-insensitive exact-name match, so any other names would silently
--     defeat AI auto-categorization.

INSERT INTO "request_statuses" (name, sequence, is_final) VALUES
  ('submitted', 1, false),
  ('processing', 2, false),
  ('needs_info', 3, false),
  ('review', 4, false),
  ('completed', 5, true)
ON CONFLICT (name) DO NOTHING;

INSERT INTO "request_categories" (name, description) VALUES
  ('Billing', 'Invoices, charges, payments, and refunds'),
  ('Account support', 'Login, password, profile, and access issues'),
  ('Service assistance', 'Errors, bugs, integrations, and things not working'),
  ('Product question', 'How something works or what a feature does'),
  ('General Inquiry', 'Anything that does not fit the categories above')
ON CONFLICT (name) DO NOTHING;
