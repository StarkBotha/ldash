import { mkdir, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import type { ExportFile } from './generator.js';

export async function writeExport(files: ExportFile[], outputDir: string): Promise<void> {
  for (const file of files) {
    const absolutePath = join(outputDir, file.relativePath);
    const parentDir = dirname(absolutePath);
    await mkdir(parentDir, { recursive: true });
    await writeFile(absolutePath, file.content, 'utf-8');
  }
}
