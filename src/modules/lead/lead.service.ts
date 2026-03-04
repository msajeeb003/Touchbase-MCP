import prisma from "../../shared/prisma";
import AppError from "../../shared/errors/AppError";
import { CreateLeadInput, UpdateLeadInput } from "./lead.validation";

type LeadQuery = {
  page?: number;
  limit?: number;
  status?: string;
  search?: string;
  followUpStage?: string;
};

const createLead = async (userId: string, payload: CreateLeadInput) => {
  const existing = await prisma.lead.findUnique({
    where: { userId_email: { userId, email: payload.email } },
  });

  if (existing) {
    throw new AppError(409, "A lead with this email already exists");
  }

  return prisma.lead.create({
    data: { userId, ...payload },
  });
};

const getLeads = async (userId: string, query: LeadQuery) => {
  const page = query.page || 1;
  const limit = query.limit || 20;
  const skip = (page - 1) * limit;

  const where: Record<string, unknown> = { userId };

  if (query.status) {
    where.status = query.status;
  }

  if (query.followUpStage) {
    where.followUpStage = query.followUpStage;
  }

  if (query.search) {
    where.OR = [
      { name: { contains: query.search, mode: "insensitive" } },
      { email: { contains: query.search, mode: "insensitive" } },
      { company: { contains: query.search, mode: "insensitive" } },
    ];
  }

  const [items, total] = await Promise.all([
    prisma.lead.findMany({
      where,
      skip,
      take: limit,
      orderBy: { createdAt: "desc" },
    }),
    prisma.lead.count({ where }),
  ]);

  return {
    items,
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    },
  };
};

const getLeadById = async (userId: string, leadId: string) => {
  const lead = await prisma.lead.findFirst({
    where: { id: leadId, userId },
  });

  if (!lead) {
    throw new AppError(404, "Lead not found");
  }

  return lead;
};

const updateLead = async (
  userId: string,
  leadId: string,
  payload: UpdateLeadInput
) => {
  await getLeadById(userId, leadId);

  if (payload.email) {
    const duplicate = await prisma.lead.findFirst({
      where: {
        userId,
        email: payload.email,
        id: { not: leadId },
      },
    });

    if (duplicate) {
      throw new AppError(409, "Another lead with this email already exists");
    }
  }

  return prisma.lead.update({
    where: { id: leadId },
    data: payload,
  });
};

const deleteLead = async (userId: string, leadId: string) => {
  await getLeadById(userId, leadId);

  return prisma.lead.delete({
    where: { id: leadId },
  });
};

export const LeadService = {
  createLead,
  getLeads,
  getLeadById,
  updateLead,
  deleteLead,
};
