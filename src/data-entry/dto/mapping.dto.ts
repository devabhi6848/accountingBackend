import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  ValidateNested,
} from 'class-validator';
import { CANONICAL_IMPORT_FIELDS, CanonicalImportField } from '../../config/import.constants';

export class ImportColumnMappingDto {
  @IsString()
  sourceColumn!: string;

  @IsOptional()
  @IsString()
  @IsIn(CANONICAL_IMPORT_FIELDS as unknown as string[])
  targetField?: CanonicalImportField | null;

  @IsOptional()
  @IsBoolean()
  confirmed?: boolean;
}

export class SaveImportMappingDto {
  @IsArray()
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => ImportColumnMappingDto)
  mappings!: ImportColumnMappingDto[];
}
