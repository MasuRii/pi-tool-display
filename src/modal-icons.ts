export interface ModalIconSet {
	search: string;
	tool: string;
}

const NERD_MODAL_ICONS: ModalIconSet = {
	search: "\uF002",
	tool: "\uF0AD",
};

const EMOJI_MODAL_ICONS: ModalIconSet = {
	search: "🔍",
	tool: "🔧",
};

const NERD_FONT_TERMINAL_HINTS = [
	"iterm",
	"wezterm",
	"kitty",
	"ghostty",
	"alacritty",
	"xfce4-terminal",
	"gnome-terminal",
	"tilix",
	"terminator",
	"konsole",
] as const;

function parseBooleanEnv(value: string | undefined): boolean | undefined {
	if (value === "1" || value?.toLowerCase() === "true") {
		return true;
	}

	if (value === "0" || value?.toLowerCase() === "false") {
		return false;
	}

	return undefined;
}

function detectNerdFonts(): boolean {
	const explicitPreference =
		parseBooleanEnv(process.env.PI_NERD_FONTS) ?? parseBooleanEnv(process.env.POWERLINE_NERD_FONTS);
	if (explicitPreference !== undefined) {
		return explicitPreference;
	}

	if (process.env.GHOSTTY_RESOURCES_DIR) {
		return true;
	}

	const termProgram = (process.env.TERM_PROGRAM || "").toLowerCase();
	const term = (process.env.TERM || "").toLowerCase();
	const fingerprint = `${termProgram} ${term}`;
	return NERD_FONT_TERMINAL_HINTS.some((terminal) => fingerprint.includes(terminal));
}

export function getModalIcons(): ModalIconSet {
	return detectNerdFonts() ? NERD_MODAL_ICONS : EMOJI_MODAL_ICONS;
}
