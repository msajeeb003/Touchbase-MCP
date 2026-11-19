// Makes an access token for Claude, for one Touchbase user.
//
//   node --import tsx scripts/create-mcp-token.ts <user email> [token name] [days]
//
// The token is printed ONCE. Only its hash is stored, so it cannot be shown
// again: if it is lost, revoke it and make a new one.
//
// With the token, Claude can act for that user through the MCP server only.
// It cannot log in to the app, and it cannot activate a sequence, clear
// do-not-contact or change settings: those need a person's login.
import "../src/config";
import prisma from "../src/shared/prisma";
import { TokenService } from "../src/harness/tokens/token.service";

const main = async () => {
  const [email, name = "Claude", days] = process.argv.slice(2);

  if (!email) {
    throw new Error(
      "Usage: node --import tsx scripts/create-mcp-token.ts <user email> [token name] [days]"
    );
  }

  const user = await prisma.user.findUnique({
    where: { email },
    select: { id: true, email: true },
  });

  if (!user) {
    throw new Error(`No Touchbase user with the email ${email}`);
  }

  const created = await TokenService.createToken(user.id, {
    name,
    expiresInDays: days ? Number(days) : undefined,
  });

  console.log("");
  console.log(`Access token for ${user.email} ("${created.name}")`);
  console.log(`Valid until ${created.expiresAt?.toISOString().slice(0, 10)}`);
  console.log("");
  console.log(created.token);
  console.log("");
  console.log("Copy it now. It is not stored and cannot be shown again.");
};

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
