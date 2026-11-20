export function sourceDisplayName(source = {}) {
  const explicit = String(source.displayName || source.display_name || '').trim();
  if (explicit) return explicit;

  const internal = String(source.sourceName || source.source_name || source.source || source.name || '').trim();
  if (!internal) return '';

  const base = internal.replaceAll('\\', '/').split('/').pop();
  const separator = base.indexOf('__');
  if (separator < 0) return base;

  const prefix = base.slice(0, separator);
  const looksLikeWorkspaceId = prefix.length >= 16 && /^[a-f0-9-]+$/i.test(prefix);
  return looksLikeWorkspaceId ? base.slice(separator + 2) : base;
}
