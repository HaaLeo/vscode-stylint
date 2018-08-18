/* --------------------------------------------------------------------------------------------
 * Copyright (c) Leo Hanisch. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */

'use strict';

import * as path from 'path';
import {
    workspace as Workspace, window as Window, commands as Commands, languages as Languages, Disposable, ExtensionContext, Uri, StatusBarAlignment, TextDocument,
    CodeActionContext, Diagnostic, ProviderResult, Command, QuickPickItem, WorkspaceFolder as VWorkspaceFolder, CodeAction
} from 'vscode';
import {
    LanguageClient, LanguageClientOptions, RequestType, TransportKind,
    TextDocumentIdentifier, NotificationType, ErrorHandler,
    ErrorAction, CloseAction, State as ClientState,
    RevealOutputChannelOn,
    ServerOptions, DocumentFilter, DidCloseTextDocumentNotification, DidOpenTextDocumentNotification,
    WorkspaceFolder
} from 'vscode-languageclient';

namespace Is {
    const toString = Object.prototype.toString;

    export function boolean(value: any): value is boolean {
        return value === true || value === false;
    }

    export function string(value: any): value is string {
        return toString.call(value) === '[object String]';
    }
}

interface ValidateItem {
    language: string;
    autoFix?: boolean;
}

namespace ValidateItem {
    export function is(item: any): item is ValidateItem {
        let candidate = item as ValidateItem;
        return candidate && Is.string(candidate.language) && (Is.boolean(candidate.autoFix) || candidate.autoFix === void 0);
    }
}

interface DirectoryItem {
    directory: string;
    changeProcessCWD?: boolean;
}

namespace DirectoryItem {
    export function is(item: any): item is DirectoryItem {
        let candidate = item as DirectoryItem;
        return candidate && Is.string(candidate.directory) && (Is.boolean(candidate.changeProcessCWD) || candidate.changeProcessCWD === void 0);
    }
}

type RunValues = 'onType' | 'onSave';

interface TextDocumentSettings {
    validate: boolean;
    autoFix: boolean;
    autoFixOnSave: boolean;
    stylintrcPath: string | undefined;
    run: RunValues;
    nodePath: string | undefined;
    stylintWrapperPath: string;
    stylintJsonReporterPath: string;
    workspaceFolder: WorkspaceFolder | undefined;
    workingDirectory: DirectoryItem | undefined;
    library: undefined;
}

interface NoStylintState {
    global?: boolean;
    workspaces?: { [key: string]: boolean };
}

enum Status {
    ok = 1,
    warn = 2,
    error = 3
}

interface StatusParams {
    state: Status
}

namespace StatusNotification {
    export const type = new NotificationType<StatusParams, void>('stylint/status');
}

interface NoConfigParams {
    message: string;
    document: TextDocumentIdentifier;
}

interface NoConfigResult {
}

namespace NoConfigRequest {
    export const type = new RequestType<NoConfigParams, NoConfigResult, void, void>('stylint/noConfig');
}


interface NoStylintLibraryParams {
    source: TextDocumentIdentifier;
}

interface NoStylintLibraryResult {
}

namespace NoStylintLibraryRequest {
    export const type = new RequestType<NoStylintLibraryParams, NoStylintLibraryResult, void, void>('stylint/noLibrary');
}

const exitCalled = new NotificationType<[number, string], void>('stylint/exitCalled');


interface WorkspaceFolderItem extends QuickPickItem {
    folder: VWorkspaceFolder;
}

function pickFolder(folders: VWorkspaceFolder[], placeHolder: string): Thenable<VWorkspaceFolder> {
    if (folders.length === 1) {
        return Promise.resolve(folders[0]);
    }
    return Window.showQuickPick(
        folders.map<WorkspaceFolderItem>((folder) => { return { label: folder.name, description: folder.uri.fsPath, folder: folder }; }),
        { placeHolder: placeHolder }
    ).then((selected) => {
        if (!selected) {
            return undefined;
        }
        return selected.folder;
    });
}

function enable() {
    let folders = Workspace.workspaceFolders;
    if (!folders) {
        Window.showWarningMessage('Stylint can only be enabled if VS Code is opened on a workspace folder.');
        return;
    }
    let disabledFolders = folders.filter(folder => !Workspace.getConfiguration('stylint', folder.uri).get('enable', true));
    if (disabledFolders.length === 0) {
        if (folders.length === 1) {
            Window.showInformationMessage('Stylint is already enabled in the workspace.');
        } else {
            Window.showInformationMessage('Stylint is already enabled on all workspace folders.');
        }
        return;
    }
    pickFolder(disabledFolders, 'Select a workspace folder to enable Stylint for').then(folder => {
        if (!folder) {
            return;
        }
        Workspace.getConfiguration('stylint', folder.uri).update('enable', true);
    });
}

function disable() {
    let folders = Workspace.workspaceFolders;
    if (!folders) {
        Window.showErrorMessage('Stylint can only be disabled if VS Code is opened on a workspace folder.');
        return;
    }
    let enabledFolders = folders.filter(folder => Workspace.getConfiguration('stylint', folder.uri).get('enable', true));
    if (enabledFolders.length === 0) {
        if (folders.length === 1) {
            Window.showInformationMessage('Stylint is already disabled in the workspace.');
        } else {
            Window.showInformationMessage('Stylint is already disabled on all workspace folders.');
        }
        return;
    }
    pickFolder(enabledFolders, 'Select a workspace folder to disable Stylint for').then(folder => {
        if (!folder) {
            return;
        }
        Workspace.getConfiguration('stylint', folder.uri).update('enable', false);
    });
}

let dummyCommands: Disposable[];

let defaultLanguages = ['stylus'];
function shouldBeValidated(textDocument: TextDocument): boolean {
    let config = Workspace.getConfiguration('stylint', textDocument.uri);
    if (!config.get('enable', true)) {
        return false;
    }
    let validate = config.get<(ValidateItem | string)[]>('validate', defaultLanguages);
    for (let item of validate) {
        if (Is.string(item) && item === textDocument.languageId) {
            return true;
        } else if (ValidateItem.is(item) && item.language === textDocument.languageId) {
            return true;
        }
    }
    return false;
}

export function activate(context: ExtensionContext) {
    let activated: boolean;
    let openListener: Disposable;
    let configurationListener: Disposable;
    function didOpenTextDocument(textDocument: TextDocument) {
        if (activated) {
            return;
        }
        if (shouldBeValidated(textDocument)) {
            openListener.dispose();
            configurationListener.dispose();
            activated = true;
            realActivate(context);
        }
    }
    function configurationChanged() {
        if (activated) {
            return;
        }
        for (let textDocument of Workspace.textDocuments) {
            if (shouldBeValidated(textDocument)) {
                openListener.dispose();
                configurationListener.dispose();
                activated = true;
                realActivate(context);
                return;
            }
        }
    }
    openListener = Workspace.onDidOpenTextDocument(didOpenTextDocument);
    configurationListener = Workspace.onDidChangeConfiguration(configurationChanged);

    let notValidating = () => Window.showInformationMessage('This command is not implemented yet.');
    dummyCommands = [
        Commands.registerCommand('stylint.showOutputChannel', notValidating)
    ];

    context.subscriptions.push(
        // Commands.registerCommand('stylint.executeAutofix', notValidating),
        Commands.registerCommand('stylint.enable', enable),
        Commands.registerCommand('stylint.disable', disable)
    );
    configurationChanged();
}

export function realActivate(context: ExtensionContext) {

    let stylintWrapperPath = context.asAbsolutePath('resources/stylintwrapper.js')
    let stylintJsonReporterPath = context.asAbsolutePath('node_modules/stylint-json-reporter/index.js')
    let statusBarItem = Window.createStatusBarItem(StatusBarAlignment.Right, 0);
    let stylintStatus: Status = Status.ok;
    let serverRunning: boolean = false;

    statusBarItem.text = 'Stylint';
    statusBarItem.command = 'stylint.showOutputChannel';

    function showStatusBarItem(show: boolean): void {
        if (show) {
            statusBarItem.show();
        } else {
            statusBarItem.hide();
        }
    }

    function updateStatus(status: Status) {
        stylintStatus = status;
        switch (status) {
            case Status.ok:
                statusBarItem.text = 'Stylint';
                break;
            case Status.warn:
                statusBarItem.text = '$(alert) Stylint';
                break;
            case Status.error:
                statusBarItem.text = '$(issue-opened) Stylint';
                break;
            default:
                statusBarItem.text = 'Stylint';
        }
        updateStatusBarVisibility();
    }

    function updateStatusBarVisibility(): void {
        showStatusBarItem(
            (serverRunning && stylintStatus !== Status.ok) || Workspace.getConfiguration('stylint').get('alwaysShowStatus', false)
        );
    }

    // We need to go one level up since an extension compile the js code into
    // the output folder.
    // serverModule
    let serverModule = context.asAbsolutePath(path.join('server', 'out', 'stylintServer.js'));
    let serverOptions: ServerOptions = {
        run: { module: serverModule, transport: TransportKind.ipc, options: { cwd: process.cwd() } },
        debug: { module: serverModule, transport: TransportKind.ipc, options: { execArgv: ["--nolazy", "--inspect=6007"], cwd: process.cwd() } }
    };

    let defaultErrorHandler: ErrorHandler;
    let serverCalledProcessExit: boolean = false;

    let packageJsonFilter: DocumentFilter = { scheme: 'file', pattern: '**/package.json' };
    let configFileFilter: DocumentFilter = { scheme: 'file', pattern: '**/.stylintr{c.js,c.yaml,c.yml,c,c.json}' };
    let syncedDocuments: Map<string, TextDocument> = new Map<string, TextDocument>();

    Workspace.onDidChangeConfiguration(() => {
        for (let textDocument of syncedDocuments.values()) {
            if (!shouldBeValidated(textDocument)) {
                syncedDocuments.delete(textDocument.uri.toString());
                client.sendNotification(DidCloseTextDocumentNotification.type, client.code2ProtocolConverter.asCloseTextDocumentParams(textDocument));
            }
        }
        for (let textDocument of Workspace.textDocuments) {
            if (!syncedDocuments.has(textDocument.uri.toString()) && shouldBeValidated(textDocument)) {
                client.sendNotification(DidOpenTextDocumentNotification.type, client.code2ProtocolConverter.asOpenTextDocumentParams(textDocument));
                syncedDocuments.set(textDocument.uri.toString(), textDocument);
            }
        }
    });
    let clientOptions: LanguageClientOptions = {
        documentSelector: [{ scheme: 'file' }, { scheme: 'untitled' }],
        diagnosticCollectionName: 'stylint',
        revealOutputChannelOn: RevealOutputChannelOn.Never,
        synchronize: {
            // configurationSection: 'stylint',
            fileEvents: [
                Workspace.createFileSystemWatcher('**/.stylintr{c.js,c.yaml,c.yml,c,c.json}'),
                Workspace.createFileSystemWatcher('**/.stylintignore'),
                Workspace.createFileSystemWatcher('**/package.json')
            ]
        },
        initializationFailedHandler: (error) => {
            client.error('Server initialization failed.', error);
            client.outputChannel.show(true);
            return false;
        },
        errorHandler: {
            error: (error, message, count): ErrorAction => {
                return defaultErrorHandler.error(error, message, count);
            },
            closed: (): CloseAction => {
                if (serverCalledProcessExit) {
                    return CloseAction.DoNotRestart;
                }
                return defaultErrorHandler.closed();
            }
        },
        middleware: {
            didOpen: (document, next) => {
                if (Languages.match(packageJsonFilter, document) || Languages.match(configFileFilter, document) || shouldBeValidated(document)) {
                    next(document);
                    syncedDocuments.set(document.uri.toString(), document);
                    return;
                }
            },
            didChange: (event, next) => {
                if (syncedDocuments.has(event.document.uri.toString())) {
                    next(event);
                }
            },
            willSave: (event, next) => {
                if (syncedDocuments.has(event.document.uri.toString())) {
                    next(event);
                }
            },
            willSaveWaitUntil: (event, next) => {
                if (syncedDocuments.has(event.document.uri.toString())) {
                    return next(event);
                } else {
                    return Promise.resolve([]);
                }
            },
            didSave: (document, next) => {
                if (syncedDocuments.has(document.uri.toString())) {
                    next(document);
                }
            },
            didClose: (document, next) => {
                let uri = document.uri.toString();
                if (syncedDocuments.has(uri)) {
                    syncedDocuments.delete(uri);
                    next(document);
                }
            },
            provideCodeActions: (document, range, context, token, next): ProviderResult<(Command | CodeAction)[]> => {
                if (!syncedDocuments.has(document.uri.toString()) || !context.diagnostics || context.diagnostics.length === 0) {
                    return [];
                }
                let stylintDiagnostics: Diagnostic[] = [];
                for (let diagnostic of context.diagnostics) {
                    if (diagnostic.source === 'stylint') {
                        stylintDiagnostics.push(diagnostic);
                    }
                }
                if (stylintDiagnostics.length === 0) {
                    return [];
                }
                let newContext: CodeActionContext = Object.assign({}, context, { diagnostics: stylintDiagnostics } as CodeActionContext);
                return next(document, range, newContext, token);
            },
            workspace: {
                configuration: (params, _token, _next): any[] => {
                    if (!params.items) {
                        return null;
                    }
                    let result: (TextDocumentSettings | null)[] = [];
                    for (let item of params.items) {
                        if (item.section || !item.scopeUri) {
                            result.push(null);
                            continue;
                        }
                        let resource = client.protocol2CodeConverter.asUri(item.scopeUri);
                        let config = Workspace.getConfiguration('stylint', resource);
                        let settings: TextDocumentSettings = {
                            validate: false,
                            autoFix: false,
                            autoFixOnSave: false,
                            stylintWrapperPath: stylintWrapperPath,
                            stylintJsonReporterPath: stylintJsonReporterPath,
                            stylintrcPath: config.get('stylintrcPath'),
                            run: config.get('run', 'onType'),
                            nodePath: config.get('nodePath', undefined),
                            workingDirectory: undefined,
                            workspaceFolder: undefined,
                            library: undefined
                        }
                        let document: TextDocument = syncedDocuments.get(item.scopeUri);
                        if (!document) {
                            result.push(settings);
                            continue;
                        }
                        if (config.get('enabled', true)) {
                            let validateItems = config.get<(ValidateItem | string)[]>('validate', ['stylus']);
                            for (let item of validateItems) {
                                if (Is.string(item) && item === document.languageId) {
                                    settings.validate = true;
                                    if (item === 'javascript') { //TODO change to stylus
                                        settings.autoFix = true;
                                    }
                                    break;
                                }
                                else if (ValidateItem.is(item) && item.language === document.languageId) {
                                    settings.validate = true;
                                    settings.autoFix = item.autoFix;
                                    break;
                                }
                            }
                        }
                        if (settings.validate) {
                            settings.autoFixOnSave = settings.autoFix && config.get('autoFixOnSave', false);
                        }
                        let workspaceFolder = Workspace.getWorkspaceFolder(resource);
                        if (workspaceFolder) {
                            settings.workspaceFolder = {
                                name: workspaceFolder.name,
                                uri: client.code2ProtocolConverter.asUri(workspaceFolder.uri)
                            };
                        }
                        let workingDirectories = config.get<(string | DirectoryItem)[]>('workingDirectories', undefined);
                        if (Array.isArray(workingDirectories)) {
                            let workingDirectory = undefined;
                            let workspaceFolderPath = workspaceFolder && workspaceFolder.uri.scheme === 'file' ? workspaceFolder.uri.fsPath : undefined;
                            for (let entry of workingDirectories) {
                                let directory;
                                let changeProcessCWD = false;
                                if (Is.string(entry)) {
                                    directory = entry;
                                }
                                else if (DirectoryItem.is(entry)) {
                                    directory = entry.directory;
                                    changeProcessCWD = !!entry.changeProcessCWD;
                                }
                                if (directory) {
                                    if (path.isAbsolute(directory)) {
                                        directory = directory;
                                    }
                                    else if (workspaceFolderPath && directory) {
                                        directory = path.join(workspaceFolderPath, directory);
                                    }
                                    else {
                                        directory = undefined;
                                    }
                                    let filePath = document.uri.scheme === 'file' ? document.uri.fsPath : undefined;
                                    if (filePath && directory && filePath.startsWith(directory)) {
                                        if (workingDirectory) {
                                            if (workingDirectory.directory.length < directory.length) {
                                                workingDirectory.directory = directory;
                                                workingDirectory.changeProcessCWD = changeProcessCWD;
                                            }
                                        }
                                        else {
                                            workingDirectory = { directory, changeProcessCWD };
                                        }
                                    }
                                }
                            }
                            settings.workingDirectory = workingDirectory;
                        }
                        result.push(settings);
                    }
                    return result;
                }
            }
        }
    };

    let client = new LanguageClient('Stylint', serverOptions, clientOptions);
    client.registerProposedFeatures();
    defaultErrorHandler = client.createDefaultErrorHandler();
    const running = 'Stylint server is running.';
    const stopped = 'Stylint server stopped.'
    client.onDidChangeState((event) => {
        if (event.newState === ClientState.Running) {
            client.info(running);
            statusBarItem.tooltip = running;
            serverRunning = true;
        } else {
            client.info(stopped);
            statusBarItem.tooltip = stopped;
            serverRunning = false;
        }
        updateStatusBarVisibility();
    });
    client.onReady().then(() => {
        client.onNotification(StatusNotification.type, (params) => {
            updateStatus(params.state);
        });

        client.onNotification(exitCalled, (params) => {
            serverCalledProcessExit = true;
            client.error(`Server process exited with code ${params[0]}. This usually indicates a misconfigured Stylint setup.`, params[1]);
            Window.showErrorMessage(`Stylint server shut down itself. See 'Stylint' output channel for details.`);
        });

        client.onRequest(NoConfigRequest.type, (params) => {
            let document = Uri.parse(params.document.uri);
            let workspaceFolder = Workspace.getWorkspaceFolder(document);
            let fileLocation = document.fsPath;
            if (workspaceFolder) {
                client.warn([
                    '',
                    `No Stylint configuration (e.g .stylintrc) found for file: ${fileLocation}`,
                    `File will not be validated. Consider running 'stylint --init' in the workspace folder ${workspaceFolder.name}`,
                    `Alternatively you can disable Stylint by executing the 'Disable Stylint' command.`
                ].join('\n'));
            } else {
                client.warn([
                    '',
                    `No Stylint configuration (e.g .stylintrc) found for file: ${fileLocation}`,
                    `File will not be validated. Alternatively you can disable Stylint by executing the 'Disable Stylint' command.`
                ].join('\n'));
            }
            stylintStatus = Status.warn;
            updateStatusBarVisibility();
            return {};
        });

        client.onRequest(NoStylintLibraryRequest.type, (params) => {
            const key = 'noStylintMessageShown';
            let state = context.globalState.get<NoStylintState>(key, {});
            let uri: Uri = Uri.parse(params.source.uri);
            let workspaceFolder = Workspace.getWorkspaceFolder(uri);
            if (workspaceFolder) {

                client.info([
                    '',
                    `Failed to load the Stylint library for the document ${uri.fsPath}`,
                    '',
                    `To use Stylint please install stylint by running \'npm install stylint\' in the workspace folder ${workspaceFolder.name}`,
                    'or globally using \'npm install -g stylint\'. You need to reopen the workspace after installing stylint.',
                    '',
                    `Alternatively you can disable Stylint for the workspace folder ${workspaceFolder.name} by executing the 'Disable Stylint' command.`
                ].join('\n'));

                if (!state.workspaces) {
                    state.workspaces = Object.create(null);
                }
                if (!state.workspaces[workspaceFolder.uri.toString()]) {
                    state.workspaces[workspaceFolder.uri.toString()] = true;
                    client.outputChannel.show(true);
                    context.globalState.update(key, state);
                }
            } else {
                client.info([
                    `Failed to load the Stylint library for the document ${uri.fsPath}`,
                    'To use Stylint for single JavaScript file install stylint globally using \'npm install -g stylint\'.',
                    'You need to reopen VS Code after installing stylint.',
                ].join('\n'));

                if (!state.global) {
                    state.global = true;
                    client.outputChannel.show(true);
                    context.globalState.update(key, state);
                }
            }
            return {};
        });
    });

    if (dummyCommands) {
        dummyCommands.forEach(command => command.dispose());
        dummyCommands = undefined;
    }

    updateStatusBarVisibility();

    context.subscriptions.push(
        client.start(),
        // Commands.registerCommand('stylint.executeAutofix', () => {
        //     let textEditor = Window.activeTextEditor;
        //     if (!textEditor) {
        //         return;
        //     }
        //     let textDocument: VersionedTextDocumentIdentifier = {
        //         uri: textEditor.document.uri.toString(),
        //         version: textEditor.document.version
        //     };
        //     let params: ExecuteCommandParams = {
        //         command: 'stylint.applyAutoFix',
        //         arguments: [textDocument]
        //     }
        //     client.sendRequest(ExecuteCommandRequest.type, params).then(undefined, () => {
        //         Window.showErrorMessage('Failed to apply Stylint fixes to the document. Please consider opening an issue with steps to reproduce.');
        //     });
        // }),
        Commands.registerCommand('stylint.showOutputChannel', () => { client.outputChannel.show(); }),
        statusBarItem
    );
}

export function deactivate() {
    if (dummyCommands) {
        dummyCommands.forEach(command => command.dispose());
    }

    // if (taskProvider) {
    // 	taskProvider.dispose();
    // }
}
