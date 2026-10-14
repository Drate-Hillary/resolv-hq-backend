// Per-task flow record. Each answered task stores the path it took — which
// providers were tried, which model answered, and the ReAct stages it went
// through — on its agent_runs row (tool_input), so it survives restarts and
// multiple instances. A summary view, not an audit log: agent_trace_logs
// holds the detailed trace.

export interface FlowStage {
  phase: "plan" | "act" | "observe" | "respond";
  /** Short display label, e.g. the tool name for an "act" stage. */
  label: string;
}

export interface AgentFlowRecord {
  /** "model": a provider answered. "fallback": every provider failed (or none
   * were registered) and the keyword search answered instead. */
  kind: "model" | "fallback";
  provider: string | null;
  model: string | null;
  /** Providers tried on the task's first model call, in order; the last is the
   * one that answered when kind is "model". */
  attempts: string[];
  handoffs?: {
    from: string;
    to: string;
    reason: "usage_limit" | "provider_error" | "unsupported";
  }[];
  cached: boolean;
  stages: FlowStage[];
  outcome: "answered" | "escalated" | "blocked" | "fallback";
  failureReason?: string;
}

/** Keeps just the tool name from an act step such as `lookup({"id":1})` or `x: rejected`. */
export function stagesFromTrace(trace: { phase: FlowStage["phase"]; detail: string }[]): FlowStage[] {
  return trace.map((s) => {
    switch (s.phase) {
      case "plan":
        return { phase: s.phase, label: "Plan" };
      case "act":
        return { phase: s.phase, label: `Act · ${s.detail.split(/[(:]/)[0].trim()}` };
      case "observe":
        return { phase: s.phase, label: "Observe" };
      case "respond":
        return { phase: s.phase, label: "Respond" };
    }
  });
}
