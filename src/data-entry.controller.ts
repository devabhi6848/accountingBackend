import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  Param,
  Post,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { DataEntryService } from './data-entry.service';
import { DuplicateService } from './data-entry/duplicate.service';
import { EntityMatchingService } from './data-entry/entity-matching.service';
import { GstService } from './data-entry/gst.service';
import { MappingService } from './data-entry/mapping.service';
import { AccountingValidationService } from './data-entry/accounting-validation.service';
import { PostingService } from './data-entry/posting.service';
import { SaveImportMappingDto } from './data-entry/dto/mapping.dto';

const uploadOptions = {
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: (_req: unknown, file: Express.Multer.File, callback: (error: Error | null, acceptFile: boolean) => void) => {
    const allowed = /\.(xlsx|xls|csv)$/i.test(file.originalname);
    callback(allowed ? null : new BadRequestException('Only XLSX, XLS and CSV files are supported.'), allowed);
  },
};

@Controller('data-entry')
export class DataEntryController {
  constructor(
    private readonly dataEntryService: DataEntryService,
    private readonly mappingService: MappingService,
    private readonly entityMatchingService: EntityMatchingService,
    private readonly gstService: GstService,
    private readonly duplicateService: DuplicateService,
    private readonly accountingValidationService: AccountingValidationService,
    private readonly postingService: PostingService,
  ) {}

  @Post('upload/inspect')
  @UseInterceptors(FileInterceptor('file', uploadOptions))
  inspectUpload(@UploadedFile() file: Express.Multer.File) {
    const parsed = this.dataEntryService.parseFile(file);
    return {
      success: true,
      data: {
        fileName: parsed.fileName,
        fileType: parsed.fileType,
        sheetName: parsed.sheetName,
        totalRows: parsed.rows.length,
        columns: parsed.headers,
        mappingSuggestions: parsed.mappingSuggestions,
        previewRows: parsed.rows.slice(0, 20),
      },
    };
  }

  @Post('upload')
  @UseInterceptors(FileInterceptor('file', uploadOptions))
  async upload(@UploadedFile() file: Express.Multer.File, @Headers('x-company-id') companyId: string, @Headers('x-user-id') userId: string) {
    if (!file) throw new BadRequestException('A file is required.');
    if (!companyId || !userId) throw new BadRequestException('x-company-id and x-user-id headers are required until authentication is integrated.');
    const result = await this.dataEntryService.createImport(file, companyId, userId);
    return { success: true, data: { importId: result.imported.id, fileName: result.imported.fileName, fileType: result.imported.fileType, sheetName: result.imported.sheetName, status: result.imported.status, totalRows: result.imported.totalRows, columns: result.parsed.headers, mappingSuggestions: result.parsed.mappingSuggestions, previewRows: result.parsed.rows.slice(0, 20) } };
  }

  @Get(':importId/mapping')
  getMapping(@Param('importId') importId: string, @Headers('x-company-id') companyId: string) {
    if (!companyId) throw new BadRequestException('x-company-id header is required until authentication is integrated.');
    return this.mappingService.getMapping(importId, companyId).then((data) => ({ success: true, data }));
  }

  @Post(':importId/mapping')
  saveMapping(@Param('importId') importId: string, @Headers('x-company-id') companyId: string, @Body() dto: SaveImportMappingDto) {
    if (!companyId) throw new BadRequestException('x-company-id header is required until authentication is integrated.');
    return this.mappingService.saveMapping(importId, companyId, dto).then((data) => ({ success: true, data }));
  }

  @Post(':importId/mapping/confirm')
  confirmMapping(@Param('importId') importId: string, @Headers('x-company-id') companyId: string) {
    if (!companyId) throw new BadRequestException('x-company-id header is required until authentication is integrated.');
    return this.mappingService.confirmMapping(importId, companyId).then((data) => ({ success: true, data }));
  }

  @Post(':importId/match')
  matchEntities(@Param('importId') importId: string, @Headers('x-company-id') companyId: string) {
    if (!companyId) throw new BadRequestException('x-company-id header is required until authentication is integrated.');
    return this.entityMatchingService.matchImport(importId, companyId).then((data) => ({ success: true, data }));
  }

  @Get(':importId/matches')
  getMatches(@Param('importId') importId: string, @Headers('x-company-id') companyId: string) {
    if (!companyId) throw new BadRequestException('x-company-id header is required until authentication is integrated.');
    return this.entityMatchingService.getMatches(importId, companyId).then((data) => ({ success: true, data }));
  }

  @Post(':importId/gst/validate')
  validateGst(@Param('importId') importId: string, @Headers('x-company-id') companyId: string) {
    if (!companyId) throw new BadRequestException('x-company-id header is required until authentication is integrated.');
    return this.gstService.validateImport(importId, companyId).then((data) => ({ success: true, data }));
  }

  @Post(':importId/duplicates/detect')
  detectDuplicates(@Param('importId') importId: string, @Headers('x-company-id') companyId: string) {
    if (!companyId) throw new BadRequestException('x-company-id header is required until authentication is integrated.');
    return this.duplicateService.detectDuplicates(importId, companyId).then((data) => ({ success: true, data }));
  }

  @Get(':importId/duplicates')
  getDuplicates(@Param('importId') importId: string, @Headers('x-company-id') companyId: string) {
    if (!companyId) throw new BadRequestException('x-company-id header is required until authentication is integrated.');
    return this.duplicateService.getDuplicates(importId, companyId).then((data) => ({ success: true, data }));
  }

  @Post(':importId/accounting/validate')
  validateAccounting(@Param('importId') importId: string, @Headers('x-company-id') companyId: string) {
    if (!companyId) throw new BadRequestException('x-company-id header is required until authentication is integrated.');
    return this.accountingValidationService.validateImport(importId, companyId).then((data) => ({ success: true, data }));
  }

  @Get(':importId/accounting/preview')
  getAccountingPreview(@Param('importId') importId: string, @Headers('x-company-id') companyId: string) {
    if (!companyId) throw new BadRequestException('x-company-id header is required until authentication is integrated.');
    return this.accountingValidationService.getPreview(importId, companyId).then((data) => ({ success: true, data }));
  }

  @Post(':importId/post')
  postImport(@Param('importId') importId: string, @Headers('x-company-id') companyId: string, @Headers('x-user-id') userId: string) {
    if (!companyId || !userId) throw new BadRequestException('x-company-id and x-user-id headers are required until authentication is integrated.');
    return this.postingService.postImport(importId, companyId, userId).then((data) => ({ success: true, data }));
  }

  @Get(':importId/posted')
  getPosted(@Param('importId') importId: string, @Headers('x-company-id') companyId: string) {
    if (!companyId) throw new BadRequestException('x-company-id header is required until authentication is integrated.');
    return this.postingService.getPosted(importId, companyId).then((data) => ({ success: true, data }));
  }
}
