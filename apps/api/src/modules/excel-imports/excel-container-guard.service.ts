import { Injectable } from '@nestjs/common';
import { basename } from 'node:path';
import { DomainError } from '@auto-work/contracts';
import * as yauzl from 'yauzl';
import type { ExcelContainerFacts } from './excel-import.types.js';

const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_ENTRIES = 2_000;
const MAX_UNCOMPRESSED_BYTES = 64 * 1024 * 1024;
const MAX_ENTRY_RATIO = 200;
const XLSX_MIME_TYPES = new Set([
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/octet-stream',
  'application/zip',
]);

@Injectable()
export class ExcelContainerGuardService {
  public async inspect(input: {
    buffer: Buffer;
    fileName: string;
    mimeType: string;
  }): Promise<ExcelContainerFacts> {
    const fileName = this.safeFileName(input.fileName);
    if (input.buffer.length === 0 || input.buffer.length > MAX_FILE_BYTES) {
      throw new DomainError('EXCEL_FILE_SIZE_INVALID', 'Excel 文件必须大于 0 且不超过 8 MiB', {
        httpStatus: 413,
      });
    }
    if (!XLSX_MIME_TYPES.has(input.mimeType.toLocaleLowerCase())) {
      throw new DomainError('EXCEL_MIME_TYPE_INVALID', '上传内容类型不是允许的 XLSX 类型', {
        httpStatus: 415,
      });
    }
    const zipSignature = input.buffer.subarray(0, 4).toString('hex');
    if (!['504b0304', '504b0506', '504b0708'].includes(zipSignature)) {
      throw new DomainError('EXCEL_CONTAINER_INVALID', '文件不是有效的 XLSX ZIP 容器', {
        httpStatus: 422,
      });
    }

    try {
      const zip = await new Promise<yauzl.ZipFile>((resolvePromise, reject) => {
        yauzl.fromBuffer(
          input.buffer,
          { lazyEntries: true, validateEntrySizes: true, strictFileNames: true },
          (error, opened) => {
            if (error || !opened) reject(error ?? new Error('ZIP open returned no handle'));
            else resolvePromise(opened);
          },
        );
      });
      let entryCount = 0;
      let compressedBytes = 0;
      let uncompressedBytes = 0;
      let hasContentTypes = false;
      let hasWorkbook = false;
      let hasRootRelationships = false;
      let hasExternalLinks = false;
      let hasConnections = false;
      let contentTypesEntry: yauzl.Entry | null = null;
      await new Promise<void>((resolvePromise, reject) => {
        let settled = false;
        const fail = (error: unknown) => {
          if (settled) return;
          settled = true;
          zip.close();
          reject(error instanceof Error ? error : new Error('XLSX ZIP 校验失败'));
        };
        zip.once('error', fail);
        zip.once('end', () => {
          if (settled) return;
          settled = true;
          resolvePromise();
        });
        zip.on('entry', (entry: yauzl.Entry) => {
          try {
            entryCount += 1;
            compressedBytes += entry.compressedSize;
            uncompressedBytes += entry.uncompressedSize;
            if (entryCount > MAX_ENTRIES || uncompressedBytes > MAX_UNCOMPRESSED_BYTES) {
              throw new DomainError('EXCEL_ZIP_BOMB_REJECTED', 'XLSX 解压规模超过安全上限', {
                httpStatus: 422,
              });
            }
            if (
              entry.uncompressedSize > 0 &&
              (entry.compressedSize === 0 ||
                entry.uncompressedSize / entry.compressedSize > MAX_ENTRY_RATIO)
            ) {
              throw new DomainError('EXCEL_ZIP_RATIO_REJECTED', 'XLSX 条目压缩比超过安全上限', {
                httpStatus: 422,
              });
            }
            if ((entry.generalPurposeBitFlag & 0x1) !== 0) {
              throw new DomainError('EXCEL_ENCRYPTED_REJECTED', '不支持加密 XLSX 文件', {
                httpStatus: 422,
              });
            }
            const path = entry.fileName.toLocaleLowerCase();
            hasContentTypes ||= path === '[content_types].xml';
            if (path === '[content_types].xml') contentTypesEntry = entry;
            hasWorkbook ||= path === 'xl/workbook.xml';
            hasRootRelationships ||= path === '_rels/.rels';
            hasExternalLinks ||= path.startsWith('xl/externallinks/');
            hasConnections ||= path === 'xl/connections.xml';
            if (
              path === 'xl/vbaproject.bin' ||
              path.endsWith('/vbaproject.bin') ||
              path.endsWith('.xlsm')
            ) {
              throw new DomainError('EXCEL_MACRO_REJECTED', '检测到宏内容，系统只接受无宏 XLSX', {
                httpStatus: 422,
              });
            }
            zip.readEntry();
          } catch (error) {
            fail(error);
          }
        });
        zip.readEntry();
      });
      if (!contentTypesEntry) {
        throw new DomainError('EXCEL_STRUCTURE_INVALID', 'XLSX 缺少内容类型清单', {
          httpStatus: 422,
        });
      }
      const contentTypesXml = await this.readSmallEntry(zip, contentTypesEntry);
      if (
        /macroenabled|vbaproject|application\/vnd\.ms-excel\.(?:sheet|template)/iu.test(
          contentTypesXml,
        )
      ) {
        throw new DomainError('EXCEL_MACRO_REJECTED', '内容类型清单表明工作簿支持宏', {
          httpStatus: 422,
        });
      }
      if (!hasContentTypes || !hasWorkbook || !hasRootRelationships) {
        throw new DomainError('EXCEL_STRUCTURE_INVALID', 'XLSX 缺少必需的 Open XML 结构', {
          httpStatus: 422,
        });
      }
      return {
        fileName,
        entryCount,
        compressedBytes,
        uncompressedBytes,
        hasExternalLinks,
        hasConnections,
      };
    } catch (error) {
      if (error instanceof DomainError) throw error;
      throw new DomainError('EXCEL_CONTAINER_INVALID', 'XLSX ZIP 中央目录损坏或不符合规范', {
        httpStatus: 422,
        details: { reason: error instanceof Error ? error.message.slice(0, 200) : 'unknown' },
      });
    }
  }

  private safeFileName(value: string): string {
    const normalized = stripControlCharacters(value.normalize('NFC')).trim();
    if (
      !normalized ||
      normalized.length > 255 ||
      basename(normalized) !== normalized ||
      !normalized.toLocaleLowerCase().endsWith('.xlsx')
    ) {
      throw new DomainError('EXCEL_FILE_NAME_INVALID', '文件名必须是无路径的 .xlsx 名称', {
        httpStatus: 422,
      });
    }
    return normalized;
  }

  private async readSmallEntry(zip: yauzl.ZipFile, entry: yauzl.Entry): Promise<string> {
    const stream = await new Promise<NodeJS.ReadableStream>((resolvePromise, reject) => {
      zip.openReadStream(entry, (error, opened) => {
        if (error || !opened) reject(error ?? new Error('ZIP entry stream unavailable'));
        else resolvePromise(opened);
      });
    });
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of stream) {
      const buffer = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : Buffer.from(chunk);
      size += buffer.length;
      if (size > 1024 * 1024) {
        throw new DomainError('EXCEL_STRUCTURE_INVALID', 'XLSX 内容类型清单异常过大', {
          httpStatus: 422,
        });
      }
      chunks.push(buffer);
    }
    return Buffer.concat(chunks).toString('utf8');
  }
}

function stripControlCharacters(value: string): string {
  return [...value]
    .filter((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code >= 32 && code !== 127;
    })
    .join('');
}
