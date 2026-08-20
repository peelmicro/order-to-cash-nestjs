import { Controller, Get } from '@nestjs/common';

export interface HealthPayload {
  service: string;
  status: 'ok';
}

@Controller()
export class AppController {
  @Get()
  getRoot(): HealthPayload {
    return { service: 'notifications', status: 'ok' };
  }
}
