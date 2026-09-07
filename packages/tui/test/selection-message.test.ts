import assert from "node:assert/strict";
import { test } from "node:test";
import { ScrollView } from "../src/components/scroll-view.ts";
import { Text } from "../src/components/text.ts";
import { preserveSelection } from "../src/preserve-selection.ts";
import { getSelectionMap, selectionText, snapshotSelectionLines } from "../src/selection-map.ts";
import { setSelectionMessage } from "../src/selection-message.ts";
import { type Component, Container } from "../src/tui.ts";
import { TuiAltScreen } from "../src/tui-alt-screen.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

function message(text: string, label: string): Text {
	const component = new Text(text, 0, 0);
	const render = component.render.bind(component);
	const identity = { label };
	component.render = (width) => {
		const input = render(width);
		const lines = [...input];
		preserveSelection(lines, input, { row: 0, column: 0, width });
		setSelectionMessage(lines, identity);
		return lines;
	};
	return component;
}

function copy(children: Component[], width = 80, start = 0, end = width): string | undefined {
	const root = new Container();
	for (const child of children) root.addChild(child);
	const lines = root.render(width);
	return selectionText(
		lines,
		getSelectionMap(lines),
		0,
		lines.length - 1,
		(_line, row) => ({
			start: row === 0 ? start : 0,
			end: row === lines.length - 1 ? end : width,
		}),
		width,
	);
}

test("single-message wrapping stays plain; multiple messages gain attribution", () => {
	assert.equal(copy([message("alpha beta gamma", "USER 14:32")], 8), "alpha beta gamma");
	assert.equal(
		copy([message("alpha", "USER 14:32"), message("beta", "AGENT 14:33")]),
		"USER 14:32\n\nalpha\n\nAGENT 14:33\n\nbeta",
	);
});

test("partial endpoints include only the selected text", () => {
	assert.equal(
		copy([message("ignore alpha", "USER"), message("beta ignore", "AGENT")], 80, 7, 4),
		"USER\n\nalpha\n\nAGENT\n\nbeta",
	);
});

test("equal labels do not collapse distinct messages", () => {
	assert.equal(
		copy([message("first", "AGENT 14:33"), message("second", "AGENT 14:33")]),
		"AGENT 14:33\n\nfirst\n\nAGENT 14:33\n\nsecond",
	);
});

test("unmapped visible rows preserve legacy blank lines", () => {
	const identity = { label: "USER" };
	const legacy = {
		invalidate() {},
		render: () => {
			const lines = ["alpha", "", "beta"];
			setSelectionMessage(lines, identity);
			return lines;
		},
	};
	assert.equal(copy([legacy, message("gamma", "AGENT")]), "USER\n\nalpha\n\nbeta\n\nAGENT\n\ngamma");
});

test("changing attribution invalidates equal-looking legacy selections", async () => {
	let identity = { label: "USER" };
	const component = {
		invalidate() {},
		render: () => {
			const lines = ["legacy"];
			setSelectionMessage(lines, identity);
			return lines;
		},
	};
	const terminal = new VirtualTerminal(24, 8);
	const tui = new TuiAltScreen(terminal, false, undefined, { copyOnSelect: false });
	tui.setLayoutRoot(new ScrollView(component));
	try {
		tui.start();
		tui.renderNow();
		await terminal.flush();
		terminal.sendInput("\x1b[<0;1;1M");
		terminal.sendInput("\x1b[<32;6;1M");
		terminal.sendInput("\x1b[<0;6;1m");
		tui.renderNow();
		assert.equal(tui.hasActiveSelection(), true);
		tui.renderNow();
		assert.equal(tui.hasActiveSelection(), true);
		identity = { label: "AGENT" };
		tui.renderNow();
		assert.equal(tui.hasActiveSelection(), false);
	} finally {
		tui.stop();
	}
});

test("attribution keeps source identity stable across renders and snapshots immutable", () => {
	const component = message("alpha", "USER");
	const first = component.render(80);
	const snapshot = snapshotSelectionLines(first);
	const a = getSelectionMap(first)![0]![0]!.source;
	const second = component.render(80);
	assert.equal(getSelectionMap(second)![0]![0]!.source, a);
	first[0] = "rewritten";
	assert.equal(getSelectionMap(first), undefined);
	assert.equal(getSelectionMap(snapshot)![0]![0]!.source.text, "alpha");
});
