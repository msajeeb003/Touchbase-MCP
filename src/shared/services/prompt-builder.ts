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
  company: string;
  followUpStage: string | null;
}

interface BuildPromptParams {
  promptText: string;
  stepContext: StepContext;
  previousSteps: PreviousStep[];
  lead: LeadInfo;
  transcript: string | null;
}

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
  const { promptText, stepContext, previousSteps, lead, transcript } = params;

  const positionHint = getPositionHint(
    stepContext.stepOrder,
    stepContext.totalSteps
  );

  let prompt = promptText;

  prompt += `\n\n--- STEP CONTEXT ---`;
  prompt += `\nStep: ${stepContext.stepOrder} of ${stepContext.totalSteps}`;
  prompt += `\nMessage type: ${stepContext.stepType}`;
  prompt += `\nPosition: ${positionHint}`;

  if (stepContext.stepType === "EMAIL") {
    prompt += `\n\nIMPORTANT: Start your response with "SUBJECT: " on the first line, followed by the email body.`;
  } else {
    prompt += `\n\nIMPORTANT: Generate only the SMS text. Keep it concise (2-4 sentences max). No subject line.`;
  }

  const prevText = formatPreviousSteps(previousSteps);
  if (prevText) prompt += `\n${prevText}`;

  prompt += `\n\n--- LEAD INFO ---`;
  prompt += `\nName: ${lead.name}`;
  prompt += `\nEmail: ${lead.email ?? "(not provided)"}`;
  prompt += `\nCompany: ${lead.company}`;
  if (lead.followUpStage) {
    prompt += `\nFollow-up Stage: ${lead.followUpStage}`;
  }

  if (transcript) {
    prompt += `\n\n--- TRANSCRIPT ---\n${transcript}`;
  }

  return prompt;
};

export const parseAIResponse = (
  response: string,
  stepType: string
): { subject: string | null; content: string } => {
  if (stepType === "SMS") {
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
