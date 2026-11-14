/*---------------------------------------------------------------------------------------------
 *  Arkestra. The bundled Inter (media/fonts, SIL OFL 1.1, see OFL.txt there) for the webviews:
 *  the folder they may load it from, and its address in one webview.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as path from 'node:path';
import type { PageFonts } from './fonts';

/** media/fonts of this extension: out/ (tsc) and dist/ (esbuild) are both one level under its root. */
export const FONT_ROOT = vscode.Uri.file(path.join(__dirname, '..', 'media', 'fonts'));

/** The font folder's address and the CSP source of a webview. */
export function pageFonts(webview: vscode.Webview): PageFonts {
	return { base: webview.asWebviewUri(FONT_ROOT).toString(), cspSource: webview.cspSource };
}
