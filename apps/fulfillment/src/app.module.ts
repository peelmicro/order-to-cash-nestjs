import { Module } from '@nestjs/common';
import { AppController } from './presentation/app.controller';

@Module({
  controllers: [AppController],
  providers: [],
})
export class AppModule {}
