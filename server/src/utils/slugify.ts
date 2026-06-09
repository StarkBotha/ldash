export function slugify(text: string): string {
  let result = text.toLowerCase();
  // Replace any character that is not a-z, 0-9, or - with -
  result = result.replace(/[^a-z0-9-]/g, '-');
  // Collapse runs of two or more consecutive hyphens
  result = result.replace(/-{2,}/g, '-');
  // Trim leading and trailing hyphens
  result = result.replace(/^-+|-+$/g, '');
  // Truncate to 50 characters
  result = result.slice(0, 50);
  // Trim again in case truncation left a trailing hyphen
  result = result.replace(/^-+|-+$/g, '');
  // If empty, return 'untitled'
  return result === '' ? 'untitled' : result;
}
