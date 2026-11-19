// Rule 1 (approval record at activation) and rule 8 (send window at approval).
import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  apiClient,
  makeLead,
  makeSequence,
  makeStep,
  makeUser,
  prisma,
  resetDb,
  startApp,
  tokenFor,
} from "./helpers/setup";
import { computeApprovalHash, currentApprovalHash } from "../src/harness/approval";
import { isInsideSendWindow, type SendWindow } from "../src/harness/send-window";

let app: Awaited<ReturnType<typeof startApp>>;

before(async () => {
  app = await startApp();
});
after(async () => {
  await app.close();
  await prisma.$disconnect();
});
beforeEach(resetDb);

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const draftSequence = async (
  sequenceOverrides: Record<string, unknown>,
  steps: Record<string, unknown>[]
) => {
  const user = await makeUser();
  const lead = await makeLead(user.id);
  const sequence = await makeSequence(user.id, lead.id, {
    status: "draft",
    totalSteps: steps.length,
    ...sequenceOverrides,
  });
  const created = [];
  for (let i = 0; i < steps.length; i++) {
    created.push(
      await makeStep(sequence.id, {
        stepOrder: i + 1,
        status: "draft",
        scheduledAt: new Date(Date.now() + (i + 1) * DAY),
        ...steps[i],
      })
    );
  }
  return { user, lead, sequence, steps: created, api: apiClient(app.url, tokenFor(user)) };
};

test("the hash covers every step's channel, subject and text, and the recipient", () => {
  const base = {
    leadEmail: "lead@example.com",
    leadPhone: "+15550100001",
    steps: [
      { stepOrder: 1, stepType: "EMAIL", subject: "Hello", content: "First" },
      { stepOrder: 2, stepType: "SMS", subject: null, content: "Second" },
    ],
  };
  const hash = computeApprovalHash(base);

  assert.equal(hash, computeApprovalHash({ ...base, steps: [...base.steps].reverse() }), "order of the list does not matter");
  assert.equal(hash, computeApprovalHash({ ...base, leadEmail: " Lead@Example.com " }));

  const changes = [
    { ...base, leadEmail: "other@example.com" },
    { ...base, leadPhone: "+15550100002" },
    { ...base, steps: [{ ...base.steps[0], content: "First!" }, base.steps[1]] },
    { ...base, steps: [{ ...base.steps[0], subject: "Hi" }, base.steps[1]] },
    { ...base, steps: [{ ...base.steps[0], stepType: "SMS" }, base.steps[1]] },
    { ...base, steps: [base.steps[0]] },
    { ...base, steps: [...base.steps, { stepOrder: 3, stepType: "EMAIL", subject: "x", content: "y" }] },
  ];
  for (const changed of changes) {
    assert.notEqual(computeApprovalHash(changed), hash);
  }
});

test("when a person activates a sequence, who, when and what is recorded", async () => {
  const { user, sequence, steps, api } = await draftSequence({}, [{}]);
  const before = Date.now();

  const res = await api("PATCH", `/sequences/${sequence.id}`, { status: "active" });

  assert.equal(res.status, 200);
  const after = await prisma.sequence.findUniqueOrThrow({ where: { id: sequence.id } });
  assert.equal(after.status, "active");
  assert.equal(after.approvalStatus, "approved");
  assert.equal(after.approvedByUserId, user.id);
  assert.ok(after.approvedAt && after.approvedAt.getTime() >= before - 1000);
  assert.equal(after.approvedContentHash, await currentApprovalHash(sequence.id));

  const step = await prisma.sequenceStep.findUniqueOrThrow({ where: { id: steps[0].id } });
  assert.equal(step.status, "scheduled");
});

test("a wizard sequence activates without a timezone and keeps its own dates", async () => {
  const { sequence, steps, api } = await draftSequence({}, [{}, {}]);

  const res = await api("PATCH", `/sequences/${sequence.id}`, { status: "active" });

  assert.equal(res.status, 200);
  for (const original of steps) {
    const step = await prisma.sequenceStep.findUniqueOrThrow({ where: { id: original.id } });
    assert.equal(step.scheduledAt.getTime(), original.scheduledAt.getTime());
  }
});

test("a harness sequence cannot be approved until the user sets a timezone", async () => {
  const { sequence, steps, api } = await draftSequence({ runId: randomUUID() }, [
    { delayMinutes: 0 },
  ]);

  const res = await api("PATCH", `/sequences/${sequence.id}`, { status: "active" });

  assert.equal(res.status, 400);
  assert.equal(
    res.body.message,
    "Set your timezone in Settings before approving. Messages are only sent between 09:00 and 18:00, Monday to Friday, in your own timezone."
  );
  const after = await prisma.sequence.findUniqueOrThrow({ where: { id: sequence.id } });
  assert.equal(after.status, "draft");
  assert.equal(after.approvalStatus, "none");
  assert.equal(after.approvedByUserId, null);
  assert.equal(
    (await prisma.sequenceStep.findUniqueOrThrow({ where: { id: steps[0].id } })).status,
    "draft"
  );
});

test("approving a harness sequence gives every step a real date inside the send window", async () => {
  const { user, sequence, steps, api } = await draftSequence({ runId: randomUUID() }, [
    { delayMinutes: 0 },
    { delayMinutes: 2 * 24 * 60 },
    { delayMinutes: 3 * 24 * 60 },
  ]);
  const setTz = await api("PATCH", "/settings", { sendTimezone: "Asia/Dhaka" });
  assert.equal(setTz.status, 200);
  const window: SendWindow = {
    startMinutes: 9 * 60,
    endMinutes: 18 * 60,
    weekends: false,
    timeZone: "Asia/Dhaka",
  };
  const before = Date.now();

  const res = await api("PATCH", `/sequences/${sequence.id}`, { status: "active" });

  assert.equal(res.status, 200);
  const after = await prisma.sequenceStep.findMany({
    where: { sequenceId: sequence.id },
    orderBy: { stepOrder: "asc" },
  });
  assert.equal(after.length, 3);
  for (const step of after) {
    assert.equal(step.status, "scheduled");
    assert.equal(isInsideSendWindow(step.scheduledAt, window), true, `step ${step.stepOrder}`);
  }
  assert.ok(after[0].scheduledAt.getTime() >= before - 1000, "step 1 is not in the past");
  assert.ok(after[0].scheduledAt.getTime() <= before + 4 * DAY, "step 1 is at the next opening");
  assert.ok(after[1].scheduledAt.getTime() - after[0].scheduledAt.getTime() >= 2 * DAY);
  assert.ok(after[2].scheduledAt.getTime() - after[1].scheduledAt.getTime() >= 3 * DAY);
  // The provisional dates the drafts had are replaced.
  assert.notEqual(after[2].scheduledAt.getTime(), steps[2].scheduledAt.getTime());

  const seq = await prisma.sequence.findUniqueOrThrow({ where: { id: sequence.id } });
  assert.equal(seq.approvalStatus, "approved");
  assert.equal(seq.approvedByUserId, user.id);
  assert.equal(seq.approvedContentHash, await currentApprovalHash(sequence.id));
});

test("resuming a paused sequence records a fresh approval and clears the pause reason", async () => {
  const { user, sequence, api } = await draftSequence({}, [{}]);
  await api("PATCH", `/sequences/${sequence.id}`, { status: "active" });
  await api("PATCH", `/sequences/${sequence.id}`, { status: "paused" });
  const paused = await prisma.sequence.findUniqueOrThrow({ where: { id: sequence.id } });
  assert.equal(paused.pausedReason, "paused_by_user");

  // Something changes while it is paused.
  await prisma.sequenceStep.updateMany({
    where: { sequenceId: sequence.id },
    data: { content: "Edited while paused." },
  });
  assert.notEqual(paused.approvedContentHash, await currentApprovalHash(sequence.id));

  const res = await api("PATCH", `/sequences/${sequence.id}`, { status: "active" });

  assert.equal(res.status, 200);
  const after = await prisma.sequence.findUniqueOrThrow({ where: { id: sequence.id } });
  assert.equal(after.status, "active");
  assert.equal(after.pausedReason, null);
  assert.equal(after.pausedAt, null);
  assert.equal(after.approvedByUserId, user.id);
  assert.equal(after.approvedContentHash, await currentApprovalHash(sequence.id));
});

test("activation needs a login session", async () => {
  const { sequence } = await draftSequence({}, [{}]);

  const noToken = await apiClient(app.url)("PATCH", `/sequences/${sequence.id}`, {
    status: "active",
  });
  assert.equal(noToken.status, 401);

  const accessToken = await apiClient(app.url, "tb_pat_0123456789abcdef0123456789abcdef")(
    "PATCH",
    `/sequences/${sequence.id}`,
    { status: "active" }
  );
  assert.equal(accessToken.status, 401);

  assert.equal(
    (await prisma.sequence.findUniqueOrThrow({ where: { id: sequence.id } })).status,
    "draft"
  );
});
