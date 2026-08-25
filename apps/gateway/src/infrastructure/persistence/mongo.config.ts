// Connection configuration for the READ-ONLY connection onto the
// projector's `order_timeline` read model — same shape
// apps/projector/src/infrastructure/persistence/mongo.config.ts
// establishes (this feature reads the SAME collection that service
// writes, never a second copy of it: R54).
export interface MongoConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
}

export function loadMongoConfig(env: NodeJS.ProcessEnv = process.env): MongoConfig {
  return {
    host: env.MONGO_HOST ?? 'localhost',
    port: Number(env.MONGO_HOST_PORT ?? 27017),
    user: env.MONGO_INITDB_ROOT_USERNAME ?? 'otc_mongo_root',
    password: env.MONGO_INITDB_ROOT_PASSWORD ?? 'otc_mongo_dev_password',
    database: env.MONGO_DB_READMODEL ?? 'otc_read_model',
  };
}

export function mongoConnectionUri(config: MongoConfig): string {
  const user = encodeURIComponent(config.user);
  const password = encodeURIComponent(config.password);
  return `mongodb://${user}:${password}@${config.host}:${config.port}/?authSource=admin`;
}
