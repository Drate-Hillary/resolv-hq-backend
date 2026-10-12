-- General-purpose trace log for the ReAct loop: one row per step of a run
-- (retrieval, each model call, each tool call, guardrail block, final outcome)
-- with latency and error. agent_runs stays the one-row-per-task summary.
CREATE TABLE IF NOT EXISTS public.agent_trace_logs (
  id             uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  agent_run_id   uuid NOT NULL REFERENCES public.agent_runs(id) ON DELETE CASCADE,
  seq            integer NOT NULL,
  kind           text NOT NULL,
  iteration      integer,
  provider       text,
  model          text,
  prompt_version text,
  tool_name      text,
  tool_input     jsonb,
  detail         text,
  latency_ms     integer,
  error          text,
  outcome        text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (agent_run_id, seq)
);

CREATE INDEX IF NOT EXISTS agent_trace_logs_run_idx ON public.agent_trace_logs (agent_run_id, seq);
CREATE INDEX IF NOT EXISTS agent_trace_logs_error_idx ON public.agent_trace_logs (created_at) WHERE error IS NOT NULL;

-- Read only through resolv-hq-backend (GET /admin/traces/:runId, staff only).
ALTER TABLE public.agent_trace_logs ENABLE ROW LEVEL SECURITY;
