// Drives the agent-workspace demo run: there's no real LLM behind it yet.
// agent_steps and tool_executions no longer exist as tables — agent_runs
// itself now carries current_step/tool_name/tool_input/tool_output directly,
// updated in place as the run advances (see DEMO_RUN_STEPS).
import { Prisma } from "@prisma/client";
import { Router } from "express";
import { requireRole } from "../../lib/auth.js";
import { badRequest, notFound } from "../../lib/errors.js";
import { DEMO_MODEL, DEMO_PROMPT_VERSION, DEMO_RUN_STEPS } from "../../lib/demo-run-script.js";
import { isNotFound } from "../../lib/prisma-errors.js";
import { prisma } from "../../lib/prisma.js";
import { asyncRoute } from "../../middleware/error-handler.js";
import type { Json, RunStatus } from "../../types/database.types.js";

const router = Router();

/** Start a new agent run. Returns the run row plus the ordered step keys the
 * caller will walk through via PATCH /:id (current_step). */
router.post(
  "/",
  requireRole("staff"),
  asyncRoute(async (req, res) => {
    const { conversationId, requestId } = req.body as { conversationId?: string | null; requestId?: string | null };

    const run = await prisma.agent_runs.create({
      data: {
        customer_id: req.user!.id,
        conversation_id: conversationId ?? null,
        request_id: requestId ?? null,
        status: "running",
        current_step: DEMO_RUN_STEPS[0],
        model: DEMO_MODEL,
        prompt_version: DEMO_PROMPT_VERSION,
      },
    });

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
    const update: Prisma.agent_runsUpdateInput = {};
    if (status !== undefined) update.status = status;
    if (currentStep !== undefined) update.current_step = currentStep;
    if (toolName !== undefined) update.tool_name = toolName;
    if (toolInput !== undefined) update.tool_input = toolInput === null ? Prisma.JsonNull : (toolInput as Prisma.InputJsonValue);
    if (toolOutput !== undefined) update.tool_output = toolOutput === null ? Prisma.JsonNull : (toolOutput as Prisma.InputJsonValue);
    if (iterations !== undefined) update.iterations = iterations;
    if (completedAt !== undefined) update.completed_at = completedAt;
    if (errorMessage !== undefined) update.error_message = errorMessage;
    if (Object.keys(update).length === 0) throw badRequest("Nothing to update");

    try {
      const data = await prisma.agent_runs.update({ where: { id: req.params.id }, data: update });
      res.json(data);
    } catch (err) {
      if (isNotFound(err)) throw notFound("Run not found");
      throw err;
    }
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

    const approval = await prisma.agent_approvals.create({
      data: {
        agent_run_id: req.params.id,
        requested_action: requestedAction,
        reason: reason ?? null,
        status: "pending",
      },
    });

    await prisma.agent_runs.updateMany({
      where: { id: req.params.id },
      data: { status: "awaiting_approval" },
    });

    res.status(201).json(approval);
  }),
);

export default router;
