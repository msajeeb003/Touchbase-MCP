/**
 * Zod 4, for MCP tool schemas only.
 *
 * The MCP SDK needs Zod 4.2 or newer to turn a schema into the JSON Schema it
 * advertises to Claude. The rest of the backend stays on Zod 3 ("zod").
 * "zod4" is the same library installed a second time under another name
 * (see package.json), and src/mcp/ is the only place that imports it.
 */
export { z } from "zod4";
