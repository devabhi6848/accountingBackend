import { Module } from '@nestjs/common';
import { DataEntryController } from './data-entry.controller';
import { DataEntryService } from './data-entry.service';

@Module({
  controllers: [DataEntryController],
  providers: [DataEntryService],
  exports: [DataEntryService],
})
export class DataEntryModule {}
