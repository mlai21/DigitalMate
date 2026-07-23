import { createRepositories } from "@/server/db/repositories";
import { getPool } from "@/server/db/client";

async function main() {
  const repositories = createRepositories();
  const user = await repositories.users.ensureDefault();
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1::text, 1146050617))", [user.id]);
    const existingDefault = await client.query<{ id: string }>(
      "SELECT id FROM digital_agents WHERE user_id = $1 AND is_default = true LIMIT 1",
      [user.id],
    );
    let agentId = existingDefault.rows[0]?.id;

    if (!agentId) {
      const ensuredDefault = await client.query<{ id: string }>(
        `INSERT INTO digital_agents (user_id, slug, display_name, persona, is_default)
         VALUES (
           $1,
           'digitalmate',
           'DigitalMate',
           COALESCE((SELECT persona FROM settings WHERE user_id = $1), '{}'::jsonb),
           true
         )
         ON CONFLICT (user_id, slug) DO UPDATE
         SET is_default = true,
             updated_at = now()
         WHERE NOT EXISTS (
           SELECT 1
           FROM digital_agents AS selected_default
           WHERE selected_default.user_id = EXCLUDED.user_id
             AND selected_default.is_default = true
         )
         RETURNING id`,
        [user.id],
      );
      agentId = ensuredDefault.rows[0]?.id;
    }

    if (!agentId) {
      const selectedDefault = await client.query<{ id: string }>(
        "SELECT id FROM digital_agents WHERE user_id = $1 AND is_default = true LIMIT 1",
        [user.id],
      );
      agentId = selectedDefault.rows[0]?.id;
    }
    if (!agentId) throw new Error("default_agent_not_created");

    await client.query(
      `INSERT INTO conversations (user_id, agent_id, title)
       SELECT $1, $2, $3
       WHERE NOT EXISTS (
         SELECT 1
         FROM conversations
         WHERE user_id = $1
           AND agent_id = $2
           AND channel = 'web'
       )`,
      [user.id, agentId, "和 DigitalMate 的对话"],
    );
    await client.query("COMMIT");
    console.log(`Seeded default user ${user.displayName} and agent ${agentId}.`);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
