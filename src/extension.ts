import * as vscode from "vscode";
import Log from "./common/logger";
import { RemoteSSHResolver, REMOTE_SSH_AUTHORITY } from "./authResolver";
import { openSSHConfigFile, promptuplinkWindow } from "./commands";
import { HostTreeDataProvider } from "./hostTreeView";
import {
  getRemoteWorkspaceLocationData,
  RemoteLocationHistory,
} from "./remoteLocationHistory";

export async function activate(context: vscode.ExtensionContext) {
  try {
    const logger = new Log("Uplink");
    context.subscriptions.push(logger);
    logger.info("Uplink extension activating...");

    // Register commands first
    context.subscriptions.push(
      vscode.commands.registerCommand("uplink.openEmptyWindow", () =>
        promptuplinkWindow(false)
      )
    );
    context.subscriptions.push(
      vscode.commands.registerCommand(
        "uplink.openEmptyWindowInCurrentWindow",
        () => promptuplinkWindow(true)
      )
    );
    context.subscriptions.push(
      vscode.commands.registerCommand("uplink.openConfigFile", () =>
        openSSHConfigFile()
      )
    );
    context.subscriptions.push(
      vscode.commands.registerCommand("uplink.showLog", () => logger.show())
    );
    logger.info("Commands registered");

    const remoteSSHResolver = new RemoteSSHResolver(context, logger);
    context.subscriptions.push(
      vscode.workspace.registerRemoteAuthorityResolver(
        REMOTE_SSH_AUTHORITY,
        remoteSSHResolver
      )
    );
    context.subscriptions.push(remoteSSHResolver);
    logger.info("Remote resolver registered");

    const locationHistory = new RemoteLocationHistory(context);
    const locationData = getRemoteWorkspaceLocationData();
    if (locationData) {
      await locationHistory.addLocation(locationData[0], locationData[1]);
    }

    const hostTreeDataProvider = new HostTreeDataProvider(locationHistory);
    context.subscriptions.push(
      vscode.window.createTreeView("sshHosts", {
        treeDataProvider: hostTreeDataProvider,
      })
    );
    context.subscriptions.push(hostTreeDataProvider);

    logger.info("Uplink extension activated successfully");
  } catch (error) {
    vscode.window.showErrorMessage(`Uplink activation failed: ${error}`);
    console.error("Uplink activation error:", error);
    throw error;
  }
}

export function deactivate() {}
