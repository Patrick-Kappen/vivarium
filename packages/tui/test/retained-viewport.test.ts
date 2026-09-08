import assert from "node:assert/strict";
import { test } from "node:test";
import { AltScreenSearchIndex } from "../src/alt-screen-search.ts";
import { HStack } from "../src/components/h-stack.ts";
import { ScrollView } from "../src/components/scroll-view.ts";
import { Text } from "../src/components/text.ts";
import { VStack } from "../src/components/v-stack.ts";
import { getScrollViewBox, renderLayoutFrame, repaintLayoutFrame } from "../src/layout.ts";
import { getSelectionMap, snapshotSelectionLines } from "../src/selection-map.ts";
import { encodeKitty, registerKittyImageMetadata } from "../src/terminal-image.ts";
import { type Component, Container } from "../src/tui.ts";
import { TuiAltScreen } from "../src/tui-alt-screen.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

class CountedText extends Text {
	renders = 0;
	override render(width: number): string[] {
		this.renders++;
		return super.render(width);
	}
}

function history(count = 200): string {
	return Array.from({ length: count }, (_, row) => `row ${row}: \x1b[33mstyled\x1b[39m text`).join("\n");
}

test("repainting retains exact content snapshots and copies geometry without rerendering", () => {
	const text = new CountedText(history(), 0, 0);
	const scroll = new ScrollView(text, { scrollbar: "auto", follow: "end" });
	const dock = new CountedText("editor", 0, 0);
	const root = new VStack([{ component: scroll, basis: 0, grow: 1 }, dock]);
	let previous = renderLayoutFrame(root, 40, 12, () => {});
	const source = getScrollViewBox(previous, scroll)?.scrollContentLines;
	assert.ok(source);
	const map = getSelectionMap(source);
	for (const delta of [-1, -8, -25, 10, 24]) {
		const before = getScrollViewBox(previous, scroll)?.children[0]?.rect.y;
		scroll.scrollBy(delta);
		const renders = text.renders;
		const dockRenders = dock.renders;
		const next = repaintLayoutFrame(previous);
		assert.ok(next);
		assert.equal(text.renders, renders);
		assert.equal(dock.renders, dockRenders);
		assert.equal(getScrollViewBox(next, scroll)?.scrollContentLines, source);
		assert.equal(getSelectionMap(source), map);
		assert.equal(getScrollViewBox(previous, scroll)?.children[0]?.rect.y, before);
		assert.deepEqual(next.lines, renderLayoutFrame(root, 40, 12, () => {}).lines);
		previous = next;
	}
});

test("repainting nested and horizontal panes matches a fresh layout", () => {
	const inner = new ScrollView(new Text(history(30), 0, 0), { scrollbar: "auto" });
	const outer = new ScrollView(
		new VStack([new Text("heading", 0, 0), { component: inner, basis: 4 }, new Text(history(10), 0, 0)]),
	);
	const right = new ScrollView(new Text(history(40), 0, 0), { scrollbar: "always", follow: "end" });
	const root = new HStack([
		{ component: outer, basis: 25 },
		{ component: right, basis: 25 },
	]);
	let previous = renderLayoutFrame(root, 50, 8, () => {});
	for (const [a, b, c] of [
		[1, 2, -2],
		[2, 3, -3],
		[-2, -1, 1],
	]) {
		outer.scrollBy(a);
		inner.scrollBy(b);
		right.scrollBy(c);
		const next = repaintLayoutFrame(previous);
		assert.ok(next);
		const expected = renderLayoutFrame(root, 50, 8, () => {});
		assert.deepEqual(next.lines, expected.lines);
		for (const pane of [inner, outer, right]) {
			assert.deepEqual(getScrollViewBox(next, pane)?.rect, getScrollViewBox(expected, pane)?.rect);
			assert.deepEqual(getScrollViewBox(next, pane)?.clip, getScrollViewBox(expected, pane)?.clip);
		}
		previous = next;
	}
});

test("scrollbar geometry changes reject cached wrapping; hover can reuse it", () => {
	const scroll = new ScrollView(new Text(history(), 0, 0), { scrollbar: "auto" });
	const frame = renderLayoutFrame(scroll, 40, 12, () => {});
	scroll.scrollBy(2);
	scroll.setScrollbarActive(true);
	assert.deepEqual(repaintLayoutFrame(frame)?.lines, renderLayoutFrame(scroll, 40, 12, () => {}).lines);
	scroll.setScrollbar("always");
	assert.equal(repaintLayoutFrame(frame), undefined);
});

test("repainting clips cached Kitty images at both viewport boundaries", () => {
	const imageId = 9821;
	const image = encodeKitty("AAAA", { columns: 2, rows: 4, imageId, moveCursor: false });
	registerKittyImageMetadata({ imageId, columns: 2, rows: 4, widthPx: 100, heightPx: 100 });
	const scroll = new ScrollView({ render: () => ["heading", image, "", "", "", "tail"], invalidate() {} });
	let frame = renderLayoutFrame(scroll, 40, 3, () => {});
	for (const top of [1, 2, 3, 0]) {
		scroll.scrollTo(top);
		const next = repaintLayoutFrame(frame);
		assert.ok(next);
		assert.deepEqual(next.lines, renderLayoutFrame(scroll, 40, 3, () => {}).lines);
		frame = next;
	}
});

test("scheduled wheel and page scrolling never rerender unchanged history or the dock", async (t) => {
	const terminal = new VirtualTerminal(40, 12);
	const tui = new TuiAltScreen(terminal);
	const document = new Container();
	const messages = Array.from({ length: 150 }, () => new CountedText(history(20), 0, 0));
	for (const message of messages) document.addChild(message);
	const scroll = new ScrollView(document, { follow: "end", primary: true, scrollbar: "auto" });
	const dock = new CountedText("editor", 0, 0);
	tui.setLayoutRoot(new VStack([{ component: scroll, basis: 0, grow: 1 }, dock]));
	tui.start();
	t.after(() => tui.stop({ preserveScreen: true }));
	tui.renderNow();
	const calls = messages.map((message) => message.renders);
	let dockCalls = dock.renders;
	for (const input of ["\x1b[<64;5;5M", "\x1b[5~", "\x1b[6~", "\x1b[<72;5;5M"]) {
		terminal.sendInput(input);
		await terminal.waitForRender();
		assert.deepEqual(
			messages.map((message) => message.renders),
			calls,
		);
		assert.equal(dock.renders, dockCalls);
		const cached = terminal.getViewport();
		tui.renderNow();
		await terminal.flush();
		assert.deepEqual(terminal.getViewport(), cached);
		for (const [index, message] of messages.entries()) calls[index] = message.renders;
		dockCalls = dock.renders;
	}
});

test("content requests dominate queued scrolls in either order and preserve following output", async (t) => {
	const terminal = new VirtualTerminal(40, 8);
	const tui = new TuiAltScreen(terminal);
	const text = new CountedText(history(), 0, 0);
	tui.addChild(text);
	tui.start();
	t.after(() => tui.stop({ preserveScreen: true }));
	tui.renderNow();
	for (const scrollFirst of [true, false]) {
		if (scrollFirst) tui.scrollBy(-1);
		text.setText(`${history()}\nnew ${scrollFirst}`);
		tui.requestRender();
		if (!scrollFirst) tui.scrollBy(-1);
		const calls = text.renders;
		await terminal.waitForRender();
		assert.ok(text.renders > calls);
		assert.equal(tui.isFollowingOutput, false);
	}
	tui.scrollToBottom();
	await terminal.waitForRender();
	text.setText(`${history()}\nnew tail`);
	tui.requestRender();
	await terminal.waitForRender();
	assert.equal(tui.isFollowingOutput, true);
	assert.ok(terminal.getViewport().at(-1)?.includes("new tail"));
});

test("explicit render, invalidation, resizing and replacing the root invalidate retained layout", async (t) => {
	const terminal = new VirtualTerminal(40, 8);
	const tui = new TuiAltScreen(terminal);
	const text = new CountedText(history(), 0, 0);
	tui.addChild(text);
	tui.start();
	t.after(() => tui.stop({ preserveScreen: true }));
	tui.renderNow();
	tui.scrollBy(-1);
	text.setText("explicit update");
	tui.renderNow();
	await terminal.flush();
	assert.ok(terminal.getViewport()[0]?.includes("explicit update"));
	text.setText(history());
	tui.invalidate();
	tui.scrollBy(-1);
	let calls = text.renders;
	await terminal.waitForRender();
	assert.ok(text.renders > calls);
	tui.scrollBy(-1);
	terminal.resize(25, 10);
	calls = text.renders;
	await terminal.waitForRender();
	assert.ok(text.renders > calls);
	tui.scrollBy(-1);
	tui.setLayoutRoot(new Text("replacement root", 0, 0));
	await terminal.waitForRender();
	assert.ok(terminal.getViewport()[0]?.includes("replacement root"));
});

test("keyboard input preempts queued scroll without reusing stale editor text", async (t) => {
	const terminal = new VirtualTerminal(40, 12);
	const tui = new TuiAltScreen(terminal);
	const editor = new CountedText("editor", 0, 0);
	const input: Component = {
		render: (width) => editor.render(width),
		invalidate: () => editor.invalidate(),
		handleInput: (text) => editor.setText(`typed ${text}`),
	};
	tui.setLayoutRoot(
		new VStack([
			{ component: new ScrollView(new Text(history(), 0, 0), { primary: true, follow: "end" }), basis: 0, grow: 1 },
			input,
		]),
	);
	tui.setFocus(input);
	tui.start();
	t.after(() => tui.stop({ preserveScreen: true }));
	tui.renderNow();
	tui.scrollBy(-2);
	terminal.sendInput("x");
	await terminal.waitForRender();
	assert.ok(terminal.getViewport().at(-1)?.includes("typed x"));
});

test("search reuses immutable history but still observes mutable inputs and changed queries", () => {
	const index = new AltScreenSearchIndex();
	const mutable = ["first needle", "tail"];
	const snapshot = snapshotSelectionLines(mutable);
	const initial = index.search(snapshot, "needle");
	const again = index.search(snapshot, "needle");
	assert.equal(again.changed, false);
	assert.equal(again.matches, initial.matches);
	assert.equal(index.search(snapshot, "tail").changed, true);
	assert.equal(index.search(mutable, "needle").matches.length, 1);
	mutable[0] = "removed";
	assert.equal(index.search(mutable, "needle").matches.length, 0);
	assert.equal(index.search(snapshot, "needle").matches.length, 1);
});

test("retained scrolling keeps copy sources and requested replacements clear stale selection", async (t) => {
	const terminal = new VirtualTerminal(40, 8);
	let copied: string | undefined;
	const tui = new TuiAltScreen(terminal, false, undefined, {
		copyOnSelect: false,
		copySelection: async (text) => {
			copied = text;
			return true;
		},
	});
	const document = new Container();
	const text = new CountedText(history(), 0, 0);
	document.addChild(text);
	tui.addChild(document);
	tui.start();
	t.after(() => tui.stop({ preserveScreen: true }));
	tui.renderNow();
	terminal.sendInput("\x1b[<0;1;2M");
	terminal.sendInput("\x1b[<32;3;2M");
	terminal.sendInput("\x1b[<0;3;2m");
	await terminal.waitForRender();
	assert.equal(await tui.copyActiveSelectionToClipboard(), true);
	assert.equal(copied, "row");
	const calls = text.renders;
	tui.scrollBy(-15);
	await terminal.waitForRender();
	assert.equal(text.renders, calls);
	assert.equal(await tui.copyActiveSelectionToClipboard(), true);
	assert.equal(copied, "row");
	document.clear();
	document.addChild(new Text(history(), 0, 0));
	tui.requestRender();
	await terminal.waitForRender();
	assert.equal(tui.hasActiveSelection(), false);
});

test("component mouse handlers still trigger content rendering after cached scrolling", async (t) => {
	const terminal = new VirtualTerminal(40, 8);
	const tui = new TuiAltScreen(terminal);
	const text = new CountedText(history(), 0, 0);
	tui.addChild({
		render: (width) => text.render(width),
		invalidate: () => text.invalidate(),
		handleMouse: (event) => {
			if (event.type !== "click") return undefined;
			text.setText("clicked");
			return { handled: true };
		},
	});
	tui.start();
	t.after(() => tui.stop({ preserveScreen: true }));
	tui.renderNow();
	tui.scrollBy(-3);
	await terminal.waitForRender();
	terminal.sendInput("\x1b[<0;2;2M");
	terminal.sendInput("\x1b[<0;2;2m");
	await terminal.waitForRender();
	assert.equal(terminal.getViewport()[0].trimEnd(), "clicked");
});

test("retained scrolling does not trust later mutations of a child's output array", async (t) => {
	const terminal = new VirtualTerminal(40, 8);
	const tui = new TuiAltScreen(terminal);
	const lines = Array.from({ length: 40 }, (_, row) => `original ${row}`);
	tui.addChild({ render: () => lines, invalidate() {} });
	tui.start();
	t.after(() => tui.stop({ preserveScreen: true }));
	tui.renderNow();
	lines[31] = "mutated externally";
	tui.scrollBy(-1);
	await terminal.waitForRender();
	assert.equal(terminal.getViewport()[0], "original 31");
	tui.requestRender();
	await terminal.waitForRender();
	assert.equal(terminal.getViewport()[0], "mutated externally");
});
