// DI-metadata divergence probe (review_orders_acceptance.md §12, Part 2 of
// the cross-cutting fix). A minimal reproduction of the exact hazard: a
// provider with BARE-TYPE constructor injection — no `@Inject(TOKEN)` — the
// idiom `@nestjs/cqrs` `@CommandHandler`/`@EventsHandler` classes use
// (feature 16 is the first such graph in this repository).
//
// Under a compiler that emits `design:paramtypes` (`tsc`, with
// `emitDecoratorMetadata: true` — `tsconfig.base.json`), Nest resolves the
// dependency correctly. Under a compiler that does NOT
// (`tsx`/esbuild — the OLD `dev` script), Nest's container still builds
// (it never throws), but the dependency silently resolves to `undefined`.
//
// Run directly with `tsx` to reproduce the OLD failure, or compiled with
// `tsc` (matching `tsc-watch`'s own compiler, the FIXED `dev` script) to
// see it resolve correctly — see main-di-metadata.spec.ts for both, proved
// as real child-process runs rather than asserted from documentation.
//
// Test-support only: excluded from the build artefact by
// tsconfig.build.json's `src/**/test-support/**` exclude (D5).
import 'reflect-metadata';
import { Injectable, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';

@Injectable()
class Dependency {
  readonly marker = 'DEPENDENCY_RESOLVED';
}

@Injectable()
class ConsumerWithBareTypeInjection {
  // Deliberately NO @Inject(...) — bare-type constructor injection.
  constructor(private readonly dependency: Dependency) {}

  describe(): string {
    return this.dependency ? this.dependency.marker : 'DEPENDENCY_UNDEFINED';
  }
}

@Module({ providers: [Dependency, ConsumerWithBareTypeInjection] })
class ProbeModule {}

async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(ProbeModule, { logger: false });
  const consumer = app.get(ConsumerWithBareTypeInjection);
  console.log(`DI_RESULT:${consumer.describe()}`);
  await app.close();
}

void main();
