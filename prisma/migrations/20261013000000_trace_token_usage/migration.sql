-- Token usage per model call, so the console can show what a run cost.
ALTER TABLE public.agent_trace_logs
  ADD COLUMN IF NOT EXISTS input_tokens integer,
  ADD COLUMN IF NOT EXISTS output_tokens integer;
