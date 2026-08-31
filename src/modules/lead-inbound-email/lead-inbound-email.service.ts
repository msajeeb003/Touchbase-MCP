import prisma from "../../shared/prisma";
import AppError from "../../shared/errors/AppError";

const verifyLeadOwnership = async (userId: string, leadId: string) => {
  const lead = await prisma.lead.findFirst({
    where: { id: leadId, userId },
    select: { id: true },
  });

  if (!lead) {
    throw new AppError(404, "Lead not found");
  }

  return lead;
};

const listByLead = async (
  userId: string,
  leadId: string,
  page: number,
  limit: number
) => {
  await verifyLeadOwnership(userId, leadId);

  const skip = (page - 1) * limit;

  const [items, total] = await Promise.all([
    prisma.leadInboundEmail.findMany({
      where: { leadId, userId },
      orderBy: { receivedAt: "desc" },
      skip,
      take: limit,
      select: {
        id: true,
        messageId: true,
        fromEmail: true,
        fromName: true,
        toEmail: true,
        subject: true,
        bodyText: true,
        receivedAt: true,
        createdAt: true,
      },
    }),
    prisma.leadInboundEmail.count({ where: { leadId, userId } }),
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

export const LeadInboundEmailService = {
  listByLead,
};
