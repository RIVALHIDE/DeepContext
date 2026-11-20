export function sourceInternalName(source = {}) {
  return String(source.sourceName || source.source_name || source.source || source.name || '').trim();
}

export function sourceDisplayName(source = {}) {
  const explicit = String(source.displayName || source.display_name || '').trim();
  if (explicit) return explicit;

  const internal = sourceInternalName(source);
  if (!internal) return '';

  const base = internal.replaceAll('\\', '/').split('/').pop();
  const separator = base.indexOf('__');
  if (separator < 0) return base;

  const prefix = base.slice(0, separator);
  const looksLikeWorkspaceId = prefix.length >= 16 && /^[a-f0-9-]+$/i.test(prefix);
  return looksLikeWorkspaceId ? base.slice(separator + 2) : base;
}

export function sourcesForDocuments(sources = [], documents = []) {
  const documentsBySource = new Map(
    (documents || [])
      .map((document) => [String(document?.name || '').trim().toLowerCase(), document])
      .filter(([name]) => name)
  );

  return (sources || []).flatMap((source) => {
    const internal = sourceInternalName(source).toLowerCase();
    const document = documentsBySource.get(internal);
    if (!document) return [];
    return [{
      ...source,
      displayName: document.displayName || document.display_name || document.name,
    }];
  });
}
