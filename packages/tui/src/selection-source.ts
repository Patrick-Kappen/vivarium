import type { CopySource } from "./selection-map.ts";

/** One resolved source per emission slot, without retaining old render recipes. */
export interface CopySourceCache {
	source?: CopySource;
}

/** Each render owns its result; equal text shares identity regardless of resolution order. */
export function deferCopySource(cache: CopySourceCache, text: () => string): () => CopySource {
	let resolved: CopySource | undefined;
	return () => {
		if (resolved) return resolved;
		const value = text();
		if (cache.source?.text !== value) cache.source = { text: value };
		resolved = cache.source;
		return resolved;
	};
}
