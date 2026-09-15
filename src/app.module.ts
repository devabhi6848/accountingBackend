import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { DataEntryModule } from './data-entry.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
    }),
    DataEntryModule,
  ],
})
export class AppModule {}
