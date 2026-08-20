import { describe, expect, it } from 'vitest';
import { AppController } from './app.controller';

describe('AppController (billing)', () => {
  it('answers a health-ish payload identifying the service', () => {
    const controller = new AppController();

    expect(controller.getRoot()).toEqual({ service: 'billing', status: 'ok' });
  });
});
