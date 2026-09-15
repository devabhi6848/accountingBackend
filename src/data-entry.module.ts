import { Module } from '@nestjs/common';
import { DataEntryController } from './data-entry.controller';
import { DataEntryService } from './data-entry.service';
import { DuplicateService } from './data-entry/duplicate.service';
import { EntityMatchingService } from './data-entry/entity-matching.service';
import { GstService } from './data-entry/gst.service';
import { MappingService } from './data-entry/mapping.service';
import { AccountingValidationService } from './data-entry/accounting-validation.service';
import { PostingService } from './data-entry/posting.service';

@Module({
  controllers: [DataEntryController],
  providers: [
    DataEntryService,
    MappingService,
    EntityMatchingService,
    GstService,
    DuplicateService,
    AccountingValidationService,
    PostingService,
  ],
  exports: [
    DataEntryService,
    MappingService,
    EntityMatchingService,
    GstService,
    DuplicateService,
    AccountingValidationService,
    PostingService,
  ],
})
export class DataEntryModule {}
