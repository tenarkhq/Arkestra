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
const LAYOUT_VERSION = 2;
/** The left bar: Arkestra's own view container (Pinned, Projects, Boards, Chats, Agents, Machines). */
const LEFT_CONTAINER = 'workbench.view.extension.arkestra';
const LAYOUT_KEY = 'arkestra.layout.version';
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
		this.storage.store(LAYOUT_KEY, LAYOUT_VERSION, StorageScope.PROFILE, StorageTarget.USER);
		return true;
	}
}

registerWorkbenchContribution2(ArkestraLayout.ID, ArkestraLayout, WorkbenchPhase.BlockRestore);
