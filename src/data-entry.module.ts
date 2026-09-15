import { Module } from '@nestjs/common';
import { DataEntryController } from './data-entry.controller';
import { DataEntryService } from './data-entry.service';
import { MappingService } from './mapping.service';

@Module({
  controllers: [DataEntryController],
  providers: [DataEntryService, MappingService],
  exports: [DataEntryService, MappingService],
})
export class DataEntryModule {}
