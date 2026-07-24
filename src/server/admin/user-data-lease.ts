import type {
  UserDataLease,
  UserDataRequestFence,
} from "@/server/db/repositories";
import { createRepositories } from "@/server/db/repositories";

type UserDataLeaseRepositories = {
  userDataMutations: {
    beginRequest(userId: string): Promise<UserDataRequestFence>;
    acquireSharedLease(fence: UserDataRequestFence): Promise<UserDataLease>;
  };
};

export async function acquireUserDataLease(
  repositories: UserDataLeaseRepositories,
  userId: string,
): Promise<UserDataLease> {
  const fence = await repositories.userDataMutations.beginRequest(userId);
  return repositories.userDataMutations.acquireSharedLease(fence);
}

export async function withUserDataLease<T>(
  repositories: UserDataLeaseRepositories,
  userId: string,
  work: (lease: UserDataLease) => Promise<T>,
): Promise<T> {
  const lease = await acquireUserDataLease(repositories, userId);
  try {
    return await work(lease);
  } finally {
    await lease.release();
  }
}

export async function withFreshUserDataLease<T>(
  userId: string,
  work: (repositories: ReturnType<typeof createRepositories>) => Promise<T>,
): Promise<T> {
  const repositories = createRepositories();
  return withUserDataLease(repositories, userId, () => work(repositories));
}
