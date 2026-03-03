import dotenv from "dotenv";
import path from "path";

dotenv.config({ path: path.join(process.cwd(), ".env") });

const config = {
  port: Number(process.env.PORT) || 5000,
  env: process.env.NODE_ENV || "development",
  database_url: process.env.DATABASE_URL as string,
};

export default config;
