export type DiffLine = {
  type: "context" | "added" | "removed";
  text: string;
};

/**
 * Minimal LCS-based line diff for rendering skill revision previews in the
 * admin console. Skill documents are small, so O(n*m) is fine.
 */
export function buildLineDiff(oldText: string, newText: string): DiffLine[] {
  const oldLines = oldText.split(/\r?\n/);
  const newLines = newText.split(/\r?\n/);

  const rows = oldLines.length;
  const cols = newLines.length;
  const lcs: number[][] = Array.from({ length: rows + 1 }, () => new Array<number>(cols + 1).fill(0));
  for (let i = rows - 1; i >= 0; i -= 1) {
    for (let j = cols - 1; j >= 0; j -= 1) {
      lcs[i][j] = oldLines[i] === newLines[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }

  const diff: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < rows && j < cols) {
    if (oldLines[i] === newLines[j]) {
      diff.push({ type: "context", text: oldLines[i] });
      i += 1;
      j += 1;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      diff.push({ type: "removed", text: oldLines[i] });
      i += 1;
    } else {
      diff.push({ type: "added", text: newLines[j] });
      j += 1;
    }
  }
  while (i < rows) {
    diff.push({ type: "removed", text: oldLines[i] });
    i += 1;
  }
  while (j < cols) {
    diff.push({ type: "added", text: newLines[j] });
    j += 1;
  }
  return diff;
}
