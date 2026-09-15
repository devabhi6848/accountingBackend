import {
  BadRequestException,
  Controller,
  Post,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { DataEntryService } from './data-entry.service';

@Controller('data-entry')
export class DataEntryController {
  constructor(private readonly dataEntryService: DataEntryService) {}

  @Post('upload/inspect')
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: 25 * 1024 * 1024 },
      fileFilter: (_req, file, callback) => {
        const allowed = /\.(xlsx|xls|csv)$/i.test(file.originalname);
        callback(allowed ? null : new BadRequestException('Only XLSX, XLS and CSV files are supported.'), allowed);
      },
    }),
  )
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
}
