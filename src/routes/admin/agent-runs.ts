// Drives the agent-workspace demo run: there's no real LLM behind it yet.
// agent_steps and tool_executions no longer exist as tables — agent_runs
// itself now carries current_step/tool_name/tool_input/tool_output directly,
// updated in place as the run advances (see DEMO_RUN_STEPS).
import { Router } from "express";
import { requireRole } from "../../lib/auth.js";
import { badRequest, notFound } from "../../lib/errors.js";
import { DEMO_MODEL, DEMO_PROMPT_VERSION, DEMO_RUN_STEPS } from "../../lib/demo-run-script.js";
import { db } from "../../lib/supabase.js";
import { asyncRoute } from "../../middleware/error-handler.js";
import type { Database, Json, RunStatus } from "../../types/database.types.js";

const router = Router();

/** Start a new agent run. Returns the run row plus the ordered step keys the
 * caller will walk through via PATCH /:id (current_step). */
router.post(
  "/",
  requireRole("staff"),
  asyncRoute(async (req, res) => {
    const { conversationId, requestId } = req.body as { conversationId?: string | null; requestId?: string | null };

    const { data: run, error: runError } = await db
      .from("agent_runs")
      .insert({
        customer_id: req.user!.id,
        conversation_id: conversationId ?? null,
        request_id: requestId ?? null,
        status: "running",
        current_step: DEMO_RUN_STEPS[0],
        model: DEMO_MODEL,
        prompt_version: DEMO_PROMPT_VERSION,
      })
      .select()
      .single();
    if (runError || !run) throw runError ?? new Error("Failed to create run");

    res.status(201).json({ run, steps: DEMO_RUN_STEPS });
  }),
);

/** Update a run's status/current_step/tool call info and/or completion fields. */
router.patch(
  "/:id",
  requireRole("staff"),
  asyncRoute(async (req, res) => {
    const { status, currentStep, toolName, toolInput, toolOutput, iterations, completedAt, errorMessage } =
      req.body as {
        status?: RunStatus;
        currentStep?: string | null;
        toolName?: string | null;
        toolInput?: Json | null;
        toolOutput?: Json | null;
        iterations?: number;
        completedAt?: string | null;
        errorMessage?: string | null;
      };
    const update: Database["public"]["Tables"]["agent_runs"]["Update"] = {};
    if (status !== undefined) update.status = status;
    if (currentStep !== undefined) update.current_step = currentStep;
    if (toolName !== undefined) update.tool_name = toolName;
    if (toolInput !== undefined) update.tool_input = toolInput;
    if (toolOutput !== undefined) update.tool_output = toolOutput;
    if (iterations !== undefined) update.iterations = iterations;
    if (completedAt !== undefined) update.completed_at = completedAt;
    if (errorMessage !== undefined) update.error_message = errorMessage;
    if (Object.keys(update).length === 0) throw badRequest("Nothing to update");

    const { data, error } = await db.from("agent_runs").update(update).eq("id", req.params.id).select().single();
    if (error || !data) throw notFound("Run not found");
    res.json(data);
  }),
);

/**
 * Open the approval gate for this run: inserts the agent_approvals row and
 * flips the run to awaiting_approval. This is NOT the approve/reject
 * decision (that logic lives once, in approvals.ts / lib/approval-decisions.ts)
 * — this only opens the gate.
 */
router.post(
  "/:id/approvals",
  requireRole("staff"),
  asyncRoute(async (req, res) => {
    const { requestedAction, reason } = req.body as { requestedAction?: string; reason?: string | null };
    if (!requestedAction) throw badRequest("requestedAction is required");

    const { data: approval, error } = await db
      .from("agent_approvals")
      .insert({
        agent_run_id: req.params.id,
        requested_action: requestedAction,
        reason: reason ?? null,
        status: "pending",
      })
      .select()
      .single();
    if (error || !approval) throw error ?? new Error("Failed to create approval");

    const { error: runError } = await db
      .from("agent_runs")
      .update({ status: "awaiting_approval" })
      .eq("id", req.params.id);
    if (runError) throw runError;

    res.status(201).json(approval);
  }),
);

export default router;
