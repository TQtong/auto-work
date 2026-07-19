import { v7 as uuidv7 } from 'uuid';

/** UUIDv7 在全局唯一的同时大体按时间有序，适合 SQLite 索引和审计排序。 */
export function newId(): string {
  return uuidv7();
}
