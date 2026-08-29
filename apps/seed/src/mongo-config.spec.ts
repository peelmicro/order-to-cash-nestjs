// `loadMongoConfig`/`mongoConnectionUri` are pure functions of an env
// object (no I/O, no Docker) — R (feature 34, sonarqube_quality_gates):
// this file was previously 0%-covered only because nothing in the unit
// suite imported it, not because it needs a live MongoDB. Driven with a
// fake `NodeJS.ProcessEnv` here, exactly the same shape `verify.spec.ts`
// already drives `verify.ts`'s pure section with.
import { describe, expect, it } from 'vitest';
import { loadMongoConfig, mongoConnectionUri } from './mongo-config';

describe('loadMongoConfig', () => {
  it('reads every field from the given env', () => {
    const config = loadMongoConfig({
      MONGO_HOST: 'mongo.internal',
      MONGO_HOST_PORT: '27018',
      MONGO_INITDB_ROOT_USERNAME: 'root_user',
      MONGO_INITDB_ROOT_PASSWORD: 'root_pass',
      MONGO_DB_READMODEL: 'otc_read_model_test',
    });

    expect(config).toEqual({
      host: 'mongo.internal',
      port: 27018,
      user: 'root_user',
      password: 'root_pass',
      database: 'otc_read_model_test',
    });
  });

  it('falls back to the documented defaults when the env carries none of the keys', () => {
    const config = loadMongoConfig({});

    expect(config).toEqual({
      host: 'localhost',
      port: 27017,
      user: 'otc_mongo_root',
      password: 'otc_mongo_dev_password',
      database: 'otc_read_model',
    });
  });

  it('defaults to process.env when no env is passed', () => {
    expect(() => loadMongoConfig()).not.toThrow();
  });
});

describe('mongoConnectionUri', () => {
  it('builds an authSource=admin URI with plain credentials URL-encoded', () => {
    const uri = mongoConnectionUri({
      host: 'localhost',
      port: 27017,
      user: 'otc_mongo_root',
      password: 'otc_mongo_dev_password',
      database: 'otc_read_model',
    });

    expect(uri).toBe(
      'mongodb://otc_mongo_root:otc_mongo_dev_password@localhost:27017/?authSource=admin',
    );
  });

  it('percent-encodes credential characters that are not URL-safe', () => {
    const uri = mongoConnectionUri({
      host: 'localhost',
      port: 27017,
      user: 'user@name',
      password: 'p@ss:word/with?chars',
      database: 'otc_read_model',
    });

    expect(uri).toBe(
      'mongodb://user%40name:p%40ss%3Aword%2Fwith%3Fchars@localhost:27017/?authSource=admin',
    );
  });
});
