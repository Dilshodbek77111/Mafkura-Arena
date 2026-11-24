import { isActiveWindow, nextActiveAt } from './time';

export class ReadOnlyError extends Error {
  constructor(public readonly reopensAt: Date) { super('READ_ONLY'); }
}

/** Yozuvchi (o'zgartiruvchi) amallar boshida chaqiriladi: 01:00–11:00 da ReadOnlyError tashlaydi. */
export function assertWriteAllowed(now: Date): void {
  if (!isActiveWindow(now)) throw new ReadOnlyError(nextActiveAt(now));
}
