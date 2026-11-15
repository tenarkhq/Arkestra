/*---------------------------------------------------------------------------------------------
 *  Arkestra. The workbench defaults of the "Hidden" and "Removed" rows of the Arkestra
 *  plan (AR03), and the simple layout: one bar on the left, the selected thread, room or
 *  board in the middle, the tool views on the right, the terminals at the bottom.
 *  These are defaults only: every one can be turned back on in the settings, and a view
 *  hidden here can be shown again from its container's menu.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { IPaneCompositePartService } from '../../../services/panecomposite/browser/panecomposite.js';
import { IWorkbenchLayoutService, Parts } from '../../../services/layout/browser/layoutService.js';
import { Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { Extensions as ViewExtensions, IViewContainersRegistry, IViewDescriptor, IViewDescriptorService, IViewsRegistry, ViewContainerLocation } from '../../../common/views.js';

export const ARKESTRA_DEFAULTS: { readonly [key: string]: unknown } = {
	// Hidden
	'window.menuBarVisibility': 'toggle',                // Windows/Linux: Alt shows it; macOS keeps the system menu
	'workbench.activityBar.location': 'hidden',          // the left bar is Arkestra's own; the tool views open on the right
	'workbench.statusBar.visible': false,
	'workbench.editor.showTabs': 'none',                 // the left bar switches what the middle shows
	'workbench.secondarySideBar.defaultVisibility': 'hidden', // the right side opens when a tool view is asked for
	'window.commandCenter': false,
	'chat.commandCenter.enabled': false,                 // no Copilot chat button in the title bar; threads live in the left bar
	'workbench.layoutControl.enabled': false,            // reachable from the command palette
	'debug.showInStatusBar': 'never',                    // Run and Debug
	'debug.toolBarLocation': 'hidden',
	'testing.gutterEnabled': false,                      // agents run the tests in the terminal
	'testing.automaticallyOpenTestResults': 'neverOpen',
	'editor.minimap.enabled': false,
	'breadcrumbs.enabled': false,
	'extensions.ignoreRecommendations': true,            // no recommendation pop-ups
	'chat.titleBar.signIn.enabled': false,               // Copilot appears only for whoever turns it on
	'chat.disableAIFeatures': true,                      // threads are Arkestra's own panel; VS Code's chat and Copilot never answer in them

	// Removed
	'workbench.tips.enabled': false,
	'comments.visible': false,                           // reviews happen in the room
	'comments.openView': 'never',
	'workbench.startupEditor': 'none',                   // first start: Accounts and Connections instead
	'workbench.welcomePage.walkthroughs.openOnInstall': false,
	'update.showReleaseNotes': false,
	'workbench.activity.showAccounts': false,            // accounts live under Settings › Accounts

	// Themes (AR06): dark by default; the light one when the system asks for light
	'workbench.colorTheme': 'Arkestra Dark',
	'workbench.preferredDarkColorTheme': 'Arkestra Dark',
	'workbench.preferredLightColorTheme': 'Arkestra Light',

	// No Microsoft service on the way (AR04)
	'github-authentication.preferDeviceCodeFlow': true,  // GitHub sign-in without the vscode.dev redirect
};

/** Views of the "Hidden" and "Removed" rows; hidden until someone shows them. */
export const ARKESTRA_HIDDEN_VIEWS: readonly string[] = [
	'timeline',                          // git history is on the Git tab
	'workbench.panel.output',
	'workbench.panel.repl.view',         // Debug Console, comes back with debugging
	'workbench.panel.comments',
	'workbench.panel.testResults.view',
];

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerDefaultConfigurations([{ overrides: { ...ARKESTRA_DEFAULTS } }]);

const hide = (views: readonly IViewDescriptor[]) => {
	for (const view of views) {
		if (ARKESTRA_HIDDEN_VIEWS.includes(view.id)) {
			(view as { hideByDefault?: boolean }).hideByDefault = true;
		}
	}
};
const viewsRegistry = Registry.as<IViewsRegistry>(ViewExtensions.ViewsRegistry);
for (const container of Registry.as<IViewContainersRegistry>(ViewExtensions.ViewContainersRegistry).all) {
	hide(viewsRegistry.getViews(container));
}
viewsRegistry.onViewsRegistered(added => added.forEach(({ views }) => hide(views)));

// ---- The simple layout, set once per profile ----------------------------------------------------

/** Raised when the layout below changes, so existing installs get it once more. */
const LAYOUT_VERSION = 3;
/** The left bar: Arkestra's own view container (Pinned, Projects, Boards, Chats, Agents, Machines). */
const LEFT_CONTAINER = 'workbench.view.extension.arkestra';
const LAYOUT_KEY = 'arkestra.layout.version';
/** Per window: its bars were set up once (a new or not-restored window gets them; a bar closed by hand stays closed). */
const WINDOW_KEY = 'arkestra.layout.window';
/** The right side: the active thread's details (arkestra-rooms). */
const DETAILS_CONTAINER = 'workbench.view.extension.arkestra-details';
/** The views the two bars show: the left bar page and the thread's details (arkestra-rooms). */
const LEFT_VIEW = 'arkestra.sidebar';
const DETAILS_VIEW = 'arkestra.details';
/** Bottom panel: only the terminals. */
export const ARKESTRA_HIDDEN_PANEL_TABS: readonly string[] = [
	'workbench.panel.markers', 'workbench.panel.output', 'workbench.panel.repl',
	'~remote.forwardedPortsContainer', 'workbench.panel.comments', 'workbench.panel.testResults',
];
/** Right side: no Copilot chat tab. */
export const ARKESTRA_HIDDEN_RIGHT_TABS: readonly string[] = ['workbench.panel.chat'];
/** The tool views on the right side. */
export const ARKESTRA_RIGHT_CONTAINERS: readonly string[] = ['workbench.view.explorer', 'workbench.view.search', 'workbench.view.scm'];
export const ARKESTRA_RIGHT_VIEWS: readonly string[] = ['arkestra.activity', 'arkestra.changes', 'arkestra.checkpoints'];

type CachedTab = { id: string; pinned: boolean; visible: boolean; order?: number };

/** Hides tabs of a part's tab bar the way its "Hide" menu does (the part follows the stored list). */
function unpinTabs(storage: IStorageService, key: string, ids: readonly string[]): void {
	let list: CachedTab[] = [];
	try {
		const parsed = JSON.parse(storage.get(key, StorageScope.PROFILE, '[]'));
		list = Array.isArray(parsed) ? parsed : [];
	} catch { /* a broken list is rebuilt */ }
	for (const id of ids) {
		const tab = list.find(t => t.id === id);
		if (tab) {
			tab.pinned = false;
		} else {
			list.push({ id, pinned: false, visible: true });
		}
	}
	storage.store(key, JSON.stringify(list), StorageScope.PROFILE, StorageTarget.USER);
}

class ArkestraLayout extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.arkestraLayout';

	constructor(
		@IStorageService private readonly storage: IStorageService,
		@IViewDescriptorService private readonly views: IViewDescriptorService,
		@IPaneCompositePartService private readonly panes: IPaneCompositePartService,
		@IWorkbenchLayoutService private readonly layout: IWorkbenchLayoutService,
	) {
		super();
		// Every window that has not been set up shows the left bar and the details (a new window,
		// one that was not restored): without it the left side stays an empty "Drag a view here".
		if (!storage.getBoolean(WINDOW_KEY, StorageScope.WORKSPACE, false)) {
			const registry = Registry.as<IViewsRegistry>(ViewExtensions.ViewsRegistry);
			if (!this.showBars(registry)) {
				const listener = this._register(registry.onViewsRegistered(() => {
					if (this.showBars(registry)) {
						listener.dispose();
					}
				}));
			}
		}
		// Every start: VS Code restores the bars before the extensions register Arkestra's containers and
		// then leaves a bar empty ("Drag a view here"). Once both exist, an empty bar gets its container.
		void this.layout.whenRestored.then(() => {
			const registry = Registry.as<IViewsRegistry>(ViewExtensions.ViewsRegistry);
			if (!this.fillEmptyBars(registry)) {
				const listener = this._register(registry.onViewsRegistered(() => {
					if (this.fillEmptyBars(registry)) {
						listener.dispose();
					}
				}));
			}
		});
		if (storage.getNumber(LAYOUT_KEY, StorageScope.PROFILE, 0) >= LAYOUT_VERSION) {
			return;
		}
		unpinTabs(storage, 'workbench.panel.pinnedPanels', ARKESTRA_HIDDEN_PANEL_TABS);
		unpinTabs(storage, 'workbench.auxiliarybar.pinnedPanels', ARKESTRA_HIDDEN_RIGHT_TABS);
		storage.store('tabs-list-width-horizontal', 150, StorageScope.PROFILE, StorageTarget.USER); // the terminal list: names, not half the panel
		for (const id of ARKESTRA_RIGHT_CONTAINERS) {
			const container = views.getViewContainerById(id);
			if (container && views.getViewContainerLocation(container) !== ViewContainerLocation.AuxiliaryBar) {
				views.moveViewContainerToLocation(container, ViewContainerLocation.AuxiliaryBar, undefined, 'arkestra');
			}
		}
		// Arkestra's own tool views come with the extensions, after start.
		const registry = Registry.as<IViewsRegistry>(ViewExtensions.ViewsRegistry);
		if (!this.moveToolViews(registry)) {
			const listener = this._register(registry.onViewsRegistered(() => {
				if (this.moveToolViews(registry)) {
					listener.dispose();
				}
			}));
		}
	}

	/** Shows the left bar and the details panel in this window once; false while their views are not registered yet. */
	private showBars(registry: IViewsRegistry): boolean {
		if (!registry.getView(LEFT_VIEW) || !registry.getView(DETAILS_VIEW)) {
			return false;
		}
		this.layout.setPartHidden(false, Parts.SIDEBAR_PART);
		void this.panes.openPaneComposite(LEFT_CONTAINER, ViewContainerLocation.Sidebar);
		this.layout.setPartHidden(false, Parts.AUXILIARYBAR_PART);
		void this.panes.openPaneComposite(DETAILS_CONTAINER, ViewContainerLocation.AuxiliaryBar);
		this.storage.store(WINDOW_KEY, true, StorageScope.WORKSPACE, StorageTarget.MACHINE);
		return true;
	}

	/** Opens Arkestra's container in a shown bar that has none open; false while their views are not registered yet. */
	private fillEmptyBars(registry: IViewsRegistry): boolean {
		if (!registry.getView(LEFT_VIEW) || !registry.getView(DETAILS_VIEW)) {
			return false;
		}
		if (this.layout.isVisible(Parts.SIDEBAR_PART) && !this.panes.getActivePaneComposite(ViewContainerLocation.Sidebar)) {
			void this.panes.openPaneComposite(LEFT_CONTAINER, ViewContainerLocation.Sidebar);
		}
		if (this.layout.isVisible(Parts.AUXILIARYBAR_PART) && !this.panes.getActivePaneComposite(ViewContainerLocation.AuxiliaryBar)) {
			void this.panes.openPaneComposite(DETAILS_CONTAINER, ViewContainerLocation.AuxiliaryBar);
		}
		return true;
	}

	/** Puts Arkestra's tool views together on the right; false while they are not registered yet. */
	private moveToolViews(registry: IViewsRegistry): boolean {
		const found = ARKESTRA_RIGHT_VIEWS.map(id => registry.getView(id)).filter((v): v is IViewDescriptor => !!v);
		if (found.length < ARKESTRA_RIGHT_VIEWS.length) {
			return false;
		}
		const [first, ...rest] = found;
		if (this.views.getViewLocationById(first.id) !== ViewContainerLocation.AuxiliaryBar) {
			this.views.moveViewToLocation(first, ViewContainerLocation.AuxiliaryBar, 'arkestra');
		}
		const target = this.views.getViewContainerByViewId(first.id);
		const away = rest.filter(v => this.views.getViewContainerByViewId(v.id) !== target);
		if (target && away.length) {
			this.views.moveViewsToContainer(away, target, undefined, 'arkestra');
		}
		// The left bar shows Arkestra's sections; a side bar left on Files (now on the right) would stay empty.
		this.layout.setPartHidden(false, Parts.SIDEBAR_PART);
		void this.panes.openPaneComposite(LEFT_CONTAINER, ViewContainerLocation.Sidebar);
		// The right side shows the thread's details (agents, background tasks, changes, machine).
		this.layout.setPartHidden(false, Parts.AUXILIARYBAR_PART);
		void this.panes.openPaneComposite(DETAILS_CONTAINER, ViewContainerLocation.AuxiliaryBar);
		// Both bars as wide as the approved layout (268 and 330 px), unless someone made them wider.
		try {
			const size = this.layout.getSize(Parts.SIDEBAR_PART);
			if (size.width < 260) {
				this.layout.setSize(Parts.SIDEBAR_PART, { width: 268, height: size.height });
			}
			const right = this.layout.getSize(Parts.AUXILIARYBAR_PART);
			if (right.width < 320) {
				this.layout.setSize(Parts.AUXILIARYBAR_PART, { width: 330, height: right.height });
			}
		} catch { /* the size is only a default */ }
		this.storage.store(LAYOUT_KEY, LAYOUT_VERSION, StorageScope.PROFILE, StorageTarget.USER);
		return true;
	}
}

registerWorkbenchContribution2(ArkestraLayout.ID, ArkestraLayout, WorkbenchPhase.BlockRestore);
