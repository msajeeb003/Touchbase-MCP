import prisma from "../../shared/prisma";
import AppError from "../../shared/errors/AppError";
import {
  CreatePromptTemplateInput,
  UpdatePromptTemplateInput,
} from "./prompt-template.validation";

const createTemplate = async (
  userId: string,
  payload: CreatePromptTemplateInput
) => {
  return prisma.promptTemplate.create({
    data: {
      userId,
      name: payload.name,
      followUpStage: payload.followUpStage,
      promptText: payload.promptText,
    },
  });
};

const getTemplates = async (userId: string) => {
  return prisma.promptTemplate.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      name: true,
      followUpStage: true,
      promptText: true,
      createdAt: true,
      updatedAt: true,
    },
  });
};

const getTemplateById = async (userId: string, templateId: string) => {
  const template = await prisma.promptTemplate.findFirst({
    where: { id: templateId, userId },
  });

  if (!template) {
    throw new AppError(404, "Prompt template not found");
  }

  return template;
};

const getTemplateByStage = async (userId: string, followUpStage: string) => {
  const template = await prisma.promptTemplate.findFirst({
    where: { userId, followUpStage },
  });

  if (!template) {
    throw new AppError(404, `No prompt template found for stage: ${followUpStage}`);
  }

  return template;
};

const updateTemplate = async (
  userId: string,
  templateId: string,
  payload: UpdatePromptTemplateInput
) => {
  await getTemplateById(userId, templateId);

  return prisma.promptTemplate.update({
    where: { id: templateId },
    data: payload,
  });
};

const deleteTemplate = async (userId: string, templateId: string) => {
  await getTemplateById(userId, templateId);

  return prisma.promptTemplate.delete({
    where: { id: templateId },
  });
};

export const PromptTemplateService = {
  createTemplate,
  getTemplates,
  getTemplateById,
  getTemplateByStage,
  updateTemplate,
  deleteTemplate,
};
