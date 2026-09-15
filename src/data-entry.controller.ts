import {
  BadRequestException,
  Controller,
  Headers,
  Post,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { DataEntryService } from './data-entry.service';

const uploadOptions = {
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: (_req: unknown, file: Express.Multer.File, callback: (error: Error | null, acceptFile: boolean) => void) => {
    const allowed = /\.(xlsx|xls|csv)$/i.test(file.originalname);
    callback(allowed ? null : new BadRequestException('Only XLSX, XLS and CSV files are supported.'), allowed);
  },
};

@Controller('data-entry')
export class DataEntryController {
  constructor(private readonly dataEntryService: DataEntryService) {}

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
  async upload(
    @UploadedFile() file: Express.Multer.File,
    @Headers('x-company-id') companyId: string,
    @Headers('x-user-id') userId: string,
  ) {
    if (!file) throw new BadRequestException('A file is required.');
    if (!companyId || !userId) {
      throw new BadRequestException('x-company-id and x-user-id headers are required until authentication is integrated.');
    }

    const result = await this.dataEntryService.createImport(file, companyId, userId);
    return {
      success: true,
      data: {
        importId: result.imported.id,
        fileName: result.imported.fileName,
        fileType: result.imported.fileType,
        sheetName: result.imported.sheetName,
        status: result.imported.status,
        totalRows: result.imported.totalRows,
        columns: result.parsed.headers,
        mappingSuggestions: result.parsed.mappingSuggestions,
        previewRows: result.parsed.rows.slice(0, 20),
      },
    };
  }
}
