// AI call scripts: the prompt asks for the seven call sections only, and the
// saved text is cleaned when the AI writes an email first or uses markdown.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CALL_OUTPUT_RULES,
  buildPrompt,
  cleanCallScript,
  parseAIResponse,
} from "../src/shared/services/prompt-builder";
import { buildWizardStepPrompt } from "../src/shared/services/prompt-composer";

// The reply a user saw in the app: an email, "---", then the call sections in markdown.
const EMAIL_THEN_SCRIPT = `Subject: Next Steps on the Project

Hi Kierra,

I wanted to touch base regarding the project we discussed.

Best,
Artur

---

**GREETING:** Hi Kierra, this is Artur from Artech Digital. I hope you're doing well today!
**SENDER:** Artur from Artech Digital.
**OBJECTIVE:** To discuss rescheduling our call and clarify next steps on the project.
**BACKGROUND:** Kierra previously canceled our scheduled call.
**KEY POINTS:**
- Emphasize the importance of discussing the project.
- Ask for her availability to reschedule the call.
**QUESTIONS:**
- What does your schedule look like this week for a quick chat?
**CLOSING:** I'm looking forward to reconnecting and moving forward!`;

test("a call script loses the email written before GREETING and the markdown markers", () => {
  const { subject, content } = parseAIResponse(EMAIL_THEN_SCRIPT, "CALL");

  assert.equal(subject, null);
  assert.ok(content.startsWith("GREETING: Hi Kierra, this is Artur"), content.slice(0, 80));
  assert.ok(!content.includes("Subject:"));
  assert.ok(!content.includes("Best,"));
  assert.ok(!content.includes("---"));
  assert.ok(!content.includes("**"));
  for (const header of ["SENDER:", "OBJECTIVE:", "BACKGROUND:", "KEY POINTS:", "QUESTIONS:", "CLOSING:"]) {
    assert.ok(content.includes(header), `keeps ${header}`);
  }
  assert.ok(content.includes("- Ask for her availability to reschedule the call."));
});

test("a clean call script is left as it is, and one without GREETING is kept whole", () => {
  const clean = "GREETING: Hi Ben, Sam from Brightside here.\nSENDER: Sam, Brightside\nOBJECTIVE: Book a quote call.";
  assert.equal(cleanCallScript(clean), clean);

  const odd = "## Notes for the agent\n* Ask about the vans\n* Offer Friday";
  assert.equal(cleanCallScript(odd), "Notes for the agent\n- Ask about the vans\n- Offer Friday");
});

test("email, SMS and WhatsApp replies are not touched by the call clean-up", () => {
  const email = parseAIResponse("SUBJECT: Hello\n**Bold** body", "EMAIL");
  assert.deepEqual(email, { subject: "Hello", content: "**Bold** body" });
  assert.equal(parseAIResponse("  *Hi* there  ", "WHATSAPP").content, "*Hi* there");
  assert.equal(parseAIResponse("Hi **there**", "SMS").content, "Hi **there**");
});

const lead = { name: "Kierra", email: "kierra@example.com", company: "Example Co", followUpStage: "No-show" };

test("both prompt builders put the call output rules after the call sections", () => {
  const wizard = buildWizardStepPrompt({
    promptText: "Write ONE message. Sign off as Artur.",
    goal: "Book another call",
    tone: "Friendly & Professional",
    intensity: "Standard",
    stepContext: { stepOrder: 3, totalSteps: 5, stepType: "CALL" },
    previousSteps: [],
    lead,
    transcript: null,
  });
  const plain = buildPrompt({
    promptText: "Write ONE message.",
    stepContext: { stepOrder: 3, totalSteps: 5, stepType: "CALL" },
    previousSteps: [],
    lead,
    transcript: null,
  });

  for (const prompt of [wizard, plain]) {
    assert.ok(prompt.includes(CALL_OUTPUT_RULES));
    assert.ok(prompt.indexOf("CLOSING:") < prompt.indexOf(CALL_OUTPUT_RULES));
  }

  const emailPrompt = buildPrompt({
    promptText: "Write ONE message.",
    stepContext: { stepOrder: 1, totalSteps: 5, stepType: "EMAIL" },
    previousSteps: [],
    lead,
    transcript: null,
  });
  assert.ok(!emailPrompt.includes(CALL_OUTPUT_RULES));
});
