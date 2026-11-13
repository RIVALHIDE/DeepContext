import { useState, useCallback } from 'react';

export function useCitationHighlight() {
  const [highlightedIndex, setHighlightedIndex] = useState(null);

  const onHover = useCallback((index) => setHighlightedIndex(index), []);
  const onLeave = useCallback(() => setHighlightedIndex(null), []);

  return { highlightedIndex, onHover, onLeave };
}
