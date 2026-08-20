// Connection configuration for the `order_timeline` read model, read from
// the process environment (see .env.example § MongoDB). No app owns a Mongo
// client yet (apps/projector is still a scaffold — see feature_list.json),
// so this is the first one; apps/projector should follow the same shape
// when it lands (same "plain parts, no interpolated DATABASE_URL" reasoning
// as apps/orders' db-config.ts).
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
