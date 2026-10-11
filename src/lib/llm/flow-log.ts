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

export type FlowStep = "sense" | "plan" | "act" | "observe" | "guard" | "respond";

export interface SankeyNode {
  name: string;
  /** Set on agent-provider nodes so the console can give each its own colour. */
  provider?: string;
  /** Set on ReAct step nodes (Sense, Plan, Act, Observe, Boundary check, Respond). */
  step?: FlowStep;
  /** Set on decision/outcome nodes so the console can colour each decision. */
  outcome?: AgentFlowRecord["outcome"] | "idle";
  failure?: boolean;
  /** One line saying what this node is / what the agent did here. */
  detail?: string;
  /** Distinct tasks that passed through this node (links can fan out per tool). */
  tasks: number;
}

export interface SankeyLink {
  source: number;
  target: number;
  value: number;
  /** Provider whose tasks this flow carries ("fallback" = keyword search). */
  provider: string;
}

/** One recent task, spelled out step by step for the console's task list. */
export interface RecentTaskPath {
  agent: string;
  model: string | null;
  outcome: AgentFlowRecord["outcome"];
  cached: boolean;
  /** Providers left before the one that answered, with why each was left. */
  failovers: { from: string; to: string; reason: string }[];
  /** Ordered steps, e.g. "Act · lookup_ticket". */
  steps: string[];
  failureReason?: string;
}

export interface SankeyFlow {
  nodes: SankeyNode[];
  links: SankeyLink[];
  totalTasks: number;
  switches: number;
  recent: RecentTaskPath[];
}

const STEP_LABEL: Record<FlowStep, string> = {
  sense: "Sense",
  plan: "Plan",
  act: "Act",
  observe: "Observe",
  guard: "Boundary check",
  respond: "Respond",
};
const STEP_DETAIL: Record<FlowStep, string> = {
  sense: "Reads the request and loads matching knowledge passages and the person's open tickets.",
  plan: "The model decides: answer now, or call a read-only tool first.",
  act: "Runs the tool the model asked for.",
  observe: "Reads the tool result and decides whether to answer or call another tool.",
  guard: "Checks the draft against the AI Boundary Matrix and replaces it if it claims an action the assistant can't take.",
  respond: "Writes the final reply, or drafts an escalation ticket for staff.",
};
// Every task that reached a model senses and plans (the trace only logs a
// "plan" entry when a tool is called), and every draft goes through the boundary
// check before it is returned. Act and Observe appear only when a tool ran.
const BEFORE_TOOLS: FlowStep[] = ["sense", "plan"];
const AFTER_TOOLS: FlowStep[] = ["guard", "respond"];

const OUTCOME_LABEL: Record<AgentFlowRecord["outcome"], string> = {
  answered: "Answered",
  escalated: "Escalated for approval",
  blocked: "Blocked by boundary rule",
  fallback: "Answered by keyword search",
};
const OUTCOME_DETAIL: Record<AgentFlowRecord["outcome"], string> = {
  answered: "The agent's reply went out as written.",
  escalated: "The agent drafted an escalation ticket; nothing is filed until staff approve it.",
  blocked: "The boundary guard rejected the draft and replaced it with a safe answer.",
  fallback: "No model provider could answer, so knowledge-base keyword search replied instead.",
};
const HANDOFF_REASON: Record<NonNullable<AgentFlowRecord["handoffs"]>[number]["reason"], string> = {
  usage_limit: "hit a quota, rate or token limit",
  provider_error: "returned an error",
  unsupported: "cannot run this provider",
};

/** Tool names an act stage ran, in first-use order ("Act · lookup" -> "lookup"). */
function toolsOf(f: AgentFlowRecord): string[] {
  const tools: string[] = [];
  for (const s of f.stages) {
    if (s.phase !== "act") continue;
    const t = s.label.replace(/^Act\s*·\s*/, "") || "tool";
    if (!tools.includes(t)) tools.push(t);
  }
  return tools;
}

/**
 * Request splits into one node per registered agent provider (each linked even
 * before it has handled a task). Each provider's tasks then pass through the
 * ReAct steps they used — Sense, Plan, one Act node per tool, Observe, Boundary
 * check, Respond — to the decision they ended in. Tasks that no provider could
 * answer go through a separate "Keyword search" node. Node details say what
 * each stage does, and `recent` spells out the latest tasks in full.
 */
export function buildSankey(flows: AgentFlowRecord[], registeredProviders: string[]): SankeyFlow {
  const nodes: SankeyNode[] = [{ name: "Request", detail: "Every customer message that reaches the assistant.", tasks: flows.length }];
  const index = new Map<string, number>([["request", 0]]);
  const node = (key: string, n: Omit<SankeyNode, "tasks">) => {
    let i = index.get(key);
    if (i === undefined) {
      i = nodes.length;
      nodes.push({ ...n, tasks: 0 });
      index.set(key, i);
    }
    return i;
  };
  const providerNode = (name: string) =>
    node(`p:${name}`, { name, provider: name, detail: "Agent provider: the model that plans and writes the answer." });
  for (const name of registeredProviders) providerNode(name);

  const linkValues = new Map<string, SankeyLink>();
  const link = (source: number, target: number, provider: string) => {
    const k = `${source}>${target}>${provider}`;
    const existing = linkValues.get(k);
    if (existing) existing.value++;
    else linkValues.set(k, { source, target, value: 1, provider });
  };
  /** Counts a task once per node, however many links it used to get there. */
  const visited = new Set<string>();
  const visit = (taskId: number, i: number) => {
    const k = `${taskId}:${i}`;
    if (visited.has(k)) return;
    visited.add(k);
    nodes[i].tasks++;
  };

  const models = new Map<string, Set<string>>();
  const failedOver = new Map<string, number>();
  const recent: RecentTaskPath[] = [];

  let switches = 0;
  flows.forEach((f, t) => {
    const failovers = (f.handoffs ?? []).map((h) => ({ from: h.from, to: h.to, reason: HANDOFF_REASON[h.reason] }));
    if (f.kind === "fallback") {
      const search = node("fallback", {
        name: "Keyword search",
        failure: true,
        detail: "Every agent provider failed or none were registered, so the task went to knowledge-base keyword search.",
      });
      link(0, search, "fallback");
      const out = node("out:fallback", { name: OUTCOME_LABEL.fallback, outcome: "fallback", failure: true, detail: OUTCOME_DETAIL.fallback });
      link(search, out, "fallback");
      visit(t, search);
      visit(t, out);
      if (recent.length < 8) {
        recent.push({
          agent: "Keyword search",
          model: null,
          outcome: "fallback",
          cached: false,
          failovers,
          steps: ["Keyword search"],
          failureReason: f.failureReason,
        });
      }
      return;
    }
    const name = f.provider ?? "Unknown provider";
    if (f.attempts.length > 1) switches++;
    const p = providerNode(name);
    link(0, p, name);
    visit(t, p);
    if (f.model) {
      if (!models.has(name)) models.set(name, new Set());
      models.get(name)!.add(f.model);
    }
    if (f.attempts.length > 1) failedOver.set(name, (failedOver.get(name) ?? 0) + 1);

    // Repeated plan-act-observe cycles collapse into one visit per step (and one
    // node per tool) so the graph stays acyclic.
    const tools = toolsOf(f);
    const path: string[] = [];
    const stepNode = (phase: FlowStep) => node(`step:${phase}`, { name: STEP_LABEL[phase], step: phase, detail: STEP_DETAIL[phase] });
    const enter = (froms: number[], targets: number[], label: string) => {
      for (const to of targets) for (const from of froms) link(from, to, name);
      for (const to of targets) visit(t, to);
      path.push(label);
    };

    let prev: number[] = [p];
    for (const phase of BEFORE_TOOLS) {
      const n = stepNode(phase);
      enter(prev, [n], STEP_LABEL[phase]);
      prev = [n];
    }
    if (tools.length > 0) {
      const acts = tools.map((tool) =>
        node(`act:${tool}`, { name: `Act · ${tool}`, step: "act", detail: `Ran the "${tool}" tool.` }),
      );
      enter(prev, acts, `Act · ${tools.join(", ")}`);
      const obs = stepNode("observe");
      enter(acts, [obs], STEP_LABEL.observe);
      prev = [obs];
    }
    for (const phase of AFTER_TOOLS) {
      const n = stepNode(phase);
      enter(prev, [n], STEP_LABEL[phase]);
      prev = [n];
    }
    const out = node(`out:${f.outcome}`, { name: OUTCOME_LABEL[f.outcome], outcome: f.outcome, detail: OUTCOME_DETAIL[f.outcome] });
    for (const from of prev) link(from, out, name);
    visit(t, out);

    if (recent.length < 8) {
      recent.push({ agent: name, model: f.model, outcome: f.outcome, cached: f.cached, failovers, steps: path });
    }
  });

  // Provider detail: which models answered, and how many tasks only reached it
  // after another provider failed.
  for (const [name, set] of models) {
    const n = nodes[index.get(`p:${name}`)!];
    const moved = failedOver.get(name) ?? 0;
    n.detail = `Agent provider · model ${[...set].join(", ")}.${moved ? ` ${moved} task${moved === 1 ? "" : "s"} reached it after another provider failed.` : ""}`;
  }

  // A registered provider that hasn't handled a task still gets its link from
  // Request (value 0, drawn at a minimum width by the console), so the split
  // always shows every provider.
  const links = [...linkValues.values()];
  for (const name of registeredProviders) {
    const p = index.get(`p:${name}`)!;
    if (links.some((l) => l.target === p)) continue;
    links.push({ source: 0, target: p, value: 0, provider: name });
    links.push({
      source: p,
      target: node("out:idle", { name: "No tasks yet", outcome: "idle", detail: "This provider hasn't handled a task yet." }),
      value: 0,
      provider: name,
    });
  }

  return { nodes, links, totalTasks: flows.length, switches, recent };
}
