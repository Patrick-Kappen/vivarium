export interface MarkdownSourceText {
	readonly text: string;
	slice(start: number, end: number): string | undefined;
}

export interface MarkdownSourceRange {
	readonly start: number;
	readonly end: number;
}

/** A lexer-declared removal view; retained intervals still refer to the parent source. */
export class MarkdownSourceView implements MarkdownSourceText {
	readonly text: string;
	private readonly parent: MarkdownSourceText;
	private readonly parts: { start: number; end: number; offset: number }[] = [];

	constructor(parent: MarkdownSourceText, ranges: readonly MarkdownSourceRange[]) {
		this.parent = parent;
		let offset = 0;
		let previousEnd = 0;
		const text: string[] = [];
		for (const { start, end } of ranges) {
			if (
				!Number.isInteger(start) ||
				!Number.isInteger(end) ||
				start < previousEnd ||
				end < start ||
				end > parent.text.length
			)
				throw new RangeError("Invalid Markdown source view range");
			previousEnd = end;
			this.parts.push({ start, end, offset });
			text.push(parent.text.slice(start, end));
			offset += end - start;
		}
		this.text = text.join("");
	}

	slice(start: number, end: number): string | undefined {
		if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || end > this.text.length)
			throw new RangeError("Invalid Markdown source view slice");
		const text: string[] = [];
		let low = 0;
		let high = this.parts.length;
		while (low < high) {
			const middle = (low + high) >>> 1;
			const part = this.parts[middle]!;
			if (part.offset + part.end - part.start <= start) low = middle + 1;
			else high = middle;
		}
		for (let index = low; index < this.parts.length && this.parts[index]!.offset < end; index++) {
			const part = this.parts[index]!;
			const from = Math.max(start, part.offset);
			const to = Math.min(end, part.offset + part.end - part.start);
			if (from >= to) continue;
			const value = this.parent.slice(part.start + from - part.offset, part.start + to - part.offset);
			if (value === undefined) return undefined;
			text.push(value);
		}
		return text.join("");
	}
}
