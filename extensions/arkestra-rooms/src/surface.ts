/*---------------------------------------------------------------------------------------------
 *  Arkestra. The right details panel follows the surface in the middle: a thread shows its
 *  details; a board, the artifacts, the new chat or another page has its own details in the
 *  page, so the right bar closes, and opens again when a thread comes back, unless the user
 *  closed it himself on a thread (that choice is kept). An editor or a terminal changes
 *  nothing: it is part of the thread's work. No VS Code here, so it is testable.
 *--------------------------------------------------------------------------------------------*/

/** What the active tab of the middle shows. */
export type Surface = 'thread' | 'page' | 'editor';

/**
 * The surface of a tab: Arkestra's thread panel with a thread is a thread (the new chat in it
 * is a page); any other webview is a page; text, diffs, terminals and the rest are editors.
 */
export function surfaceOf(tab: { readonly webview?: string } | undefined, threadViewType: string, threadRoom: string | undefined): Surface {
	if (tab?.webview === undefined) {
		return 'editor';
	}
	return tab.webview.endsWith(threadViewType) && threadRoom ? 'thread' : 'page';
}

/** What the right bar has to do now. */
export type BarAction = 'close' | 'open' | undefined;

/** The first seconds after start: the window lays itself out (it closes and reopens bars); a close then is not the user's. */
export const SETTLE_MS = 10_000;

export class DetailsFollow {
	private readonly started: number;
	private surface: Surface = 'editor';
	private visible = false;
	/** The user closed the bar while a thread showed: it stays closed until he opens it. */
	private userClosed = false;
	/** A hide that comes from the close asked for here, not from the user. */
	private expectHide = false;

	constructor(private readonly now: () => number = () => Date.now()) {
		this.started = now();
	}

	/** The details view became visible or hidden (the right bar opened or closed). */
	visibility(visible: boolean): void {
		if (visible === this.visible) {
			return;
		}
		this.visible = visible;
		if (visible) {
			this.userClosed = false;
			this.expectHide = false;
		} else if (this.expectHide) {
			this.expectHide = false;
		} else if (this.surface === 'thread' && this.now() - this.started >= SETTLE_MS) {
			this.userClosed = true;
		}
	}

	/** The middle shows another surface: what the right bar has to do. */
	changed(surface: Surface): BarAction {
		const before = this.surface;
		this.surface = surface;
		if (surface === before) {
			return undefined;
		}
		if (surface === 'page' && this.visible) {
			this.expectHide = true;
			return 'close';
		}
		// A thread shows its details unless the user closed them on a thread; also after a restart on a page,
		// when nothing here remembers that the bar was closed for that page.
		if (surface === 'thread') {
			return !this.visible && !this.userClosed ? 'open' : undefined;
		}
		return undefined;
	}

	/** Once the window has laid itself out: a thread in the middle shows its details (the layout may have closed the bar). */
	settled(): BarAction {
		return this.surface === 'thread' && !this.visible && !this.userClosed ? 'open' : undefined;
	}

	/** Whether the details may show a thread now (not while a page is in the middle). */
	showsThread(): boolean {
		return this.surface !== 'page';
	}
}
