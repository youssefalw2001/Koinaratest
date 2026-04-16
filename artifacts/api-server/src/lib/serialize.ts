export function serializeDates(obj: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(obj)) {
    if (val instanceof Date) {
      result[key] = val.toISOString();
    } else {
      result[key] = val;
    }
  }
  return result;
}

export function serializeRow<T extends Record<string, unknown>>(row: T): T {
  return serializeDates(row) as T;
}

export function serializeRows<T extends Record<string, unknown>>(rows: T[]): T[] {
  return rows.map(serializeRow);
}
