interface StepContext {
  stepOrder: number;
  totalSteps: number;
  stepType: string;
}

interface PreviousStep {
  stepOrder: number;
  stepType: string;
  subject: string | null;
  content: string | null;
}

interface LeadInfo {
  name: string;
  email: string | null;
  phone?: string | null;
  company: string;
  location?: string | null;
  followUpStage: string | null;
  notes?: string | null;
}

interface BuildPromptParams {
  promptText: string;
  sequenceName?: string;
  stepContext: StepContext;
  previousSteps: PreviousStep[];
  lead: LeadInfo;
  transcript: string | null;
}

const resolveVariables = (text: string, lead: LeadInfo, sequenceName?: string): string => {
  return text
    .replace(/\{\{lead\.name\}\}/gi, lead.name || "")
    .replace(/\{\{lead\.email\}\}/gi, lead.email || "(not provided)")
    .replace(/\{\{lead\.phone\}\}/gi, lead.phone || "(not provided)")
    .replace(/\{\{lead\.company\}\}/gi, lead.company || "")
    .replace(/\{\{lead\.location\}\}/gi, lead.location || "(not provided)")
    .replace(/\{\{lead\.followUpStage\}\}/gi, lead.followUpStage || "")
    .replace(/\{\{lead\.notes\}\}/gi, lead.notes || "")
    .replace(/\{\{sequence\.name\}\}/gi, sequenceName || "");
};

const getPositionHint = (stepOrder: number, totalSteps: number): string => {
  if (stepOrder === 1) return "First message — warm, friendly, introductory.";
  if (stepOrder === totalSteps)
    return "Final message — create gentle urgency, last chance feel.";

  const ratio = stepOrder / totalSteps;
  if (ratio <= 0.4) return "Early in sequence — build rapport and value.";
  if (ratio <= 0.7) return "Mid-sequence — reinforce value, add light urgency.";
  return "Late in sequence — stronger urgency, clear call-to-action.";
};

const formatPreviousSteps = (steps: PreviousStep[]): string => {
  if (steps.length === 0) return "";

  const lines = steps.map((s) => {
    let text = `Step ${s.stepOrder} (${s.stepType}):`;
    if (s.subject) text += `\nSubject: ${s.subject}`;
    if (s.content) text += `\n${s.content}`;
    return text;
  });

  return `\n--- PREVIOUSLY SENT MESSAGES ---\n${lines.join("\n\n")}`;
};

export const buildPrompt = (params: BuildPromptParams): string => {
  const { promptText, sequenceName, stepContext, previousSteps, lead, transcript } = params;

  const positionHint = getPositionHint(
    stepContext.stepOrder,
    stepContext.totalSteps
  );

  // Replace {{variables}} in the promptText with actual lead/sequence data
  let prompt = resolveVariables(promptText, lead, sequenceName);

  prompt += `\n\n--- STEP CONTEXT ---`;
  prompt += `\nStep: ${stepContext.stepOrder} of ${stepContext.totalSteps}`;
  prompt += `\nMessage type: ${stepContext.stepType}`;
  prompt += `\nPosition: ${positionHint}`;

  if (stepContext.stepType === "EMAIL") {
    prompt += `\n\nIMPORTANT: Start your response with "SUBJECT: " on the first line, followed by the email body.`;
  } else if (stepContext.stepType === "WHATSAPP") {
    prompt += `\n\nIMPORTANT: Generate only the WhatsApp message text. Keep it conversational and friendly (3-6 sentences). No subject line. You may use light formatting like *bold* or _italic_ for emphasis.`;
  } else {
    prompt += `\n\nIMPORTANT: Generate only the SMS text. Keep it concise (2-4 sentences max). No subject line.`;
  }

  const prevText = formatPreviousSteps(previousSteps);
  if (prevText) prompt += `\n${prevText}`;

  prompt += `\n\n--- LEAD INFO ---`;
  prompt += `\nName: ${lead.name}`;
  prompt += `\nEmail: ${lead.email ?? "(not provided)"}`;
  if (lead.phone) prompt += `\nPhone: ${lead.phone}`;
  prompt += `\nCompany: ${lead.company}`;
  if (lead.location) prompt += `\nLocation: ${lead.location}`;
  if (lead.followUpStage) prompt += `\nFollow-up Stage: ${lead.followUpStage}`;
  if (lead.notes) prompt += `\nNotes: ${lead.notes}`;

  if (transcript) {
    prompt += `\n\n--- TRANSCRIPT ---\n${transcript}`;
  }

  return prompt;
};

export const parseAIResponse = (
  response: string,
  stepType: string
): { subject: string | null; content: string } => {
  if (stepType === "SMS" || stepType === "WHATSAPP") {
    return { subject: null, content: response.trim() };
  }

  const lines = response.trim().split("\n");
  const firstLine = lines[0] || "";

  if (firstLine.toUpperCase().startsWith("SUBJECT:")) {
    const subject = firstLine.replace(/^SUBJECT:\s*/i, "").trim();
    const content = lines.slice(1).join("\n").trim();
    return { subject, content: content || response.trim() };
  }

  return { subject: null, content: response.trim() };
};
