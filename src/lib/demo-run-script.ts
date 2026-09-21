// agent_steps no longer exists as a table — agent_runs now tracks progress
// as a single current_step field on the run row itself, not a history of
// step rows. This is just the ordered list of steps the demo agent-workspace
// walks through, driving PATCH /admin/agent-runs/:id's current_step.
export const DEMO_MODEL = "resolv-agent-v3";
export const DEMO_PROMPT_VERSION = "procurement-planner@1.4.0";

export const DEMO_RUN_STEPS = [
  "request_received",
  "context_assembled",
  "knowledge_retrieved",
  "plan_created",
  "tool_executed",
  "result_observed",
  "approval_requested",
  "final_result",
] as const;

export type DemoRunStep = (typeof DEMO_RUN_STEPS)[number];
