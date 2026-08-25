// The global `ValidationPipe`, shared by `main.ts` and every test harness
// that boots a real `INestApplication` directly — same reasoning as
// `setup-docs.ts`: the two paths must never drift on how a validation
// failure becomes a `ValidationProblem` body (openapi.yaml). Flattens
// `class-validator`'s nested `ValidationError[]` into the flat
// `{ field, message }[]` shape `ProblemJsonExceptionFilter` reads back out
// of the thrown `BadRequestException`.
import { BadRequestException, ValidationPipe, type ValidationError } from '@nestjs/common';

function flattenValidationErrors(errors: readonly ValidationError[]): { field: string; message: string }[] {
  return errors.flatMap((error) => {
    const ownMessages = Object.values(error.constraints ?? {}).map((message) => ({ field: error.property, message }));
    const nested = error.children ? flattenValidationErrors(error.children) : [];
    return [...ownMessages, ...nested];
  });
}

export function createValidationPipe(): ValidationPipe {
  return new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: false,
    transform: true,
    exceptionFactory: (errors) => new BadRequestException({ errors: flattenValidationErrors(errors) }),
  });
}
