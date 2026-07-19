import { Module } from '@nestjs/common';
import { ExcelContainerGuardService } from './excel-container-guard.service.js';
import { ExcelImportCommitService } from './excel-import-commit.service.js';
import { ExcelImportPreviewService } from './excel-import-preview.service.js';
import { ExcelImportsController } from './excel-imports.controller.js';
import { ExcelWorkbookParserService } from './excel-workbook-parser.service.js';

@Module({
  controllers: [ExcelImportsController],
  providers: [
    ExcelContainerGuardService,
    ExcelWorkbookParserService,
    ExcelImportPreviewService,
    ExcelImportCommitService,
  ],
  exports: [ExcelImportPreviewService],
})
export class ExcelImportsModule {}
