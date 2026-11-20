import { parse } from "csv-parse/sync";
import type { Prisma } from "@prisma/client";
import prisma from "../../shared/prisma";

/** Lead is "Active" iff this lead has at least one sequence with status "active". */
export const syncLeadStatusFromActiveSequences = async (
  leadId: string,
  tx?: Prisma.TransactionClient
) => {
  const db = tx ?? prisma;
  const activeCount = await db.sequence.count({
    where: { leadId, status: "active" },
  });
  await db.lead.update({
    where: { id: leadId },
    data: { status: activeCount > 0 ? "Active" : "Not Active" },
  });
};
import AppError from "../../shared/errors/AppError";
import {
  BulkDeleteLeadsInput,
  ClearDoNotContactInput,
  CreateLeadInput,
  MarkDoNotContactInput,
  UpdateLeadInput,
} from "./lead.validation";
import {
  applyColumnMapping,
  resolveLeadCsvColumnMapping,
  type LeadCsvField,
} from "./csv-header-mapper";
import {
  blockedLeadFields,
  clearLeadDoNotContact,
  doNotContactFieldsForNewLead,
  loadBlockedAddresses,
  markLeadDoNotContact,
} from "../../harness/do-not-contact";

type LeadQuery = {
  page?: number;
  limit?: number;
  status?: string;
  search?: string;
  followUpStage?: string;
};

const createLead = async (userId: string, payload: CreateLeadInput) => {
  if (payload.email) {
    const existing = await prisma.lead.findFirst({
      where: { userId, email: payload.email },
    });

    if (existing?.deletedAt) {
      throw new AppError(
        409,
        "A recently deleted lead has this email. Restore it from Leads → Recently deleted."
      );
    }
    if (existing) {
      throw new AppError(409, "A lead with this email already exists");
    }
  }

  // A new lead whose email or phone is on the do-not-contact list is flagged at once.
  const blockedFields = await doNotContactFieldsForNewLead(
    userId,
    payload.email,
    payload.phone
  );

  return prisma.lead.create({
    data: {
      userId,
      name: payload.name,
      email: payload.email ?? null,
      phone: payload.phone ?? null,
      notes: payload.notes ?? null,
      followUpStage: payload.followUpStage ?? "New",
      company: payload.company ?? null,
      location: payload.location ?? null,
      status: payload.status ?? "Not Active",
      ...blockedFields,
    } as Prisma.LeadUncheckedCreateInput,
  });
};

const getLeads = async (userId: string, query: LeadQuery) => {
  const page = query.page || 1;
  const limit = query.limit || 20;
  const skip = (page - 1) * limit;

  const where: Record<string, unknown> = { userId, deletedAt: null };

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
    where: { id: leadId, userId, deletedAt: null },
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
  const existing = await getLeadById(userId, leadId);

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

  const data: Record<string, unknown> = {};

  if (payload.name !== undefined) data.name = payload.name;
  if (payload.email !== undefined) data.email = payload.email ?? null;
  if (payload.phone !== undefined) data.phone = payload.phone ?? null;
  if (payload.notes !== undefined) data.notes = payload.notes ?? null;
  if (payload.company !== undefined) data.company = payload.company ?? null;
  if (payload.location !== undefined) data.location = payload.location ?? null;
  if (payload.status !== undefined) data.status = payload.status;
  if (payload.followUpStage !== undefined) {
    data.followUpStage = payload.followUpStage;
  }

  const nextEmail =
    payload.email !== undefined ? payload.email : existing.email;
  const nextPhone =
    payload.phone !== undefined ? payload.phone : existing.phone;

  if (!nextEmail && !nextPhone) {
    throw new AppError(400, "Either email or phone is required for follow-up");
  }

  // Changing a lead's email or phone to a blocked address flags the lead.
  // This route can set the flag but never remove it.
  if (
    !existing.doNotContact &&
    (payload.email !== undefined || payload.phone !== undefined)
  ) {
    Object.assign(
      data,
      await doNotContactFieldsForNewLead(userId, nextEmail, nextPhone)
    );
  }

  return prisma.lead.update({
    where: { id: leadId },
    data: data as Parameters<typeof prisma.lead.update>[0]["data"],
  });
};

const deleteLead = async (userId: string, leadId: string) => {
  await getLeadById(userId, leadId);

  return prisma.lead.delete({
    where: { id: leadId },
  });
};

const deleteManyLeads = async (userId: string, payload: BulkDeleteLeadsInput) => {
  const uniqueIds = [...new Set(payload.leadIds)];
  // console.log({uniqueIds});

  const result = await prisma.lead.deleteMany({
    where: { userId, id: { in: uniqueIds }, deletedAt: null },
  });

  return {
    deletedCount: result.count,
    requestedCount: uniqueIds.length,
    skippedCount: uniqueIds.length - result.count,
  };
};

const MAX_CSV_ROWS = 1000;

const isValidEmail = (email: string): boolean => {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
};

type ImportError = { row: number; email: string; reason: string };

export type CsvImportResult = {
  total: number;
  success: number;
  failed: number;
  errors: ImportError[];
  columnMapping: Record<string, string>;
};

const importCSV = async (
  userId: string,
  fileBuffer: Buffer
): Promise<CsvImportResult> => {
  const content = fileBuffer.toString("utf-8").replace(/^\uFEFF/, "");

  let records: Record<string, string>[];

  try {
    records = parse(content, {
      columns: true,
      skip_empty_lines: true,
      trim: true,
      relax_column_count: true,
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : "unknown parse error";
    throw new AppError(400, `Invalid CSV format: ${detail}`);
  }

  if (records.length === 0) {
    throw new AppError(400, "CSV file is empty");
  }

  if (records.length > MAX_CSV_ROWS) {
    throw new AppError(400, `CSV exceeds maximum of ${MAX_CSV_ROWS} rows`);
  }

  const columnMapping = await resolveLeadCsvColumnMapping(userId, records);

  const rows = records.map((record) => applyColumnMapping(record, columnMapping));
  const result = await importLeadRows(userId, rows);

  return { ...result, columnMapping };
};

/**
 * Saves rows that are already mapped to lead fields.
 * Split out of importCSV so the same checks (duplicates, do-not-contact)
 * apply to every way of importing leads.
 */
export const importLeadRows = async (
  userId: string,
  rows: Partial<Record<LeadCsvField, string>>[]
): Promise<Omit<CsvImportResult, "columnMapping">> => {
  const blockedAddresses = await loadBlockedAddresses(userId);

  const existingLeads = await prisma.lead.findMany({
    where: { userId },
    select: { email: true },
  });
  const existingEmails = new Set(
    existingLeads
      .filter((l): l is { email: string } => l.email != null)
      .map((l) => l.email.toLowerCase())
  );
  

  const errors: ImportError[] = [];
  const validLeads: CreateLeadInput[] = [];
  const seenEmails = new Set<string>();

  for (let i = 0; i < rows.length; i++) {
    const rowNum = i + 2; // +2 for header row + 0-index
    const row = rows[i];

    if (!row.name) {
      errors.push({
        row: rowNum,
        email: row.email || "",
        reason: "Missing required field: name",
      });
      continue;
    }

    if (!row.email && !row.phone) {
      errors.push({
        row: rowNum,
        email: "",
        reason: "Either email or phone is required for follow-up",
      });
      continue;
    }

    if (row.email && !isValidEmail(row.email)) {
      errors.push({
        row: rowNum,
        email: row.email,
        reason: "Invalid email format",
      });
      continue;
    }

    if (row.email) {
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
    }

    validLeads.push({
      name: row.name,
      email: row.email || undefined,
      phone: row.phone || undefined,
      notes: row.notes || undefined,
      company: row.company || undefined,
      location: row.location || undefined,
      status: row.status || "Not Active",
      followUpStage: row.followUpStage || "New",
    });
  }

  let successCount = 0;

  if (validLeads.length > 0) {
    const result = await prisma.lead.createMany({
      data: validLeads.map((lead) => ({
        userId,
        name: lead.name,
        email: lead.email ?? null,
        phone: lead.phone ?? null,
        notes: lead.notes ?? null,
        followUpStage: lead.followUpStage,
        company: lead.company ?? null,
        location: lead.location ?? null,
        status: lead.status ?? "Not Active",
        // An address on the do-not-contact list stays blocked when it is imported again.
        ...(blockedAddresses.has(lead.email, lead.phone)
          ? blockedLeadFields()
          : {}),
      })) as Prisma.LeadCreateManyInput[],
      skipDuplicates: true,
    });
    successCount = result.count;
  }

  return {
    total: rows.length,
    success: successCount,
    failed: errors.length,
    errors,
  };
};

/** A logged-in person marks a lead do-not-contact. */
const markDoNotContact = async (
  userId: string,
  leadId: string,
  payload: MarkDoNotContactInput
) => {
  const result = await markLeadDoNotContact({
    userId,
    leadId,
    reason: payload.reason,
    source: "user",
  });

  return {
    lead: result.lead,
    pausedSequenceIds: result.pausedSequenceIds,
    cancelledDraftIds: result.cancelledDraftIds,
  };
};

/**
 * A logged-in person clears do-not-contact. This is the only way to clear it:
 * no MCP tool and no automated path may call this.
 */
const clearDoNotContact = async (
  userId: string,
  leadId: string,
  payload: ClearDoNotContactInput
) => {
  return clearLeadDoNotContact({ userId, leadId, reason: payload.reason });
};

export const LeadService = {
  createLead,
  getLeads,
  getLeadById,
  updateLead,
  deleteLead,
  deleteManyLeads,
  importCSV,
  markDoNotContact,
  clearDoNotContact,
};
