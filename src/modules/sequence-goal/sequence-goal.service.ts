import prisma from "../../shared/prisma";
import AppError from "../../shared/errors/AppError";
import {
  CreateSequenceGoalInput,
  UpdateSequenceGoalInput,
} from "./sequence-goal.validation";

const createGoal = async (userId: string, payload: CreateSequenceGoalInput) => {
  const label = payload.label.trim();

  const existing = await prisma.sequenceGoal.findFirst({
    where: {
      userId,
      label: { equals: label, mode: "insensitive" },
    },
  });

  if (existing) {
    throw new AppError(409, "A goal with this label already exists");
  }

  return prisma.sequenceGoal.create({
    data: { userId, label },
  });
};

const getGoals = async (userId: string) => {
  return prisma.sequenceGoal.findMany({
    where: { userId },
    orderBy: { createdAt: "asc" },
  });
};

const getGoalById = async (userId: string, goalId: string) => {
  const goal = await prisma.sequenceGoal.findFirst({
    where: { id: goalId, userId },
  });

  if (!goal) {
    throw new AppError(404, "Goal not found");
  }

  return goal;
};

const updateGoal = async (
  userId: string,
  goalId: string,
  payload: UpdateSequenceGoalInput
) => {
  await getGoalById(userId, goalId);

  const label = payload.label.trim();

  const duplicate = await prisma.sequenceGoal.findFirst({
    where: {
      userId,
      id: { not: goalId },
      label: { equals: label, mode: "insensitive" },
    },
  });

  if (duplicate) {
    throw new AppError(409, "A goal with this label already exists");
  }

  return prisma.sequenceGoal.update({
    where: { id: goalId },
    data: { label },
  });
};

const deleteGoal = async (userId: string, goalId: string) => {
  await getGoalById(userId, goalId);

  await prisma.sequenceGoal.delete({
    where: { id: goalId },
  });

  return null;
};

export const SequenceGoalService = {
  createGoal,
  getGoals,
  getGoalById,
  updateGoal,
  deleteGoal,
};
