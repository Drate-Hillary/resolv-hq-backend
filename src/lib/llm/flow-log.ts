// Per-task flow records for the console's Sankey. Each answered task stores
// the path it took — which providers were tried, which model answered, and the
// ReAct stages it went through — on its agent_runs row (tool_input), so the
// diagram is rebuilt from the database and survives restarts and multiple
// instances. It is a view over recent tasks, not an audit log.

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

export const SANKEY_COLUMNS = ["Request", "Model", "Routing", "Reasoning", "Tool", "Outcome"] as const;

export interface SankeyNode {
  name: string;
  /** Index into SANKEY_COLUMNS — every node sits in a fixed stage column. */
  column: number;
  /** Set on model nodes so the console can give each model its own colour. */
  provider?: string;
  failure?: boolean;
}

export interface SankeyLink {
  source: number;
  target: number;
  value: number;
  /** Model whose tasks this flow carries, so one model's work stays one colour
   * from the request to the outcome even through shared stage nodes. "fallback"
   * marks tasks answered by keyword search because no provider could. */
  model: string;
}

export interface SankeyFlow {
  nodes: SankeyNode[];
  links: SankeyLink[];
  totalTasks: number;
  switches: number;
}

const OUTCOME_LABEL: Record<AgentFlowRecord["outcome"], string> = {
  answered: "Answered",
  escalated: "Escalated for approval",
  blocked: "Blocked by boundary rule",
  fallback: "Answered by keyword search",
};

/**
 * A true Sankey: six fixed columns (Request → Model → Routing → Reasoning →
 * Tool → Outcome) with one shared node per stage, so work from different
 * models splits at the Model column and merges again at shared stages.
 * Links are kept per model (parallel links between the same two nodes) so the
 * flow keeps its model's colour all the way to the outcome. Link width is the
 * number of tasks, and every task enters and leaves each node it touches, so
 * flow is conserved.
 */
export function buildSankey(flows: AgentFlowRecord[]): SankeyFlow {
  const nodes: SankeyNode[] = [];
  const index = new Map<string, number>();
  const node = (column: number, name: string, extra: Partial<SankeyNode> = {}) => {
    const key = `${column}:${name}`;
    let i = index.get(key);
    if (i === undefined) {
      i = nodes.length;
      nodes.push({ name, column, ...extra });
      index.set(key, i);
    }
    return i;
  };
  const linkValues = new Map<string, SankeyLink>();
  const link = (source: number, target: number, model: string) => {
    const k = `${source}>${target}>${model}`;
    const existing = linkValues.get(k);
    if (existing) existing.value++;
    else linkValues.set(k, { source, target, value: 1, model });
  };

  let switches = 0;
  for (const f of flows) {
    const fallback = f.kind === "fallback";
    const modelKey = fallback ? "fallback" : [f.provider, f.model].filter(Boolean).join(" · ") || "Unknown model";

    const request = node(0, "Request");
    const modelNode = fallback
      ? node(1, "Keyword search", { failure: true })
      : node(1, modelKey, { provider: modelKey });

    const failedOver = !fallback && f.attempts.length > 1;
    if (failedOver) switches++;
    const routing = fallback
      ? node(2, "No provider available", { failure: true })
      : node(2, f.cached ? "Cached answer" : failedOver ? "Failover" : "Direct");

    const usedTool = f.stages.find((s) => s.phase === "act");
    const reasoning = node(3, usedTool ? "Used tools" : "Direct answer");
    const outcome = node(5, OUTCOME_LABEL[f.outcome], { failure: f.outcome === "fallback" });

    link(request, modelNode, modelKey);
    link(modelNode, routing, modelKey);
    link(routing, reasoning, modelKey);
    if (usedTool) {
      const tool = node(4, usedTool.label.replace(/^Act · /, ""));
      link(reasoning, tool, modelKey);
      link(tool, outcome, modelKey);
    } else {
      link(reasoning, outcome, modelKey);
    }
  }

  return { nodes, links: [...linkValues.values()], totalTasks: flows.length, switches };
}
