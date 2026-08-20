import { describe, expect, it } from 'vitest';

import { DomainError } from './domain-error.js';

class SampleDomainError extends DomainError {
  readonly code = 'SAMPLE_ERROR';

  constructor(message: string) {
    super(message);
  }
}

describe('DomainError', () => {
  it('carries a stable code and behaves as a real Error', () => {
    const error = new SampleDomainError('something was refused');

    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(DomainError);
    expect(error.code).toBe('SAMPLE_ERROR');
    expect(error.message).toBe('something was refused');
    expect(error.name).toBe('SampleDomainError');
  });
});
