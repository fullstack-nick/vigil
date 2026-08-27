import type { Connector } from "@google-cloud/cloud-sql-connector";
import { readFile } from "node:fs/promises";
import { Pool, type PoolClient, type PoolConfig } from "pg";

export interface Database {
  pool: Pool;
  close(): Promise<void>;
}

export async function createDatabase(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<Database> {
  let connector: Connector | undefined;
  let poolConfig: PoolConfig;

  if (environment.DATABASE_URL) {
    poolConfig = {
      connectionString: environment.DATABASE_URL,
      max: Number(environment.DB_POOL_SIZE ?? "10"),
      application_name: environment.SERVICE_NAME ?? "vigil",
    };
  } else if (environment.DB_HOST) {
    poolConfig = {
      host: environment.DB_HOST,
      port: Number(environment.DB_PORT ?? "5432"),
      user: required(environment, "DB_USER"),
      password: await databasePassword(environment),
      database: required(environment, "DB_NAME"),
      max: Number(environment.DB_POOL_SIZE ?? "10"),
      application_name: environment.SERVICE_NAME ?? "vigil",
    };
  } else {
    const instanceConnectionName = required(environment, "INSTANCE_CONNECTION_NAME");
    const [{ Connector: CloudSqlConnector, IpAddressTypes }] = await Promise.all([
      import("@google-cloud/cloud-sql-connector"),
    ]);
    connector = new CloudSqlConnector();
    const connectionOptions = await connector.getOptions({
      instanceConnectionName,
      ipType: IpAddressTypes.PRIVATE,
    });
    poolConfig = {
      ...connectionOptions,
      user: required(environment, "DB_USER"),
      password: await databasePassword(environment),
      database: required(environment, "DB_NAME"),
      max: Number(environment.DB_POOL_SIZE ?? "10"),
      application_name: environment.SERVICE_NAME ?? "vigil",
    };
  }

  const pool = new Pool(poolConfig);
  pool.on("error", (error) => {
    process.stderr.write(
      `${JSON.stringify({ level: "error", message: "postgres idle client error", error: error.message })}\n`,
    );
  });

  return {
    pool,
    async close() {
      await pool.end();
      connector?.close();
    },
  };
}

async function databasePassword(environment: NodeJS.ProcessEnv): Promise<string> {
  if (environment.DB_PASSWORD) return environment.DB_PASSWORD;
  const passwordFile = environment.DB_PASSWORD_FILE;
  if (passwordFile) {
    const value = (await readFile(passwordFile, "utf8")).trim();
    if (value) return value;
  }
  throw new Error("Missing required environment variable DB_PASSWORD or DB_PASSWORD_FILE");
}

export async function withTransaction<T>(
  database: Database,
  operation: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await database.pool.connect();
  try {
    await client.query("BEGIN");
    const result = await operation(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

function required(environment: NodeJS.ProcessEnv, key: string): string {
  const value = environment[key];
  if (!value) {
    throw new Error(`Missing required environment variable ${key}`);
  }
  return value;
}
