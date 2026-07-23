import { createRepositories } from "@/server/db/repositories";
import { getPool } from "@/server/db/client";

async function main() {
  const repositories = createRepositories();
  const user = await repositories.users.ensureDefault();
  const pool = getPool();
  const agent = await pool.query<{ id: string }>(
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
     RETURNING id`,
    [user.id],
  );
  await pool.query(
    `INSERT INTO conversations (user_id, agent_id, title)
     SELECT $1, $2, $3
     WHERE NOT EXISTS (
       SELECT 1
       FROM conversations
       WHERE user_id = $1
         AND agent_id = $2
         AND channel = 'web'
     )`,
    [user.id, agent.rows[0].id, "和 DigitalMate 的对话"],
  );
  console.log(`Seeded default user ${user.displayName} and agent ${agent.rows[0].id}.`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
