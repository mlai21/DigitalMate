import "fake-indexeddb/auto";

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import {
  chmod,
  mkdir,
  open,
  readFile,
  rename,
  rm,
} from "node:fs/promises";
import path from "node:path";
import {
  deserialize,
  serialize,
} from "node:v8";

const MAGIC = Buffer.from("DMATRIX1", "ascii");
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

export type MatrixCryptoStoreIdentity = Readonly<{
  userId: string;
  agentId: string;
  connectionId: string;
}>;

export function defaultMatrixCryptoStorageRoot(): string {
  return path.join(
    process.cwd(),
    "data",
    "matrix",
    "connections",
  );
}

export async function deleteMatrixCryptoStoreDirectory(
  rootDir: string,
  connectionId: string,
): Promise<void> {
  const identity = validateIdentity({
    userId: "deletion-scope",
    agentId: "deletion-scope",
    connectionId,
  });
  const directory = path.resolve(
    rootDir,
    identity.connectionId,
  );
  assertContainedPath(rootDir, directory);
  await rm(directory, { recursive: true, force: true });
}

type PersistedIndex = Readonly<{
  name: string;
  keyPath: string | readonly string[];
  unique: boolean;
  multiEntry: boolean;
}>;

type PersistedStore = Readonly<{
  name: string;
  keyPath: string | readonly string[] | null;
  autoIncrement: boolean;
  indexes: readonly PersistedIndex[];
  records: readonly Readonly<{
    key: IDBValidKey;
    value: unknown;
  }>[];
}>;

type PersistedDatabase = Readonly<{
  name: string;
  version: number;
  stores: readonly PersistedStore[];
}>;

type MatrixStoreEnvelope = Readonly<{
  version: 1;
  identity: MatrixCryptoStoreIdentity;
  syncToken: string | null;
  databases: readonly PersistedDatabase[];
}>;

let indexedDbTail: Promise<void> = Promise.resolve();

export function createMatrixCryptoStore(input: Readonly<{
  rootDir: string;
  identity: MatrixCryptoStoreIdentity;
  encryptionKey: Uint8Array;
}>) {
  const identity = validateIdentity(input.identity);
  const encryptionKey = validateEncryptionKey(input.encryptionKey);
  const directory = path.resolve(
    input.rootDir,
    identity.connectionId,
  );
  assertContainedPath(input.rootDir, directory);
  const filePath = path.join(directory, "crypto-store.bin");
  const databasePrefix = `digitalmate-matrix-${
    createHash("sha256")
      .update(identity.userId)
      .update("\0")
      .update(identity.agentId)
      .update("\0")
      .update(identity.connectionId)
      .digest("hex")
      .slice(0, 32)
  }`;

  return {
    filePath,
    databasePrefix,

    async prepare(): Promise<string | null> {
      return withIndexedDbLock(async () => {
        const envelope = await readEnvelope(
          filePath,
          encryptionKey,
        );
        if (!envelope) return null;
        assertIdentity(envelope.identity, identity);
        await restoreDatabases(
          envelope.databases.filter((database) =>
            database.name.startsWith(databasePrefix)
          ),
        );
        return envelope.syncToken;
      });
    },

    async flush(syncToken: string | null): Promise<void> {
      await withIndexedDbLock(async () => {
        const databases = await snapshotDatabases(
          databasePrefix,
        );
        await writeEnvelope(
          directory,
          filePath,
          encryptionKey,
          {
            version: 1,
            identity,
            syncToken,
            databases,
          },
        );
      });
    },
  };
}

async function snapshotDatabases(
  prefix: string,
): Promise<PersistedDatabase[]> {
  const databases = await indexedDB.databases();
  const snapshots: PersistedDatabase[] = [];
  for (const info of databases) {
    if (!info.name?.startsWith(prefix)) continue;
    const database = await openDatabase(info.name);
    try {
      snapshots.push(await snapshotDatabase(database));
    } finally {
      database.close();
    }
  }
  return snapshots;
}

async function snapshotDatabase(
  database: IDBDatabase,
): Promise<PersistedDatabase> {
  const names = Array.from(database.objectStoreNames);
  if (names.length === 0) {
    return {
      name: database.name,
      version: database.version,
      stores: [],
    };
  }
  const transaction = database.transaction(names, "readonly");
  const stores = await Promise.all(names.map(async (name) => {
    const store = transaction.objectStore(name);
    const [keys, values] = await Promise.all([
      requestResult(store.getAllKeys()),
      requestResult(store.getAll()),
    ]);
    return {
      name,
      keyPath: cloneKeyPath(store.keyPath),
      autoIncrement: store.autoIncrement,
      indexes: Array.from(store.indexNames).map((indexName) => {
        const index = store.index(indexName);
        return {
          name: index.name,
          keyPath: cloneKeyPath(index.keyPath)!,
          unique: index.unique,
          multiEntry: index.multiEntry,
        };
      }),
      records: values.map((value, index) => ({
        key: keys[index]!,
        value,
      })),
    } satisfies PersistedStore;
  }));
  await transactionDone(transaction);
  return {
    name: database.name,
    version: database.version,
    stores,
  };
}

async function restoreDatabases(
  databases: readonly PersistedDatabase[],
): Promise<void> {
  for (const database of databases) {
    await deleteDatabase(database.name);
    const restored = await createDatabase(database);
    try {
      if (database.stores.length === 0) continue;
      const transaction = restored.transaction(
        database.stores.map((store) => store.name),
        "readwrite",
      );
      for (const storeSnapshot of database.stores) {
        const store = transaction.objectStore(
          storeSnapshot.name,
        );
        for (const record of storeSnapshot.records) {
          if (store.keyPath === null) {
            store.put(record.value, record.key);
          } else {
            store.put(record.value);
          }
        }
      }
      await transactionDone(transaction);
    } finally {
      restored.close();
    }
  }
}

function createDatabase(
  snapshot: PersistedDatabase,
): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(
      snapshot.name,
      snapshot.version,
    );
    request.onupgradeneeded = () => {
      const database = request.result;
      for (const storeSnapshot of snapshot.stores) {
        const keyPath = storeSnapshot.keyPath;
        const store = database.createObjectStore(
          storeSnapshot.name,
          {
            keyPath:
              typeof keyPath === "string" || keyPath === null
                ? keyPath
                : Array.from(keyPath),
            autoIncrement: storeSnapshot.autoIncrement,
          },
        );
        for (const index of storeSnapshot.indexes) {
          store.createIndex(index.name, index.keyPath, {
            unique: index.unique,
            multiEntry: index.multiEntry,
          });
        }
      }
    };
    request.onerror = () =>
      reject(new Error("matrix_crypto_store_restore_failed"));
    request.onsuccess = () => resolve(request.result);
  });
}

function openDatabase(name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name);
    request.onerror = () =>
      reject(new Error("matrix_crypto_store_open_failed"));
    request.onsuccess = () => resolve(request.result);
  });
}

function deleteDatabase(name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(name);
    request.onerror = () =>
      reject(new Error("matrix_crypto_store_restore_failed"));
    request.onblocked = () =>
      reject(new Error("matrix_crypto_store_busy"));
    request.onsuccess = () => resolve();
  });
}

function requestResult<T>(
  request: IDBRequest<T>,
): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onerror = () =>
      reject(new Error("matrix_crypto_store_snapshot_failed"));
    request.onsuccess = () => resolve(request.result);
  });
}

function transactionDone(
  transaction: IDBTransaction,
): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () =>
      reject(new Error("matrix_crypto_store_transaction_failed"));
    transaction.onabort = () =>
      reject(new Error("matrix_crypto_store_transaction_failed"));
  });
}

async function writeEnvelope(
  directory: string,
  filePath: string,
  encryptionKey: Buffer,
  envelope: MatrixStoreEnvelope,
): Promise<void> {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv(
    "aes-256-gcm",
    encryptionKey,
    nonce,
  );
  cipher.setAAD(MAGIC);
  const ciphertext = Buffer.concat([
    cipher.update(serialize(envelope)),
    cipher.final(),
  ]);
  const bytes = Buffer.concat([
    MAGIC,
    nonce,
    cipher.getAuthTag(),
    ciphertext,
  ]);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const tempPath = path.join(
    directory,
    `.crypto-store-${process.pid}-${randomBytes(8).toString("hex")}.tmp`,
  );
  try {
    const handle = await open(tempPath, "wx", 0o600);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(tempPath, filePath);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function readEnvelope(
  filePath: string,
  encryptionKey: Buffer,
): Promise<MatrixStoreEnvelope | null> {
  let bytes: Buffer;
  try {
    bytes = await readFile(filePath);
  } catch (error) {
    if (
      error instanceof Error
      && "code" in error
      && error.code === "ENOENT"
    ) {
      return null;
    }
    throw error;
  }
  if (
    bytes.length < MAGIC.length + NONCE_BYTES + TAG_BYTES
    || !bytes.subarray(0, MAGIC.length).equals(MAGIC)
  ) {
    throw new Error("matrix_crypto_store_invalid");
  }
  try {
    const nonceStart = MAGIC.length;
    const tagStart = nonceStart + NONCE_BYTES;
    const ciphertextStart = tagStart + TAG_BYTES;
    const decipher = createDecipheriv(
      "aes-256-gcm",
      encryptionKey,
      bytes.subarray(nonceStart, tagStart),
    );
    decipher.setAAD(MAGIC);
    decipher.setAuthTag(
      bytes.subarray(tagStart, ciphertextStart),
    );
    const plaintext = Buffer.concat([
      decipher.update(bytes.subarray(ciphertextStart)),
      decipher.final(),
    ]);
    const envelope = deserialize(plaintext) as MatrixStoreEnvelope;
    if (
      envelope.version !== 1
      || !Array.isArray(envelope.databases)
    ) {
      throw new Error("matrix_crypto_store_invalid");
    }
    return envelope;
  } catch {
    throw new Error("matrix_crypto_store_decrypt_failed");
  }
}

function validateIdentity(
  identity: MatrixCryptoStoreIdentity,
): MatrixCryptoStoreIdentity {
  const values = [
    identity.userId,
    identity.agentId,
    identity.connectionId,
  ];
  if (
    values.some((value) =>
      typeof value !== "string"
      || value.length === 0
      || value.length > 512
      || /[\u0000-\u001f\u007f]/u.test(value)
    )
    || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(
      identity.connectionId,
    )
  ) {
    throw new Error("matrix_crypto_store_identity_invalid");
  }
  return Object.freeze({ ...identity });
}

function assertIdentity(
  actual: MatrixCryptoStoreIdentity,
  expected: MatrixCryptoStoreIdentity,
): void {
  if (
    actual.userId !== expected.userId
    || actual.agentId !== expected.agentId
    || actual.connectionId !== expected.connectionId
  ) {
    throw new Error("matrix_crypto_store_identity_mismatch");
  }
}

function validateEncryptionKey(
  value: Uint8Array,
): Buffer {
  if (value.byteLength !== 32) {
    throw new Error("matrix_crypto_store_key_invalid");
  }
  return Buffer.from(value);
}

function cloneKeyPath(
  value: string | string[] | null,
): string | readonly string[] | null {
  return Array.isArray(value) ? [...value] : value;
}

function assertContainedPath(
  rootDir: string,
  target: string,
): void {
  const root = path.resolve(rootDir);
  if (
    target !== root
    && !target.startsWith(`${root}${path.sep}`)
  ) {
    throw new Error("matrix_crypto_store_path_invalid");
  }
}

function withIndexedDbLock<T>(
  operation: () => Promise<T>,
): Promise<T> {
  const current = indexedDbTail.then(operation, operation);
  indexedDbTail = current.then(
    () => undefined,
    () => undefined,
  );
  return current;
}
