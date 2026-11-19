// Imported first by the stdio launcher, before anything else is loaded.
//
// Over stdio, STDOUT IS THE PROTOCOL: every byte written there must be an MCP
// message. So before any other module can print:
//  1. the .env loader is told to stay silent (it prints a tip line otherwise);
//  2. console.log / info / debug are pointed at stderr.
//
// The launcher may be started from any folder (the Claude desktop app decides),
// so the working folder is moved to the backend root, where the .env file is.
import path from "path";

process.env.DOTENV_CONFIG_QUIET = "true";

const toStderr = (...args: unknown[]) => console.error(...args);
console.log = toStderr;
console.info = toStderr;
console.debug = toStderr;

process.chdir(path.resolve(__dirname, "..", ".."));
