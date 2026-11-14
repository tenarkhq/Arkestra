/*---------------------------------------------------------------------------------------------
 *  Arkestra. The workbench defaults of the "Hidden" and "Removed" rows of the Arkestra
 *  plan (AR03). These are defaults only: every one can be turned back on in the settings,
 *  and a view hidden here can be shown again from its container's menu.
 *--------------------------------------------------------------------------------------------*/

import { Registry } from '../../../../platform/registry/common/platform.js';
import { Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { Extensions as ViewExtensions, IViewContainersRegistry, IViewDescriptor, IViewsRegistry } from '../../../common/views.js';

export const ARKESTRA_DEFAULTS: { readonly [key: string]: unknown } = {
	// Hidden
	'window.menuBarVisibility': 'toggle',                // Windows/Linux: Alt shows it; macOS keeps the system menu
	'workbench.activityBar.location': 'top',             // the left column's equal tabs: Threads, Files, Git, ... (AR07)
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
