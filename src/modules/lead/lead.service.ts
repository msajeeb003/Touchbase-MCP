import { parse } from "csv-parse/sync";
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

const MAX_CSV_ROWS = 1000;

const COLUMN_MAP: Record<string, string> = {
  name: "name",
  email: "email",
  phone: "phone",
  company: "company",
  location: "location",
  status: "status",
  followupstage: "followUpStage",
  "follow-up stage": "followUpStage",
  "follow up stage": "followUpStage",
};

const normalizeColumns = (
  row: Record<string, string>
): Record<string, string> => {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(row)) {
    const normalized = key.trim().toLowerCase();
    const mapped = COLUMN_MAP[normalized];
    if (mapped) {
      result[mapped] = value.trim();
    }
  }
  return result;
};

const isValidEmail = (email: string): boolean => {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
};

type ImportError = { row: number; email: string; reason: string };

const importCSV = async (userId: string, fileBuffer: Buffer) => {
  const content = fileBuffer
    .toString("utf-8")
    .replace(/^\uFEFF/, ""); // strip BOM

  let records: Record<string, string>[];
  
  try {
    records = parse(content, {
      columns: true,
      skip_empty_lines: true,
      trim: true,
    });
  } catch {
    throw new AppError(400, "Invalid CSV format");
  }

  
  if (records.length === 0) {
    throw new AppError(400, "CSV file is empty");
  }

  if (records.length > MAX_CSV_ROWS) {
    throw new AppError(400, `CSV exceeds maximum of ${MAX_CSV_ROWS} rows`);
  }

  const existingLeads = await prisma.lead.findMany({
    where: { userId },
    select: { email: true },
  });
  const existingEmails = new Set(
    existingLeads.map((l) => l.email.toLowerCase())
  );
  

  const errors: ImportError[] = [];
  const validLeads: CreateLeadInput[] = [];
  const seenEmails = new Set<string>();

  for (let i = 0; i < records.length; i++) {
    const rowNum = i + 2; // +2 for header row + 0-index
    const row = normalizeColumns(records[i]);

    const required = ["name", "email", "phone", "company", "location"];
    const missing = required.filter((f) => !row[f]);
    if (missing.length > 0) {
      errors.push({
        row: rowNum,
        email: row.email || "",
        reason: `Missing fields: ${missing.join(", ")}`,
      });
      continue;
    }

    if (!isValidEmail(row.email)) {
      errors.push({
        row: rowNum,
        email: row.email,
        reason: "Invalid email format",
      });
      continue;
    }

    const emailLower = row.email.toLowerCase();

    if (seenEmails.has(emailLower)) {
      errors.push({
        row: rowNum,
        email: row.email,
        reason: "Duplicate email in CSV",
      });
      continue;
    }

    if (existingEmails.has(emailLower)) {
      errors.push({
        row: rowNum,
        email: row.email,
        reason: "Email already exists",
      });
      continue;
    }

    seenEmails.add(emailLower);
    validLeads.push({
      name: row.name,
      email: row.email,
      phone: row.phone,
      company: row.company,
      location: row.location,
      status: row.status || undefined,
      followUpStage: row.followUpStage || undefined,
    });
  }

  let successCount = 0;

  if (validLeads.length > 0) {
    const result = await prisma.lead.createMany({
      data: validLeads.map((lead) => ({ userId, ...lead })),
      skipDuplicates: true,
    });
    successCount = result.count;
  }

  return {
    total: records.length,
    success: successCount,
    failed: errors.length,
    errors,
  };
};

export const LeadService = {
  createLead,
  getLeads,
  getLeadById,
  updateLead,
  deleteLead,
  importCSV,
};
