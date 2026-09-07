import type { AgentSessionEvent } from "../../core/agent-session.ts";

type WorkingPhase =
	| "waiting"
	| "reasoning"
	| "response"
	| "tool-call"
	| "tool-ready"
	| "tools"
	| "tool-finished"
	| "response-finished";

/** Observed engine activity, not a claim about provider-side computation. */
export class WorkingActivity {
	private phase: WorkingPhase = "waiting";
	private readonly tools = new Set<string>();
	private changedAt: number;
	private readonly now: () => number;

	constructor(now: () => number = () => performance.now()) {
		this.now = now;
		this.changedAt = now();
	}

	update(event: AgentSessionEvent): void {
		let phase: WorkingPhase | undefined;
		let reset = false;
		switch (event.type) {
			case "agent_start":
				this.tools.clear();
				phase = "waiting";
				reset = true;
				break;
			case "turn_start":
				phase = "waiting";
				reset = true;
				break;
			case "message_update": {
				const type = event.assistantMessageEvent.type;
				if (type === "thinking_start" || type === "thinking_delta") phase = "reasoning";
				else if (type === "text_start" || type === "text_delta") phase = "response";
				else if (type === "toolcall_start" || type === "toolcall_delta") phase = "tool-call";
				else if (type === "toolcall_end") phase = "tool-ready";
				else if (type === "thinking_end" || type === "text_end") phase = "waiting";
				break;
			}
			case "message_end":
				if (event.message.role === "assistant") {
					phase = event.message.content.some((content) => content.type === "toolCall")
						? "tool-ready"
						: "response-finished";
				}
				break;
			case "tool_execution_start":
				this.tools.add(event.toolCallId);
				phase = "tools";
				break;
			case "tool_execution_end":
				this.tools.delete(event.toolCallId);
				phase = this.tools.size ? "tools" : "tool-finished";
				break;
			case "agent_end":
				this.tools.clear();
				break;
		}
		if (this.tools.size) phase = "tools";
		if (phase && (phase !== this.phase || reset)) {
			this.phase = phase;
			this.changedAt = this.now();
		}
	}

	message(): string {
		const labels: Record<WorkingPhase, string> = {
			waiting: "Waiting for model",
			reasoning: "Model reasoning",
			response: "Model response",
			"tool-call": "Receiving tool call",
			"tool-ready": "Tool call ready",
			"response-finished": "Response finished",
			tools: this.tools.size > 1 ? `Running ${this.tools.size} tools` : "Running tool",
			"tool-finished": "Tool finished",
		};
		const seconds = Math.max(0, Math.floor((this.now() - this.changedAt) / 1000));
		return `${labels[this.phase]} (${seconds}s)`;
	}
}
