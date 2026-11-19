// The build Vercel runs (see vercel.json): set up the database tables if
// asked to, generate the database client, compile TypeScript into dist/.
//
// Setting up tables ("prisma migrate deploy") runs ONLY when the project has
// MIGRATE_ON_BUILD=true. It uses the direct database connection
// (DATABASE_URL_UNPOOLED, which Vercel's Neon connection sets), because table
// changes should not go through the connection pooler. Leave MIGRATE_ON_BUILD
// unset on any project that points at a database you do not want changed.
const { execSync } = require("child_process");
const path = require("path");

const root = path.join(__dirname, "..");
const prisma = `node "${path.join(root, "node_modules", "prisma", "build", "index.js")}"`;
const tsc = `node "${path.join(root, "node_modules", "typescript", "bin", "tsc")}"`;

const run = (label, command, extraEnv = {}) => {
  console.log(`\n[vercel-build] ${label}`);
  execSync(command, { cwd: root, stdio: "inherit", env: { ...process.env, ...extraEnv } });
};

if (process.env.MIGRATE_ON_BUILD === "true") {
  const direct = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL;
  if (!direct) {
    console.error("[vercel-build] MIGRATE_ON_BUILD=true but no DATABASE_URL_UNPOOLED or DATABASE_URL is set.");
    process.exit(1);
  }
  run("Setting up database tables (prisma migrate deploy)", `${prisma} migrate deploy`, {
    DATABASE_URL: direct,
  });
} else {
  console.log("\n[vercel-build] MIGRATE_ON_BUILD is not set: database tables are left as they are.");
}

run("Generating the database client", `${prisma} generate`);
run("Compiling TypeScript into dist/", `${tsc} --sourceMap false --declaration false --declarationMap false`);
