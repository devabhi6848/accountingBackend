import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { DataEntryModule } from './data-entry.module';
import { DatabaseModule } from './database/database.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
    }),
    DatabaseModule,
    DataEntryModule,
  ],
})
export class AppModule {}
