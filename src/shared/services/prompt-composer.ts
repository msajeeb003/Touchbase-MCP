import type {
  SituationType,
  GoalType,
  ToneType,
  IntensityType,
} from "../../modules/sequence/sequence.validation";

const SITUATION_STEP1_CONTEXT: Record<SituationType, string> = {
  "No-show":
    "The lead missed a scheduled meeting without prior notice. Acknowledge this directly and empathetically — do not ignore the no-show, but do not be confrontational.",
  "Post-call follow-up":
    "You recently had a successful call or meeting with this lead. Reference the conversation warmly.",
  "Demo follow-up":
    "You just walked the lead through a product demo. Reference what was shown and their expressed interest.",
  "Proposal follow-up":
    "A proposal has been sent and is awaiting the lead's decision. Reference the proposal directly.",
  "Cold outreach":
    "This is your first contact with this lead. Introduce yourself and the reason for reaching out clearly.",
  "Re-engagement":
    "This lead went cold after earlier conversations. Acknowledge the gap in communication naturally — do not pretend it did not happen.",
  "Custom": "",
};

const SITUATION_FOLLOWUP_CONTEXT: Record<SituationType, string> = {
  "No-show":
    "You have already reached out about the missed meeting. Reference your prior message naturally without dwelling on the no-show again.",
  "Post-call follow-up":
    "You have already followed up after the call. Reference your previous message and keep building on the conversation.",
  "Demo follow-up":
    "You have already reached out after the demo. Continue the conversation naturally — reference your prior outreach.",
  "Proposal follow-up":
    "You have already followed up on the proposal. Reference your previous messages and keep the pressure appropriate to the step.",
  "Cold outreach":
    "You have already made initial contact. This is a follow-up — reference your previous message, do not re-introduce yourself from scratch.",
  "Re-engagement":
    "You have already reached out to re-engage. Continue naturally — reference your prior message.",
  "Custom":
    "You have already reached out previously. Reference your prior message naturally — do not repeat your initial introduction.",
};

const GOAL_CONTEXT: Record<GoalType, string> = {
  "Book another call":  "Your goal is to get them on a call.",
  "Get a reply":        "Your goal is to get any form of response from the lead.",
  "Build relationship": "Your goal is to nurture trust and stay top-of-mind without pressure.",
  "Close the deal":     "Your goal is to move toward a signed agreement or purchase decision.",
  "Send proposal":      "Your goal is to open the door to sending a formal proposal.",
  "Share resources":    "Your goal is to provide helpful content that adds genuine value.",
};

const GOAL_CTA: Record<GoalType, string> = {
  "Book another call":  "Close with a specific proposed date/time or a direct calendar booking link. Make it easy to say yes.",
  "Get a reply":        "End with ONE simple, easy-to-answer question. Nothing more. Lower the friction to reply.",
  "Build relationship": "Provide value or a relevant insight. Do NOT include a hard ask in this message.",
  "Close the deal":     "Reference the open discussion or proposal and ask directly for their decision.",
  "Send proposal":      "Ask naturally whether now is a good time to send them a formal proposal.",
  "Share resources":    "Share or mention the resource and explain in one sentence why it is relevant to them.",
};

const TONE_INSTRUCTIONS: Record<ToneType, string> = {
  "Friendly & Professional":
    "Maintain a warm, approachable, professional tone. Balance friendliness with credibility.",
  "Direct & Assertive":
    "Maintain a direct, confident tone. Respect their time and get to the point.",
  "Casual & Conversational":
    "Maintain a casual, relaxed tone as if writing to a familiar contact. Avoid corporate language.",
  "Formal & Polished":
    "Maintain a formal, polished tone appropriate for C-level or enterprise contacts.",
};

const getIntensityPositionHint = (
  intensity: IntensityType,
  stepOrder: number,
  totalSteps: number
): string => {
  const isFirst = stepOrder === 1;
  const isLast = stepOrder === totalSteps;
  const ratio = stepOrder / totalSteps;

  if (intensity === "Light") {
    if (isLast) return "This is your final gentle touch. Make it easy to reply or simply opt out — no pressure.";
    return "Keep this message brief and low-pressure. Give the lead plenty of space.";
  }

  if (intensity === "Aggressive") {
    if (isFirst) return "Be direct and confident from the first line. Establish a sense of urgency and purpose immediately.";
    if (isLast)  return "This is your absolute last message. Make it count — clear ask, real stakes, no ambiguity.";
    if (ratio >= 0.7) return "You have reached out multiple times. Be more assertive. A response is important. Create real urgency.";
    return "You have reached out before. Maintain pressure. Be direct about wanting a response.";
  }

  // Standard
  if (isFirst) return "First message — warm, friendly, introductory.";
  if (isLast)  return "Final message — create gentle urgency, last chance feel.";
  if (ratio <= 0.4) return "Early in sequence — build rapport and value.";
  if (ratio <= 0.7) return "Mid-sequence — reinforce value, add light urgency.";
  return "Late in sequence — stronger urgency, clear call-to-action.";
};

const getStepTypeInstruction = (stepType: string): string => {
  if (stepType === "EMAIL") {
    return `IMPORTANT: Start your response with "SUBJECT: " on the first line, followed by the email body.`;
  }
  if (stepType === "WHATSAPP") {
    return `IMPORTANT: Generate only the WhatsApp message text. Keep it conversational and friendly (3-6 sentences). No subject line. You may use light formatting like *bold* or _italic_ for emphasis.`;
  }
  if (stepType === "CALL") {
    return `IMPORTANT: Generate structured call context for an AI voice agent. No subject line. Use these exact section headers:

GREETING: The first thing the agent says when the call connects — 1-2 short spoken sentences, use the lead's name, match the situation. Must sound natural on a phone.
SENDER: One line — caller name and company as implied by the context.
OBJECTIVE: One sentence — goal of this call.
BACKGROUND: 2-4 sentences — lead context, prior messages, meeting notes from transcript if any.
KEY POINTS: 3-5 bullet lines — what to convey during the conversation.
QUESTIONS: 2-3 bullet lines — what to ask the lead.
CLOSING: One sentence — how to end or what next step to propose.`;
  }
  return `IMPORTANT: Generate only the SMS text. Keep it concise (2-4 sentences max). No subject line.`;
};

const formatPreviousSteps = (
  steps: { stepOrder: number; stepType: string; subject: string | null; content: string | null }[]
): string => {
  if (steps.length === 0) return "";

  const lines = steps.map((s) => {
    let text = `Step ${s.stepOrder} (${s.stepType}):`;
    if (s.subject) text += `\nSubject: ${s.subject}`;
    if (s.content) text += `\n${s.content}`;
    return text;
  });

  return `\n--- PREVIOUSLY SENT MESSAGES ---\n${lines.join("\n\n")}`;
};

const resolveLeadVariables = (
  text: string,
  lead: WizardStepPromptParams["lead"]
): string =>
  text
    .replace(/\{\{lead\.name\}\}/gi,          lead.name || "")
    .replace(/\{\{lead\.email\}\}/gi,         lead.email || "(not provided)")
    .replace(/\{\{lead\.phone\}\}/gi,         lead.phone || "(not provided)")
    .replace(/\{\{lead\.company\}\}/gi,       lead.company || "")
    .replace(/\{\{lead\.location\}\}/gi,      lead.location || "(not provided)")
    .replace(/\{\{lead\.followUpStage\}\}/gi, lead.followUpStage || "")
    .replace(/\{\{lead\.notes\}\}/gi,         lead.notes || "");

export interface WizardStepPromptParams {
  situation:   { type: SituationType; customPrompt?: string };
  goal:        GoalType;
  tone:        ToneType;
  intensity:   IntensityType;
  stepContext: { stepOrder: number; totalSteps: number; stepType: string };
  previousSteps: {
    stepOrder: number;
    stepType:  string;
    subject:   string | null;
    content:   string | null;
  }[];
  lead: {
    name:           string;
    email:          string | null;
    phone?:         string | null;
    company:        string | null;
    location?:      string | null;
    followUpStage:  string | null;
    notes?:         string | null;
  };
  transcript: string | null;
}

export const buildWizardStepPrompt = (params: WizardStepPromptParams): string => {
  const { situation, goal, tone, intensity, stepContext, previousSteps, lead, transcript } = params;
  const { stepOrder, totalSteps, stepType } = stepContext;

  const isFirstStep = stepOrder === 1;

  // Situation context — step 1 uses opening context, later steps use follow-up context
  let situationText: string;
  if (situation.type === "Custom") {
    situationText = isFirstStep
      ? (situation.customPrompt ?? "").trim()
      : SITUATION_FOLLOWUP_CONTEXT["Custom"];
  } else {
    situationText = isFirstStep
      ? SITUATION_STEP1_CONTEXT[situation.type]
      : SITUATION_FOLLOWUP_CONTEXT[situation.type];
  }

  const positionHint = getIntensityPositionHint(intensity, stepOrder, totalSteps);

  const header = `You are writing Step ${stepOrder} of ${totalSteps} in a follow-up sequence for {{lead.name}} at {{lead.company}}.`;

  const blocks = [
    header,
    "",
    "[SITUATION]",
    situationText,
    "",
    "[GOAL]",
    GOAL_CONTEXT[goal],
    "",
    "[TONE]",
    TONE_INSTRUCTIONS[tone],
    "",
    "[POSITION & INTENSITY]",
    positionHint,
    "",
    "[CTA INSTRUCTION]",
    GOAL_CTA[goal],
    "",
    getStepTypeInstruction(stepType),
  ];

  let prompt = resolveLeadVariables(blocks.join("\n"), lead);

  const prevText = formatPreviousSteps(previousSteps);
  if (prevText) prompt += `\n${prevText}`;

  prompt += `\n\n--- LEAD INFO ---`;
  prompt += `\nName: ${lead.name}`;
  prompt += `\nEmail: ${lead.email ?? "(not provided)"}`;
  if (lead.phone)         prompt += `\nPhone: ${lead.phone}`;
  prompt += `\nCompany: ${lead.company}`;
  if (lead.location)      prompt += `\nLocation: ${lead.location}`;
  if (lead.followUpStage) prompt += `\nFollow-up Stage: ${lead.followUpStage}`;
  if (lead.notes)         prompt += `\nNotes: ${lead.notes}`;

  if (transcript) {
    prompt += `\n\n--- TRANSCRIPT ---\n${transcript}`;
  }

  return prompt;
};
