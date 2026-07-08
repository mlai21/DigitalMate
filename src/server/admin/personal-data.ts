export type PersonalDataExportInput = {
  userId: string;
  exportedAt: Date;
  tables: Record<string, unknown[]>;
};

export function buildPersonalDataExport(input: PersonalDataExportInput) {
  return {
    userId: input.userId,
    exportedAt: input.exportedAt.toISOString(),
    tables: input.tables,
  };
}
