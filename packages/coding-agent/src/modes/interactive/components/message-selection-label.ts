export function messageSelectionLabel(role: "user" | "assistant", timestamp?: number): string {
	const label = role === "user" ? "USER" : "AGENT";
	const date = new Date(timestamp ?? Number.NaN);
	if (!Number.isFinite(date.getTime())) return label;
	const time = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
	return `${label} ${time}`;
}
