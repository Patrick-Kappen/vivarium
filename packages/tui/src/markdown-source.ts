interface NormalizationEdit {
	readonly start: number;
	readonly end: number;
	readonly sourceStart: number;
	readonly sourceEnd: number;
}

/** The existing Markdown tab/newline normalization, with original UTF-16 boundaries. */
export class MarkdownSource {
	readonly text: string;
	private readonly edits: NormalizationEdit[] = [];
	private readonly original: string;

	constructor(original: string) {
		this.original = original;
		const parts: string[] = [];
		let cursor = 0;
		let length = 0;
		for (const match of original.matchAll(/\t|\r\n|\r/g)) {
			const prefix = original.slice(cursor, match.index);
			const replacement = match[0] === "\t" ? "   " : "\n";
			parts.push(prefix, replacement);
			length += prefix.length;
			cursor = match.index + match[0].length;
			this.edits.push({
				start: length,
				end: length + replacement.length,
				sourceStart: match.index,
				sourceEnd: cursor,
			});
			length += replacement.length;
		}
		parts.push(original.slice(cursor));
		this.text = parts.join("");
	}

	private offset(position: number, end: boolean): number {
		let low = 0;
		let high = this.edits.length;
		while (low < high) {
			const middle = (low + high) >>> 1;
			if (this.edits[middle]!.start <= position) low = middle + 1;
			else high = middle;
		}
		const edit = this.edits[low - 1];
		if (!edit) return position;
		if (position === edit.start) return edit.sourceStart;
		if (position < edit.end) return end ? edit.sourceEnd : edit.sourceStart;
		return position + edit.sourceEnd - edit.end;
	}

	/** A visible portion of an expanded tab still refers to its one original character. */
	range(start: number, end: number): { start: number; end: number } {
		if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || end > this.text.length)
			throw new RangeError("Invalid normalized Markdown range");
		return { start: this.offset(start, false), end: this.offset(end, end !== start) };
	}

	/** Lexer slices must not cut through a normalization replacement. */
	slice(start: number, end: number): string | undefined {
		const range = this.range(start, end);
		if (this.offset(start, true) !== range.start || this.offset(end, false) !== range.end) return undefined;
		return this.original.slice(range.start, range.end);
	}
}
