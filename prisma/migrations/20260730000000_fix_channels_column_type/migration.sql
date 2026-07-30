-- Drop the array default first; otherwise Postgres cannot cast the default to JSONB.
ALTER TABLE "sequences"
  ALTER COLUMN "channels" DROP DEFAULT;

-- Convert channels from array type (TEXT[] / JSONB[]) to JSONB.
-- Existing values like {EMAIL} become ["EMAIL"] — data is preserved.
ALTER TABLE "sequences"
  ALTER COLUMN "channels" TYPE JSONB
  USING to_json("channels")::jsonb;
