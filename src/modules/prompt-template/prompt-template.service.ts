import prisma from "../../shared/prisma";
import AppError from "../../shared/errors/AppError";
import {
  CreatePromptTemplateInput,
  UpdatePromptTemplateInput,
  GeneratePromptTextInput,
} from "./prompt-template.validation";
import { SettingsService } from "../settings/settings.service";
import { generateContent } from "../../shared/services/ai.service";

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

const AVAILABLE_VARIABLES = [
  "{{lead.name}}",
  "{{lead.email}}",
  "{{lead.phone}}",
  "{{lead.company}}",
  "{{lead.location}}",
  "{{lead.followUpStage}}",
  "{{lead.notes}}",
  "{{sequence.name}}",
];

const EXAMPLE_TEMPLATE = `You are a Virtual Assistant for Artech Digital, an AI development agency run by Artur Abdullin.

The client booked a call but didn't show up. A meeting transcript (when available) is appended below under "--- TRANSCRIPT ---".

Your task is to generate ONE message for the CURRENT STEP ONLY, using the step context appended below (step number, type EMAIL vs SMS, position in sequence).

---

## SEQUENCE PLAN (for scheduling — read carefully)

The follow-up sequence alternates channels and uses a fixed gap between steps. When interpreting this template for planning:
- StepTypes pattern: SMS, EMAIL, SMS, EMAIL, SMS, EMAIL (repeat or truncate to match total step count).
- IntervalDays: 3 (days between consecutive steps).

(The app may also pass exact step type and order in "--- STEP CONTEXT ---". Always obey that block for the current message.)

---

## GOALS

- Acknowledge politely that they missed the call — no blame; friendly and understanding.
- Re-engage by referencing their goals, idea, or problem from the transcript (when present).
- Encourage booking a PRD (Product Requirement Document) session. Explain clearly:
  - Structured ~30-minute strategy call to define project roadmap.
  - The PRD covers: functional & non-functional requirements, technical architecture, API integrations, feature scope, deliverables, timeline, and budget.
  - Useful even if they don't hire you — it's a blueprint for future work.
- Tone: professional, warm, consultative — trusted expert, not pushy salesperson.

---

## PERSONALIZATION & LINKS

- Address the lead by name using {{lead.name}} (natural language; you may use only the first word as a first name if it reads well).
- Company / context: {{lead.company}}, {{lead.location}}, stage: {{lead.followUpStage}}, notes: {{lead.notes}} (use only what helps; omit empty parts).
- Booking CTA: https://calendly.com/artech-digital/30min-call
- Sign emails as: Artur Abdullin (or "Best, Artur").

---

## OUTPUT FORMAT (STRICT — required for the system)

### If current step is EMAIL

1. **Line 1 MUST be exactly:** \`SUBJECT: <short, human subject line>\`
2. **Line 2 MUST be blank.**
3. **From line 3:** email body with greeting, body, sign-off.
4. In the **first or second paragraph** of the body, include a **brief project recap in one short paragraph** (what they want, problem, direction) inferred from the transcript — this replaces a separate "summary section" so parsing stays correct.
5. Include the Calendly link once in the body.
6. Early steps: warmer / reconnection. Later steps: same tone but **gentle, low-pressure urgency** (still consultative).

### If current step is SMS

- **No subject line.**
- **2–4 short sentences max.** One clear CTA with the same Calendly link.
- Same strategic goals as email, but much tighter.

---

## STYLE REFERENCES (do not copy verbatim — adapt to transcript and step position)

EMAIL (tone only):
Subject: Missed you on our call — let's map your product properly

Hi {{lead.name}},

We didn't connect on our scheduled call — totally fine, these things happen. From what you shared about [specific thread from transcript], I'd still love to help you get clarity.

If you're open to it, let's do a PRD session: a focused call where we outline architecture, integrations, scope, deliverables, timeline, and budget. You keep the document as a blueprint either way.

Grab a time here: https://calendly.com/artech-digital/30min-call

Best,
Artur Abdullin

SMS (tone only):
Hey {{lead.name}} — Artur from Artech Digital. We missed you on our call; no worries. Want to lock a quick PRD session? You'll get a full roadmap doc either way. Book here: https://calendly.com/artech-digital/30min-call`;

const buildGenerationPrompt = (input: GeneratePromptTextInput): string => {
  const stepPattern = (input.stepTypesPattern || ["SMS", "EMAIL", "SMS", "EMAIL", "SMS", "EMAIL"]).join(", ");
  const interval = input.intervalDays || 3;
  const tone = input.toneStyle || "Professional but warm and conversational";

  const hasCtaLink = !!input.ctaLink;
  const hasCompanyName = !!input.companyName;

  const ctaInstruction = hasCtaLink
    ? `- Booking CTA: ${input.ctaLink}\n- Include this CTA link once in emails and in SMS messages.`
    : `- No CTA link was provided. Use a generic call-to-action like "Reply to this email" or "Let me know if you'd like to chat". Do NOT invent or hallucinate any URL.`;

  const companyInstruction = hasCompanyName
    ? `Company Name: ${input.companyName}`
    : `Company Name: Not provided. Reference the sender by name only. Do NOT invent a company name.`;

  const outputFormatCtaNote = hasCtaLink
    ? `5. Include the CTA link once in the body.`
    : `5. Use a reply-based CTA (e.g., "Reply to this email", "Let me know"). Do NOT include any URL.`;

  const outputFormatSmsCtaNote = hasCtaLink
    ? `- **2–4 short sentences max.** One clear CTA with the same link.`
    : `- **2–4 short sentences max.** One clear reply-based CTA. No URL.`;

  return `You are an expert prompt engineer. Your task is to generate a PROMPT TEMPLATE (a meta-prompt) that will later be used to instruct an AI to write follow-up messages for leads.

CRITICAL RULES:
1. You are NOT writing actual follow-up messages. You are writing a TEMPLATE (instructions) that tells AI how to generate those messages later.
2. The template MUST use these placeholder variables (double curly braces) — do NOT replace them with real values:
   ${AVAILABLE_VARIABLES.join(", ")}
3. The template MUST follow the exact structural format shown in the example below.
4. The OUTPUT FORMAT section is MANDATORY and must enforce:
   - For EMAIL: Line 1 must be "SUBJECT: <subject>", Line 2 blank, then body
   - For SMS: No subject line, 2-4 sentences max
5. The template must include a SEQUENCE PLAN section with the step types and interval.
6. The template must instruct AI to generate ONE message for the CURRENT STEP ONLY.
7. Include STYLE REFERENCES section with example email and SMS tone (using {{lead.name}} variable).
8. Do NOT invent or hallucinate any URL or company name that was not provided by the user.

---

USER'S INPUTS:

${companyInstruction}
Sender Name: ${input.senderName}
${hasCtaLink ? `CTA Link: ${input.ctaLink}` : "CTA Link: Not provided"}

Follow-up Scenario:
${input.followUpScenario}

Service/Product Description:
${input.serviceDescription}

Sequence Goal:
${input.sequenceGoal}

Tone & Style: ${tone}

Step Types Pattern: ${stepPattern}
Interval Days: ${interval}
${input.additionalNotes ? `\nAdditional Notes:\n${input.additionalNotes}` : ""}

---

EXAMPLE TEMPLATE (follow this structure exactly, but adapt content to the user's inputs above):

${EXAMPLE_TEMPLATE}

---

NOW generate a complete prompt template based on the user's inputs above. Follow the same section structure:
1. Opening context (who the AI is writing for, scenario)
2. SEQUENCE PLAN (with the user's stepTypes and intervalDays)
3. GOALS (derived from the user's scenario and sequence goal)
4. PERSONALIZATION & LINKS section must include:
   ${ctaInstruction}
   - Sign emails as: ${input.senderName}
   - Use {{variables}} for lead personalization
5. OUTPUT FORMAT (STRICT — required for the system):
   - EMAIL: Line 1 "SUBJECT: ...", Line 2 blank, body from Line 3
     ${outputFormatCtaNote}
   - SMS: No subject line
     ${outputFormatSmsCtaNote}
6. STYLE REFERENCES (example email and SMS adapted to the user's scenario${!hasCtaLink ? " — no URLs in examples" : ""})

Output ONLY the template text. No explanations, no markdown code fences.`;
};

const generatePromptText = async (
  userId: string,
  input: GeneratePromptTextInput
): Promise<{ promptText: string }> => {
  const aiSettings = await prisma.userSettings.findUnique({
    where: { userId },
    select: { aiProvider: true, aiModel: true },
  });
  const aiApiKey = await SettingsService.getDecryptedField(userId, "aiApiKey");

  if (!aiSettings?.aiProvider || !aiApiKey) {
    throw new AppError(
      400,
      "AI provider and API key not configured. Please set them in Settings."
    );
  }

  const prompt = buildGenerationPrompt(input);

  const aiResponse = await generateContent(
    {
      provider: aiSettings.aiProvider as "openai" | "gemini",
      apiKey: aiApiKey,
      model: aiSettings.aiModel || undefined,
    },
    prompt
  );

  const promptText = aiResponse.content
    .replace(/^```(?:markdown|text)?\n?/i, "")
    .replace(/\n?```$/i, "")
    .trim();

  return { promptText };
};

export const PromptTemplateService = {
  createTemplate,
  getTemplates,
  getTemplateById,
  getTemplateByStage,
  updateTemplate,
  deleteTemplate,
  generatePromptText,
};
