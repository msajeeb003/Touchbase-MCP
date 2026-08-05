import { Router } from "express";
import auth from "../../shared/middleware/auth";
import validateRequest from "../../shared/middleware/validateRequest";
import { SequenceGoalController } from "./sequence-goal.controller";
import {
  createSequenceGoalSchema,
  updateSequenceGoalSchema,
} from "./sequence-goal.validation";

const router = Router();

router.post(
  "/",
  auth,
  validateRequest(createSequenceGoalSchema),
  SequenceGoalController.createGoal
);

router.get("/", auth, SequenceGoalController.getGoals);

router.get("/:id", auth, SequenceGoalController.getGoalById);

router.patch(
  "/:id",
  auth,
  validateRequest(updateSequenceGoalSchema),
  SequenceGoalController.updateGoal
);

router.delete("/:id", auth, SequenceGoalController.deleteGoal);

export const SequenceGoalRoutes = router;
