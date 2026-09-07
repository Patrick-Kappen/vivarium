import { ScrollView } from "../src/components/scroll-view.ts";
import type { Component } from "../src/tui.ts";
import { TuiAltScreen } from "../src/tui-alt-screen.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

class SelectionTerminal extends VirtualTerminal {
	writes: string[] = [];
	override write(data: string): void {
		this.writes.push(data);
		super.write(data);
	}
}

interface Fixture {
	tui: TuiAltScreen;
	terminal: SelectionTerminal;
	scroll: ScrollView;
	copied: string[];
}

export async function withSelection(
	component: Component,
	width: number,
	mode: "implicit" | "scroll" | "viewport",
	run: (fixture: Fixture) => Promise<void>,
	height = 64,
): Promise<void> {
	const terminal = new SelectionTerminal(width, height);
	const copied: string[] = [];
	const tui = new TuiAltScreen(terminal, undefined, undefined, {
		copyOnSelect: false,
		copySelection: async (text) => {
			copied.push(text);
			return true;
		},
	});
	const scroll = new ScrollView(component, { primary: true });
	if (mode === "implicit") tui.addChild(component);
	else tui.setLayoutRoot(mode === "scroll" ? scroll : component);
	try {
		tui.start();
		tui.renderNow();
		await terminal.flush();
		await run({ tui, terminal, scroll, copied });
	} finally {
		tui.stop();
	}
}

export function select(fixture: Fixture, startX: number, startY: number, endX: number, endY: number): void {
	fixture.terminal.sendInput(`\x1b[<0;${startX + 1};${startY + 1}M`);
	fixture.terminal.sendInput(`\x1b[<32;${endX + 1};${endY + 1}M`);
	fixture.terminal.sendInput(`\x1b[<0;${endX + 1};${endY + 1}m`);
	fixture.tui.renderNow();
}
