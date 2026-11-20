export const MAX_KNOWLEDGE_FILE_BYTES = 15 * 1024 * 1024;

export const SUPPORTED_KNOWLEDGE_EXTENSIONS = new Set([
  '.pdf', '.png', '.jpg', '.jpeg', '.txt', '.md', '.puml', '.mmd', '.mermaid',
  '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.csv', '.json', '.jsonl',
  '.yaml', '.yml', '.xml', '.html', '.htm', '.log', '.rst',
]);

export function fileExtension(fileName) {
  const dot = String(fileName || '').lastIndexOf('.');
  return dot >= 0 ? String(fileName).slice(dot).toLowerCase() : '';
}

export function knowledgeFileError(file) {
  if (!file) return 'Choose a file';
  if (file.size > MAX_KNOWLEDGE_FILE_BYTES) return 'Larger than 15MB';
  if (!SUPPORTED_KNOWLEDGE_EXTENSIONS.has(fileExtension(file.name))) return 'Unsupported knowledge format';
  return '';
}
