import { readFile } from "node:fs/promises";
import path from "node:path";
import { getPool } from "@/server/db/client";

async function main() {
  const schema = await readFile(path.join(process.cwd(), "src/server/db/schema.sql"), "utf8");
  await getPool().query(schema);
}

main()
  .then(() => {
    console.log("Database migration completed.");
    process.exit(0);
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
