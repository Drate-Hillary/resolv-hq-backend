-- Which sub-agent (if any) made a model or tool call, so a run shows who did what.
ALTER TABLE public.agent_trace_logs
  ADD COLUMN IF NOT EXISTS agent_name text;
