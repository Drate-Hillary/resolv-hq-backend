-- Customer-app copy that used to be hard-coded in the mobile client
-- (onboarding, privacy notice, support contact, assistant greeting/progress
-- steps, per-status explanations). One row per content block, jsonb value, so
-- the copy can be edited in the database without shipping a new app build.
CREATE TABLE IF NOT EXISTS public.app_content (
  key        text PRIMARY KEY,
  value      jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Read only through resolv-hq-backend (GET /app-content); no direct client access.
ALTER TABLE public.app_content ENABLE ROW LEVEL SECURITY;

INSERT INTO public.app_content (key, value) VALUES
('onboarding', $json$
{
  "title": "Welcome to Resolv HQ",
  "subtitle": "Here's what you can do from day one.",
  "cta": "Get Started",
  "features": [
    { "icon": "sparkles", "title": "Meet your AI support assistant", "description": "Ask anything, anytime. Your assistant is grounded in our approved knowledge base — not guesswork." },
    { "icon": "book", "title": "Answers you can trust", "description": "Every response can show its source, so you always know where the guidance came from." },
    { "icon": "tasks", "title": "Track every request live", "description": "Submit a request in seconds and follow its journey from submission to resolution." },
    { "icon": "lock", "title": "You're always in control", "description": "Sensitive actions are reviewed by our team, and you decide what the assistant remembers." }
  ]
}
$json$::jsonb),
('privacy', $json$
{
  "sections": [
    { "icon": "shield", "title": "How we use your information", "body": "Your requests and messages help our AI assistant give you accurate, personalized answers. Sensitive actions are always reviewed by our team before anything changes on your account." },
    { "icon": "database", "title": "What's stored, and for how long", "body": "We keep your request history and a small set of preferences for 24 months so future support is faster. You can review or delete everything from Saved Information." },
    { "icon": "lock", "title": "Who can access it", "body": "Only you and the support specialists assigned to your requests can see your data. It is never used to train external models." }
  ]
}
$json$::jsonb),
('support', $json$
{
  "heading": "Still need a human?",
  "email": "support@resolvhq.com",
  "responseTime": "one business day"
}
$json$::jsonb),
('chat', $json$
{
  "welcomeMessage": "Hi! I'm your Resolv HQ assistant. Ask me anything about your account, or how to get something done — I'll ground my answers in our approved help content.",
  "suggestions": [
    "How do I submit a request?",
    "What's the status of my last request?",
    "How does the AI assistant work?"
  ],
  "steps": [
    "Understanding your request",
    "Checking available information",
    "Finding relevant guidance",
    "Preparing your response"
  ]
}
$json$::jsonb),
('request_status_copy', $json$
{
  "submitted": "We've received your request and it's queued for processing.",
  "processing": "We're actively working through the details of your request.",
  "review": "We're reviewing your request. A specialist is confirming the best next step.",
  "needs_info": "We need a bit more information from you before we can continue.",
  "completed": "This request has been completed."
}
$json$::jsonb)
ON CONFLICT (key) DO NOTHING;
