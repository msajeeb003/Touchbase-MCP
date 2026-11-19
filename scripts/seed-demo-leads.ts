// Puts the twenty invented demo leads into the LOCAL database, for one user.
//
//   node --import tsx scripts/seed-demo-leads.ts <user email>            dry run: shows what it would add
//   node --import tsx scripts/seed-demo-leads.ts <user email> --write    adds them
//
// Safety:
//  - refuses to run unless DATABASE_URL points at this computer;
//  - every lead is invented and on example.com (see scripts/demo-data.ts);
//  - safe to run twice: a lead that is already there (same email or name) is skipped.
import "../src/config";
import prisma from "../src/shared/prisma";
import { markLeadDoNotContact } from "../src/harness/do-not-contact";
import { DEMO_LEADS, DEMO_TEMPLATE, type DemoLead } from "./demo-data";

const DAY = 86_400_000;
const ago = (days: number) => new Date(Date.now() - days * DAY);

/** Saves one demo lead with its calls, reply and do-not-contact mark. Used by the scenario test too. */
export const saveDemoLead = async (userId: string, demo: DemoLead): Promise<string> => {
  const created = await prisma.lead.create({
    data: {
      userId,
      name: demo.name,
      company: demo.company,
      email: demo.email,
      phone: demo.phone,
      followUpStage: demo.stage,
      notes: demo.notes,
    },
  });

  for (const saved of [demo.call, demo.earlierCall]) {
    if (!saved) continue;
    const long = "long" in saved && saved.long === true;
    await prisma.leadTranscript.create({
      data: {
        userId,
        leadId: created.id,
        source: "manual",
        meetingTitle: saved.title,
        meetingDate: ago(saved.daysAgo),
        // A long call is about 45,000 characters, so it has to be read in three parts.
        transcript: long ? `${saved.text}\n\n`.repeat(Math.ceil(45_000 / (saved.text.length + 2))) : saved.text,
      },
    });
  }

  if (demo.repliedDaysAgo !== undefined && demo.email) {
    await prisma.leadInboundEmail.create({
      data: {
        userId,
        leadId: created.id,
        messageId: `demo-reply-${created.id}@example.com`,
        fromEmail: demo.email,
        fromName: demo.name,
        subject: "Re: our demo",
        bodyText: "[SYNTHETIC TEST REPLY] Thanks, I will come back to you next week.",
        receivedAt: ago(demo.repliedDaysAgo),
      },
    });
  }

  if (demo.doNotContact) {
    await markLeadDoNotContact({
      userId,
      leadId: created.id,
      reason: "Demo data: asked not to be contacted",
      source: "user",
    });
  }

  return created.id;
};

export const saveDemoTemplate = async (userId: string) =>
  prisma.promptTemplate.upsert({
    where: { userId_followUpStage: { userId, followUpStage: DEMO_TEMPLATE.followUpStage } },
    update: {},
    create: { userId, ...DEMO_TEMPLATE },
  });

const main = async () => {
  const url = new URL(process.env.DATABASE_URL ?? "postgresql://missing/missing");
  if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
    throw new Error(`Refusing to run: DATABASE_URL is not a local database (${url.hostname}).`);
  }

  const args = process.argv.slice(2);
  const email = args.find((arg) => !arg.startsWith("--"));
  const write = args.includes("--write");
  if (!email) {
    throw new Error("Usage: node --import tsx scripts/seed-demo-leads.ts <user email> [--write]");
  }

  const user = await prisma.user.findUnique({ where: { email }, select: { id: true } });
  if (!user) throw new Error(`No Touchbase user with the email ${email}`);

  const existing = await prisma.lead.findMany({
    where: { userId: user.id },
    select: { email: true, name: true },
  });
  const emails = new Set(existing.map((l) => (l.email ?? "").toLowerCase()));
  const names = new Set(existing.map((l) => l.name));
  const missing = DEMO_LEADS.filter(
    (demo) => !names.has(demo.name) && !(demo.email && emails.has(demo.email.toLowerCase()))
  );

  console.log(
    `${DEMO_LEADS.length} demo leads; ${DEMO_LEADS.length - missing.length} already there, ${missing.length} to add.` +
      (write ? "" : " Dry run: nothing is written (add --write).")
  );
  if (!write) return;

  await saveDemoTemplate(user.id);
  for (const demo of missing) await saveDemoLead(user.id, demo);
  console.log(`Added ${missing.length} lead(s) and the template "${DEMO_TEMPLATE.name}".`);
};

if (require.main === module) {
  main()
    .catch((error) => {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    })
    .finally(() => new Promise((resolve) => setTimeout(resolve, 300)))
    .finally(() => prisma.$disconnect());
}
