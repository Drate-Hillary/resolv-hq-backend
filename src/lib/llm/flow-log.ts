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

export interface SankeyNode {
  name: string;
  /** Set on agent-provider nodes so the console can give each its own colour. */
  provider?: string;
  /** Set on ReAct step nodes (Plan, Act, Observe, Respond). */
  step?: "sense" | "plan" | "act" | "observe" | "respond";
  /** Set on decision/outcome nodes so the console can colour each decision. */
  outcome?: AgentFlowRecord["outcome"] | "idle";
  failure?: boolean;
}

export interface SankeyLink {
  source: number;
  target: number;
  value: number;
  /** Provider whose tasks this flow carries ("fallback" = keyword search). */
  provider: string;
}

export interface SankeyFlow {
  nodes: SankeyNode[];
  links: SankeyLink[];
  totalTasks: number;
  switches: number;
}

type FlowStep = "sense" | "plan" | "act" | "observe" | "respond";
const STEP_ORDER: FlowStep[] = ["sense", "plan", "act", "observe", "respond"];
const STEP_LABEL: Record<FlowStep, string> = { sense: "Sense", plan: "Plan", act: "Act", observe: "Observe", respond: "Respond" };
// Every task that reached a model first senses (query + context are gathered)
// and plans (the model decides to answer or to call a tool), even though the
// trace only logs a "plan" entry when a tool is called. Act and Observe appear
// only when a tool was actually used.
const ALWAYS: FlowStep[] = ["sense", "plan", "respond"];

const OUTCOME_LABEL: Record<AgentFlowRecord["outcome"], string> = {
  answered: "Answered",
  escalated: "Escalated for approval",
  blocked: "Blocked by boundary rule",
  fallback: "Answered by keyword search",
};

/**
 * Request splits into one node per registered agent provider (each linked even
 * before it has handled a task); each provider's tasks flow through the ReAct
 * steps they used (Sense, Plan, Act, Observe, Respond) to the outcome they ended in. Link width is the number of tasks. Tasks that no
 * provider could answer go through a separate "Keyword search" node.
 */
export function buildSankey(flows: AgentFlowRecord[], registeredProviders: string[]): SankeyFlow {
  const nodes: SankeyNode[] = [{ name: "Request" }];
  const index = new Map<string, number>([["request", 0]]);
  const node = (key: string, n: SankeyNode) => {
    let i = index.get(key);
    if (i === undefined) {
      i = nodes.length;
      nodes.push(n);
      index.set(key, i);
    }
    return i;
  };
  const providerNode = (name: string) => node(`p:${name}`, { name, provider: name });
  for (const name of registeredProviders) providerNode(name);

  const linkValues = new Map<string, SankeyLink>();
  const link = (source: number, target: number, provider: string) => {
    const k = `${source}>${target}>${provider}`;
    const existing = linkValues.get(k);
    if (existing) existing.value++;
    else linkValues.set(k, { source, target, value: 1, provider });
  };

  let switches = 0;
  for (const f of flows) {
    if (f.kind === "fallback") {
      const search = node("fallback", { name: "Keyword search", failure: true });
      link(0, search, "fallback");
      link(search, node("out:fallback", { name: OUTCOME_LABEL.fallback, outcome: "fallback", failure: true }), "fallback");
      continue;
    }
    const name = f.provider ?? "Unknown provider";
    if (f.attempts.length > 1) switches++;
    const p = providerNode(name);
    link(0, p, name);

    // The steps this task went through, in the order a ReAct loop always runs
    // them (Sense → Plan → Act → Observe → Respond). Repeated cycles collapse into
    // one visit per step so the graph stays acyclic.
    let prev = p;
    for (const phase of STEP_ORDER) {
      if (!ALWAYS.includes(phase) && !f.stages.some((s) => s.phase === phase)) continue;
      const step = node(`step:${phase}`, { name: STEP_LABEL[phase], step: phase });
      link(prev, step, name);
      prev = step;
    }
    link(prev, node(`out:${f.outcome}`, { name: OUTCOME_LABEL[f.outcome], outcome: f.outcome }), name);
  }

  // A registered provider that hasn't handled a task still gets its link from
  // Request (value 0, drawn at a minimum width by the console), so the split
  // always shows every provider.
  const links = [...linkValues.values()];
  for (const name of registeredProviders) {
    const p = index.get(`p:${name}`)!;
    if (links.some((l) => l.target === p)) continue;
    links.push({ source: 0, target: p, value: 0, provider: name });
    links.push({ source: p, target: node("out:idle", { name: "No tasks yet", outcome: "idle" }), value: 0, provider: name });
  }

  return { nodes, links, totalTasks: flows.length, switches };
}
