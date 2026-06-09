export async function triggerExport(projectId: string): Promise<{ outputDir: string; fileCount: number }> {
  const res = await fetch(`/api/projects/${projectId}/export`, {
    method: 'POST',
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error((err as { error: string }).error);
  }
  return res.json() as Promise<{ outputDir: string; fileCount: number }>;
}
