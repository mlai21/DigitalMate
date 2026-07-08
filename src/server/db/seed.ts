import { createRepositories } from "@/server/db/repositories";

async function main() {
  const repositories = createRepositories();
  const user = await repositories.users.ensureDefault();
  await repositories.conversations.getOrCreateDefault(user.id);
  console.log(`Seeded default user ${user.displayName}.`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
