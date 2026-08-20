import { describe, expect, it } from 'vitest';
import { AppController } from './app.controller';

describe('AppController (orders)', () => {
  it('answers a health-ish payload identifying the service', () => {
    const controller = new AppController();

    expect(controller.getRoot()).toEqual({ service: 'orders', status: 'ok' });
  });
});
