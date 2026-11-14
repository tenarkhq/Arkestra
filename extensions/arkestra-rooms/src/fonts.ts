/*---------------------------------------------------------------------------------------------
 *  Arkestra. The type of the approved render for the webviews: the bundled Inter (media/fonts,
 *  SIL OFL 1.1) and the system's sans after it. No VS Code here, so it is testable.
 *--------------------------------------------------------------------------------------------*/

/** The bundled Inter (media/fonts, OFL): the folder's webview address and the page's CSP source. */
export interface PageFonts {
	readonly base: string;
	readonly cspSource: string;
}

/** The render's type: Inter, then the system's own sans. */
export const FONT_STACK = '"Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif';

const LATIN = 'U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+2074,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD';
const LATIN_EXT = 'U+0100-02AF,U+0304,U+0308,U+0329,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF';

/** The @font-face rules of the bundled Inter (variable weight; Latin and Latin Extended, so ő and ű too). */
export function fontFaces(fonts: PageFonts | undefined): string {
	if (!fonts) {
		return '';
	}
	const base = fonts.base.replace(/\/+$/, '').replace(/["\\\n]/g, encodeURIComponent);
	const face = (file: string, range: string) => `@font-face { font-family: "Inter"; font-style: normal; font-weight: 100 900; font-display: swap; src: url("${base}/${file}") format("woff2"); unicode-range: ${range}; }`;
	return `${face('inter-latin-ext-wght-normal.woff2', LATIN_EXT)}\n${face('inter-latin-wght-normal.woff2', LATIN)}\n`;
}

/** The CSP part that lets the page load the bundled font. */
export function fontSrc(fonts: PageFonts | undefined): string {
	return fonts ? ` font-src ${fonts.cspSource};` : '';
}

/** Crisp text in the render's font. */
export const TYPE_CSS = `font-family: ${FONT_STACK}; -webkit-font-smoothing: antialiased; -moz-osx-font-smoothing: grayscale; text-rendering: optimizeLegibility;`;
