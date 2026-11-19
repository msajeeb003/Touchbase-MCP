// Adds invented "lead replies" to the LOCAL database, for demos and manual testing.
//
// Reply tracking reads a real mailbox, which a local server must never do.
// This script puts a few made-up replies in the database instead, so the
// "no reply in N days" filters and the pause-on-reply rule can be seen working.
//
//   node --import tsx scripts/add-synthetic-replies.ts            dry run: shows what it would add
//   node --import tsx scripts/add-synthetic-replies.ts --write    adds them
//
// Safety:
//  - refuses to run unless DATABASE_URL points at this computer;
//  - only touches leads whose email address ends with @example.com;
//  - safe to run twice: a lead that already has its synthetic reply is skipped.
import "../src/config";
import prisma from "../src/shared/prisma";
import { pauseActiveSequencesForLead } from "../src/harness/pause";

const REPLIES = [
  "Thanks for the note. Can we talk on Thursday afternoon?",
  "Got your message. I need to check with my manager first, back to you next week.",
  "Please send the pricing sheet again, I cannot find it.",
  "Not a good time this month. Try me again in January.",
  "Yes, still interested. What are the next steps?",
  "I am out of the office until Monday and will reply then.",
];

/** One lead in every three gets a reply, so both groups exist for the filters. */
const EVERY_NTH_LEAD = 3;

const main = async () => {
  const url = new URL(process.env.DATABASE_URL ?? "postgresql://missing/missing");
  if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
    throw new Error(
      `Refusing to run: DATABASE_URL is not a local database (${url.hostname}).`
    );
  }

  const write = process.argv.includes("--write");

  const leads = await prisma.lead.findMany({
    where: { email: { endsWith: "@example.com" } },
    orderBy: [{ userId: "asc" }, { createdAt: "asc" }],
    select: { id: true, userId: true, name: true, email: true },
  });

  const chosen = leads.filter((_, index) => index % EVERY_NTH_LEAD === 0);
  console.log(
    `${leads.length} synthetic lead(s) found on ${url.hostname}/${url.pathname.slice(1)}; ` +
      `${chosen.length} chosen for a reply.${write ? "" : " Dry run: nothing is written (add --write)."}`
  );

  let added = 0;
  let skipped = 0;
  let paused = 0;

  for (const [index, lead] of chosen.entries()) {
    const messageId = `synthetic-reply-${lead.id}@example.com`;
    const existing = await prisma.leadInboundEmail.findFirst({
      where: { userId: lead.userId, messageId },
      select: { id: true },
    });

    if (existing) {
      skipped++;
      continue;
    }

    if (!write) {
      console.log(`  would add a reply from ${lead.name} <${lead.email}>`);
      continue;
    }

    const receivedAt = new Date();
    await prisma.leadInboundEmail.create({
      data: {
        userId: lead.userId,
        leadId: lead.id,
        messageId,
        fromEmail: lead.email!.toLowerCase(),
        fromName: lead.name,
        subject: "Re: following up",
        bodyText: `[SYNTHETIC TEST REPLY] ${REPLIES[index % REPLIES.length]}`,
        receivedAt,
      },
    });
    added++;

    // The same rule the mailbox poller applies: a reply pauses the running sequence.
    const pausedIds = await pauseActiveSequencesForLead(lead.id, "lead_replied", {
      onlyIfStartedBefore: receivedAt,
    });
    paused += pausedIds.length;
  }

  if (write) {
    console.log(
      `Added ${added} reply(ies), skipped ${skipped} that were already there, paused ${paused} running sequence(s).`
    );
  } else if (skipped > 0) {
    console.log(`  ${skipped} lead(s) already have their synthetic reply.`);
  }
};

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  // give the activity log's background writes a moment before closing
  .finally(() => new Promise((resolve) => setTimeout(resolve, 300)))
  .finally(() => prisma.$disconnect());
