import { Module } from '@nestjs/common';
import { DataEntryController } from './data-entry.controller';
import { DataEntryService } from './data-entry.service';
import { EntityMatchingService } from './entity-matching.service';
import { MappingService } from './mapping.service';

@Module({
  controllers: [DataEntryController],
  providers: [DataEntryService, MappingService, EntityMatchingService],
  exports: [DataEntryService, MappingService, EntityMatchingService],
})
export class DataEntryModule {}
