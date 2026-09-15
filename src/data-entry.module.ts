import { Module } from '@nestjs/common';
import { DataEntryController } from './data-entry.controller';
import { DataEntryService } from './data-entry.service';
import { DuplicateService } from './duplicate.service';
import { EntityMatchingService } from './entity-matching.service';
import { GstService } from './gst.service';
import { MappingService } from './mapping.service';
import { AccountingValidationService } from './accounting-validation.service';

@Module({
  controllers: [DataEntryController],
  providers: [
    DataEntryService,
    MappingService,
    EntityMatchingService,
    GstService,
    DuplicateService,
    AccountingValidationService,
  ],
  exports: [
    DataEntryService,
    MappingService,
    EntityMatchingService,
    GstService,
    DuplicateService,
    AccountingValidationService,
  ],
})
export class DataEntryModule {}
