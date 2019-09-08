/* --------------------------------------------------------------------------------------------
 * Copyright (c) Leo Hanisch. All rights reserved.
 * Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
'use strict';

import {
    createConnection, IConnection,
    ResponseError, RequestType, NotificationType, ErrorCodes,
    RequestHandler, NotificationHandler,
    Diagnostic, DiagnosticSeverity, Range, Files, CancellationToken,
    TextDocuments, TextDocument, TextDocumentSyncKind, TextEdit, TextDocumentIdentifier, TextDocumentSaveReason,
    Command, WorkspaceChange,
    CodeActionRequest, VersionedTextDocumentIdentifier,
    ExecuteCommandRequest, DidChangeWatchedFilesNotification, DidChangeConfigurationNotification,
    WorkspaceFolder, DidChangeWorkspaceFoldersNotification, CodeAction, CodeActionKind
} from 'vscode-languageserver';

import { StylintModule } from './stylintModule';
import * as fs from 'fs';
import { URI } from 'vscode-uri';
import * as path from 'path';

namespace Is {
    const toString = Object.prototype.toString;

    export function boolean(value: any): value is boolean {
        return value === true || value === false;
    }

    export function string(value: any): value is string {
        return toString.call(value) === '[object String]';
    }
}

namespace CommandIds {
    export const applySingleFix: string = 'stylint.applySingleFix';
    export const applySameFixes: string = 'stylint.applySameFixes';
    export const applyAllFixes: string = 'stylint.applyAllFixes';
    export const applyAutoFix: string = 'stylint.applyAutoFix';
}

interface StylintError extends Error {
    messageTemplate?: string;
    messageData?: {
        pluginName?: string;
    }
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

type RunValues = 'onType' | 'onSave';

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

interface TextDocumentSettings {
    packageManager: 'npm' | 'yarn';
    validate: boolean;
    autoFix: boolean;
    autoFixOnSave: boolean;
    stylintrcPath: string | undefined;
    stylintJsonReporterPath: string,
    run: RunValues;
    nodePath: string | undefined;
    workspaceFolder: WorkspaceFolder | undefined;
    workingDirectory: DirectoryItem | undefined;
    library: StylintModule | undefined;
    resolvedGlobalPackageManagerPath: string | undefined;
}

interface StylintAutoFixEdit {
    range: [number, number];
    text: string;
}

interface StylintProblem {
    line: number;
    column: number;
    severity: string;
    rule: string;
    message: string;
    endLine?: number;
    endColumn?: number;
    fix?: StylintAutoFixEdit;
}

interface StylintDocumentReport {
    filePath: string;
    errorCount: number;
    warningCount: number;
    messages: StylintProblem[];
}

function makeDiagnostic(problem: StylintProblem): Diagnostic {
    let message = (problem.rule != null)
        ? `${problem.message} (${problem.rule})`
        : `${problem.message}`;
    let startLine = Math.max(0, problem.line - 1);
    let startChar = Math.max(0, problem.column - 1);
    let endLine = problem.endLine != null ? Math.max(0, problem.endLine - 1) : startLine;
    let endChar = problem.endColumn != null ? Math.max(0, problem.endColumn - 1) : startChar;
    return {
        message: message,
        severity: convertSeverity(problem.severity),
        source: 'stylint',
        range: {
            start: { line: startLine, character: startChar },
            end: { line: endLine, character: endChar }
        },
        code: problem.rule
    };
}

interface AutoFix {
    label: string;
    documentVersion: number;
    ruleId: string;
    edit: StylintAutoFixEdit;
}

function computeKey(diagnostic: Diagnostic): string {
    let range = diagnostic.range;
    return `[${range.start.line},${range.start.character},${range.end.line},${range.end.character}]-${diagnostic.code}`;
}

let codeActions: Map<string, Map<string, AutoFix>> = new Map<string, Map<string, AutoFix>>();
function recordCodeAction(document: TextDocument, diagnostic: Diagnostic, problem: StylintProblem): void {
    if (!problem.fix || !problem.rule) {
        return;
    }
    let uri = document.uri;
    let edits: Map<string, AutoFix> = codeActions.get(uri);
    if (!edits) {
        edits = new Map<string, AutoFix>();
        codeActions.set(uri, edits);
    }
    edits.set(computeKey(diagnostic), { label: `Fix this ${problem.rule} problem`, documentVersion: document.version, ruleId: problem.rule, edit: problem.fix });
}

function convertSeverity(severity: string): DiagnosticSeverity {
    switch (severity) {
        case 'Warning':
            return DiagnosticSeverity.Warning;
        case 'Error':
            return DiagnosticSeverity.Error;
        default:
            return DiagnosticSeverity.Error;
    }
}

const enum CharCode {
    /**
     * The `\` character.
     */
    Backslash = 92,
}

/**
 * Check if the path follows this pattern: `\\hostname\shareName`.
 *
 * @see https://msdn.microsoft.com/en-us/library/gg465305.aspx
 * @return A boolean indication if the path is a UNC path, on none-windows
 * always false.
 */
function isUNC(path: string): boolean {
    if (process.platform !== 'win32') {
        // UNC is a windows concept
        return false;
    }

    if (!path || path.length < 5) {
        // at least \\a\b
        return false;
    }

    let code = path.charCodeAt(0);
    if (code !== CharCode.Backslash) {
        return false;
    }
    code = path.charCodeAt(1);
    if (code !== CharCode.Backslash) {
        return false;
    }
    let pos = 2;
    let start = pos;
    for (; pos < path.length; pos++) {
        code = path.charCodeAt(pos);
        if (code === CharCode.Backslash) {
            break;
        }
    }
    if (start === pos) {
        return false;
    }
    code = path.charCodeAt(pos + 1);
    if (isNaN(code) || code === CharCode.Backslash) {
        return false;
    }
    return true;
}

function getFileSystemPath(uri: URI): string {
    let result = uri.fsPath;
    if (process.platform === 'win32' && result.length >= 2 && result[1] === ':') {
        // Node by default uses an upper case drive letter and Stylint uses
        // === to compare paths which results in the equal check failing
        // if the drive letter is lower case in th URI. Ensure upper case.
        return result[0].toUpperCase() + result.substr(1);
    } else {
        return result;
    }
}


function getFilePath(documentOrUri: string | TextDocument): string {
    if (!documentOrUri) {
        return undefined;
    }
    let uri = Is.string(documentOrUri) ? URI.parse(documentOrUri) : URI.parse(documentOrUri.uri);
    if (uri.scheme !== 'file') {
        return undefined;
    }
    return getFileSystemPath(uri);
}

const exitCalled = new NotificationType<[number, string], void>('stylint/exitCalled');

const nodeExit = process.exit;
process.exit = ((code?: number): void => {
    let stack = new Error('stack');
    connection.sendNotification(exitCalled, [code ? code : 0, stack.stack]);
    setTimeout(() => {
        nodeExit(code);
    }, 1000);
}) as any;
process.on('uncaughtException', (error: any) => {
    let message: string;
    if (error) {
        if (typeof error.stack === 'string') {
            message = error.stack;
        } else if (typeof error.message === 'string') {
            message = error.message;
        } else if (typeof error === 'string') {
            message = error;
        }
        if (!message) {
            try {
                message = JSON.stringify(error, undefined, 4);
            } catch (e) {
                // Should not happen.
            }
        }
    }
    console.error('Uncaught exception received.');
    if (message) {
        console.error(message);
    }
});

let connection = createConnection();
let documents: TextDocuments = new TextDocuments();

let _globalNpmPath: string | null | undefined;
function globalNpmPath(): string {
    if (_globalNpmPath === void 0) {
        _globalNpmPath = Files.resolveGlobalNodePath(trace);
        if (_globalNpmPath === void 0) {
            _globalNpmPath = null;
        }
    }
    if (_globalNpmPath === null) {
        return undefined;
    }
    return _globalNpmPath;
}

let _globalYarnPath: string | undefined;
function globalYarnPath(): string {
    if (_globalYarnPath === void 0) {
        _globalYarnPath = Files.resolveGlobalYarnPath(trace);
        if (_globalYarnPath === void 0) {
            _globalYarnPath = null;
        }
    }
    if (_globalYarnPath === null) {
        return undefined;
    }
    return _globalYarnPath;
}

let path2Library: Map<string, StylintModule> = new Map<string, StylintModule>();
let document2Settings: Map<string, Thenable<TextDocumentSettings>> = new Map<string, Thenable<TextDocumentSettings>>();

function resolveSettings(document: TextDocument): Thenable<TextDocumentSettings> {
    let uri = document.uri;
    let resultPromise = document2Settings.get(uri);
    if (resultPromise) {
        return resultPromise;
    }
    resultPromise = connection.workspace.getConfiguration({ scopeUri: uri, section: '' }).then((settings: TextDocumentSettings) => {
        if (settings.packageManager === 'npm') {
            settings.resolvedGlobalPackageManagerPath = globalNpmPath();
        } else if (settings.packageManager === 'yarn') {
            settings.resolvedGlobalPackageManagerPath = globalYarnPath();
        }
        let uri = URI.parse(document.uri);
        let promise: Thenable<string>
        if (uri.scheme === 'file') {
            let file = uri.fsPath;
            let directory = path.dirname(file);
            if (settings.nodePath) {
                let nodePath = settings.nodePath;
                if (!path.isAbsolute(nodePath) && settings.workspaceFolder !== void 0) {
                    let uri = URI.parse(settings.workspaceFolder.uri);
                    if (uri.scheme === 'file') {
                        nodePath = path.join(uri.fsPath, nodePath);
                    }
                }
                promise = Files.resolve('stylint', nodePath, nodePath, trace).then<string, string>(undefined, () => {
                    return Files.resolve('stylint', settings.resolvedGlobalPackageManagerPath, directory, trace);
                });
            } else {
                promise = Files.resolve('stylint', settings.resolvedGlobalPackageManagerPath, directory, trace);
            }
        } else {
            promise = Files.resolve('stylint', settings.resolvedGlobalPackageManagerPath, settings.workspaceFolder ? settings.workspaceFolder.uri : undefined, trace);
        }
        return promise.then((resolvedPath) => {
            let library = path2Library.get(resolvedPath);
            if (!library) {
                library = new StylintModule();
                library.stylintrcPath = settings.stylintrcPath
                library.stylintExecPath = path.join(path.dirname(resolvedPath), 'bin', 'stylint');
                if (!fs.existsSync(library.stylintExecPath)) {
                    settings.validate = false;
                    connection.console.error(`The stylint exec path="${library.stylintExecPath}" doesn\'t exist. You need at least stylint@1.5.9`);
                } else {
                    connection.console.info(`Stylint exec path set to ${library.stylintExecPath}`);
                    settings.library = library;
                }
                path2Library.set(resolvedPath, library);
            } else {
                settings.library = library;
            }
            return settings;
        }, () => {
            settings.validate = false;
            connection.sendRequest(NoStylintLibraryRequest.type, { source: { uri: document.uri } });
            return settings;
        });
    });
    document2Settings.set(uri, resultPromise);
    return resultPromise;
}

interface Request<P, R> {
    method: string;
    params: P;
    documentVersion: number | undefined;
    resolve: (value: R | Thenable<R>) => void | undefined;
    reject: (error: any) => void | undefined;
    token: CancellationToken | undefined;
}

namespace Request {
    export function is(value: any): value is Request<any, any> {
        let candidate: Request<any, any> = value;
        return candidate && !!candidate.token && !!candidate.resolve && !!candidate.reject;
    }
}

interface Notification<P> {
    method: string;
    params: P;
    documentVersion: number;
}

type Message<P, R> = Notification<P> | Request<P, R>;

interface VersionProvider<P> {
    (params: P): number;
}

namespace Thenable {
    export function is<T>(value: any): value is Thenable<T> {
        let candidate: Thenable<T> = value;
        return candidate && typeof candidate.then === 'function';
    }
}

class BufferedMessageQueue {

    private queue: Message<any, any>[];
    private requestHandlers: Map<string, { handler: RequestHandler<any, any, any>, versionProvider?: VersionProvider<any> }>;
    private notificationHandlers: Map<string, { handler: NotificationHandler<any>, versionProvider?: VersionProvider<any> }>;
    private timer: NodeJS.Immediate | undefined;

    constructor(private connection: IConnection) {
        this.queue = [];
        this.requestHandlers = new Map();
        this.notificationHandlers = new Map();
    }

    public registerRequest<P, R, E, RO>(type: RequestType<P, R, E, RO>, handler: RequestHandler<P, R, E>, versionProvider?: VersionProvider<P>): void {
        this.connection.onRequest(type, (params, token) => {
            return new Promise<R>((resolve, reject) => {
                this.queue.push({
                    method: type.method,
                    params: params,
                    documentVersion: versionProvider ? versionProvider(params) : undefined,
                    resolve: resolve,
                    reject: reject,
                    token: token
                });
                this.trigger();
            });
        });
        this.requestHandlers.set(type.method, { handler, versionProvider });
    }

    public registerNotification<P, RO>(type: NotificationType<P, RO>, handler: NotificationHandler<P>, versionProvider?: (params: P) => number): void {
        connection.onNotification(type, (params) => {
            this.queue.push({
                method: type.method,
                params: params,
                documentVersion: versionProvider ? versionProvider(params) : undefined,
            });
            this.trigger();
        });
        this.notificationHandlers.set(type.method, { handler, versionProvider });
    }

    public addNotificationMessage<P, RO>(type: NotificationType<P, RO>, params: P, version: number) {
        this.queue.push({
            method: type.method,
            params,
            documentVersion: version
        });
        this.trigger();
    }

    public onNotification<P, RO>(type: NotificationType<P, RO>, handler: NotificationHandler<P>, versionProvider?: (params: P) => number): void {
        this.notificationHandlers.set(type.method, { handler, versionProvider });
    }

    private trigger(): void {
        if (this.timer || this.queue.length === 0) {
            return;
        }
        this.timer = setImmediate(() => {
            this.timer = undefined;
            this.processQueue();
        });
    }

    private processQueue(): void {
        let message = this.queue.shift();
        if (!message) {
            return;
        }
        if (Request.is(message)) {
            let requestMessage = message;
            if (requestMessage.token.isCancellationRequested) {
                requestMessage.reject(new ResponseError(ErrorCodes.RequestCancelled, 'Request got cancelled'));
                return;
            }
            let elem = this.requestHandlers.get(requestMessage.method);
            if (elem.versionProvider && requestMessage.documentVersion !== void 0 && requestMessage.documentVersion !== elem.versionProvider(requestMessage.params)) {
                requestMessage.reject(new ResponseError(ErrorCodes.RequestCancelled, 'Request got cancelled'));
                return;
            }
            let result = elem.handler(requestMessage.params, requestMessage.token);
            if (Thenable.is(result)) {
                result.then((value) => {
                    requestMessage.resolve(value);
                }, (error) => {
                    requestMessage.reject(error);
                });
            } else {
                requestMessage.resolve(result);
            }
        } else {
            let notificationMessage = message;
            let elem = this.notificationHandlers.get(notificationMessage.method);
            if (elem.versionProvider && notificationMessage.documentVersion !== void 0 && notificationMessage.documentVersion !== elem.versionProvider(notificationMessage.params)) {
                return;
            }
            elem.handler(notificationMessage.params);
        }
        this.trigger();
    }
}

let messageQueue: BufferedMessageQueue = new BufferedMessageQueue(connection);

namespace ValidateNotification {
    export const type: NotificationType<TextDocument, void> = new NotificationType<TextDocument, void>('stylint/validate');
}

messageQueue.onNotification(ValidateNotification.type, (document) => {
    validateSingle(document, true);
}, (document): number => {
    return document.version
});

// The documents manager listen for text document create, change
// and close on the connection
documents.listen(connection);
documents.onDidOpen((event) => {
    resolveSettings(event.document).then((settings) => {
        if (!settings.validate) {
            return;
        }
        if (settings.run === 'onSave') {
            messageQueue.addNotificationMessage(ValidateNotification.type, event.document, event.document.version);
        }
    });
});

// A text document has changed. Validate the document according the run setting.
documents.onDidChangeContent((event) => {
    resolveSettings(event.document).then((settings) => {
        if (!settings.validate || settings.run !== 'onType') {
            return;
        }
        messageQueue.addNotificationMessage(ValidateNotification.type, event.document, event.document.version);
    });
});

function getFixes(textDocument: TextDocument): TextEdit[] {
    let uri = textDocument.uri
    let edits = codeActions.get(uri);
    function createTextEdit(editInfo: AutoFix): TextEdit {
        return TextEdit.replace(Range.create(textDocument.positionAt(editInfo.edit.range[0]), textDocument.positionAt(editInfo.edit.range[1])), editInfo.edit.text || '');
    }
    if (edits) {
        let fixes = new Fixes(edits);
        if (fixes.isEmpty() || textDocument.version !== fixes.getDocumentVersion()) {
            return [];
        }
        return fixes.getOverlapFree().map(createTextEdit);
    }
    return [];
}

documents.onWillSaveWaitUntil((event) => {
    if (event.reason === TextDocumentSaveReason.AfterDelay) {
        return [];
    }

    let document = event.document;
    return resolveSettings(document).then((settings) => {
        if (!settings.autoFixOnSave) {
            return [];
        }
        // If we validate on save and want to apply fixes on will save
        // we need to validate the file.
        if (settings.run === 'onSave') {
            // Do not queue this since we want to get the fixes as fast as possible.
            return validateSingle(document, false).then(() => getFixes(document));
        } else {
            return getFixes(document);
        }
    });
});

// A text document has been saved. Validate the document according the run setting.
documents.onDidSave((event) => {
    resolveSettings(event.document).then((settings) => {
        if (!settings.validate || settings.run !== 'onSave') {
            return;
        }
        messageQueue.addNotificationMessage(ValidateNotification.type, event.document, event.document.version);
    })
});

documents.onDidClose((event) => {
    resolveSettings(event.document).then((settings) => {
        let uri = event.document.uri;
        document2Settings.delete(uri);
        codeActions.delete(uri);
        if (settings.validate) {
            connection.sendDiagnostics({ uri: uri, diagnostics: [] });
        }
    });
});

function environmentChanged() {
    document2Settings.clear();
    for (let document of documents.all()) {
        messageQueue.addNotificationMessage(ValidateNotification.type, document, document.version);
    }
}

function trace(message: string, verbose?: string): void {
    connection.tracer.log(message, verbose);
}

connection.onInitialize((_params) => {
    return {
        capabilities: {
            textDocumentSync: {
                openClose: true,
                change: TextDocumentSyncKind.Full,
                willSaveWaitUntil: true,
                save: {
                    includeText: false
                }
            },
            codeActionProvider: true,
            executeCommandProvider: {
                commands: [CommandIds.applySingleFix, CommandIds.applySameFixes, CommandIds.applyAllFixes, CommandIds.applyAutoFix]
            }
        }
    };
});

connection.onInitialized(() => {
    connection.client.register(DidChangeConfigurationNotification.type, undefined);
    connection.client.register(DidChangeWorkspaceFoldersNotification.type, undefined);
})

messageQueue.registerNotification(DidChangeConfigurationNotification.type, (_params) => {
    environmentChanged();
});

messageQueue.registerNotification(DidChangeWorkspaceFoldersNotification.type, (_params) => {
    environmentChanged();
});

const singleErrorHandlers: ((error: any, document: TextDocument, library: StylintModule) => Status)[] = [
    tryHandleNoConfig,
    tryHandleConfigError,
    tryHandleMissingModule,
    showErrorMessage
];

function validateSingle(document: TextDocument, publishDiagnostics: boolean = true): Thenable<void> {
    // We validate document in a queue but open / close documents directly. So we need to deal with the
    // fact that a document might be gone from the server.
    if (!documents.get(document.uri)) {
        return Promise.resolve(undefined);
    }
    return resolveSettings(document).then((settings) => {
        if (!settings.validate) {
            return;
        }

        validate(document, settings, publishDiagnostics)
            .then(() => {
                connection.sendNotification(StatusNotification.type, { state: Status.ok });

            })
            .catch((reason) => {
                let status = undefined;
                for (let handler of singleErrorHandlers) {
                    status = handler(reason, document, settings.library);
                    if (status) {
                        break;
                    }
                }
                status = status || Status.error;
                connection.sendNotification(StatusNotification.type, { state: status });
            });
    });
}

function validateMany(documents: TextDocument[]): void {
    documents.forEach(document => {
        messageQueue.addNotificationMessage(ValidateNotification.type, document, document.version);
    });
}

function getMessage(err: any, document: TextDocument): string {
    let result: string = null;
    if (typeof err.message === 'string' || err.message instanceof String) {
        result = <string>err.message;
        result = result.replace(/\r?\n/g, ' ');
        if (/^CLI: /.test(result)) {
            result = result.substr(5);
        }
    } else {
        result = `An unknown error occurred while validating document: ${document.uri}`;
    }
    return result;
}

async function validate(document: TextDocument, settings: TextDocumentSettings, publishDiagnostics: boolean = true): Promise<void> {
    let uri = document.uri;
    let file = getFilePath(document);
    let cwd = process.cwd();

    try {
        if (file) {
            if (settings.workingDirectory) {
                if (settings.workingDirectory.changeProcessCWD) {
                    process.chdir(settings.workingDirectory.directory);
                }
            } else if (settings.workspaceFolder) {
                let workspaceFolderUri = URI.parse(settings.workspaceFolder.uri);
                if (workspaceFolderUri.scheme === 'file') {
                    const fsPath = getFileSystemPath(workspaceFolderUri);
                    process.chdir(fsPath);
                }
            }
        }

        const cli = settings.library;
        cli.jsonReporterPath = settings.stylintJsonReporterPath;
        cli.stylintrcPath = settings.stylintrcPath;
        codeActions.delete(uri);
        let report: StylintDocumentReport[] = await cli.validate(file);
        let diagnostics: Diagnostic[] = [];
        if (Array.isArray(report) && report.length == 1) {
            let docReport = report[0];
            if (docReport.messages && Array.isArray(docReport.messages)) {
                docReport.messages.forEach((problem) => {
                    if (problem) {
                        let diagnostic = makeDiagnostic(problem);
                        diagnostics.push(diagnostic);
                        if (settings.autoFix) {
                            recordCodeAction(document, diagnostic, problem);
                        }
                    }
                });
            }
        }
        if (publishDiagnostics) {
            connection.sendDiagnostics({ uri, diagnostics });
        }
    } finally {
        if (cwd !== process.cwd()) {
            process.chdir(cwd);
        }
    }
}

let noConfigReported: Map<string, StylintModule> = new Map<string, StylintModule>();

function isNoConfigFoundError(error: any): boolean {
    let candidate = error as StylintError;
    return candidate.messageTemplate === 'no-config-found' || candidate.message === 'No Stylint configuration found.';
}

function tryHandleNoConfig(error: any, document: TextDocument, library: StylintModule): Status {
    if (!isNoConfigFoundError(error)) {
        return undefined;
    }
    if (!noConfigReported.has(document.uri)) {
        connection.sendRequest(
            NoConfigRequest.type,
            {
                message: getMessage(error, document),
                document: {
                    uri: document.uri
                }
            })
            .then(undefined, () => { });
        noConfigReported.set(document.uri, library);
    }
    return Status.warn;
}

let configErrorReported: Map<string, StylintModule> = new Map<string, StylintModule>();

function tryHandleConfigError(error: any, document: TextDocument, library: StylintModule): Status {
    if (!error.message) {
        return undefined;
    }

    function handleFileName(filename: string): Status {
        if (!configErrorReported.has(filename)) {
            connection.console.error(getMessage(error, document));
            if (!documents.get(URI.file(filename).toString())) {
                connection.window.showInformationMessage(getMessage(error, document));
            }
            configErrorReported.set(filename, library);
        }
        return Status.warn;
    }

    let matches = /Cannot read config file:\s+(.*)\nError:\s+(.*)/.exec(error.message);
    if (matches && matches.length === 3) {
        return handleFileName(matches[1]);
    }

    matches = /(.*):\n\s*Configuration for rule \"(.*)\" is /.exec(error.message);
    if (matches && matches.length === 3) {
        return handleFileName(matches[1]);
    }

    matches = /Cannot find module '([^']*)'\nReferenced from:\s+(.*)/.exec(error.message);
    if (matches && matches.length === 3) {
        return handleFileName(matches[2]);
    }

    return undefined;
}

let missingModuleReported: Map<string, StylintModule> = new Map<string, StylintModule>();

function tryHandleMissingModule(error: any, document: TextDocument, library: StylintModule): Status {
    if (!error.message) {
        return undefined;
    }

    function handleMissingModule(plugin: string, module: string, error: StylintError): Status {
        if (!missingModuleReported.has(plugin)) {
            let fsPath = getFilePath(document);
            missingModuleReported.set(plugin, library);
            if (error.messageTemplate === 'plugin-missing') {
                connection.console.error([
                    '',
                    `${error.message.toString()}`,
                    `Happened while validating ${fsPath ? fsPath : document.uri}`,
                    `This can happen for a couple of reasons:`,
                    `1. The plugin name is spelled incorrectly in an Stylint configuration file (e.g. .stylintrc).`,
                    `2. If Stylint is installed globally, then make sure ${module} is installed globally as well.`,
                    `3. If Stylint is installed locally, then ${module} isn't installed correctly.`,
                    '',
                    `Consider running stylint --debug ${fsPath ? fsPath : document.uri} from a terminal to obtain a trace about the configuration files used.`
                ].join('\n'));
            } else {
                connection.console.error([
                    `${error.message.toString()}`,
                    `Happened while validating ${fsPath ? fsPath : document.uri}`
                ].join('\n'));
            }
        }
        return Status.warn;
    }

    let matches = /Failed to load plugin (.*): Cannot find module (.*)/.exec(error.message);
    if (matches && matches.length === 3) {
        return handleMissingModule(matches[1], matches[2], error);
    }

    return undefined;
}

function showErrorMessage(error: any, document: TextDocument): Status {
    connection.window.showErrorMessage(`Stylint: ${getMessage(error, document)}. Please see the 'Stylint' output channel for details.`);
    if (Is.string(error.stack)) {
        connection.console.error('Stylint stack trace:');
        connection.console.error(error.stack);
    }
    return Status.error;
}

messageQueue.registerNotification(DidChangeWatchedFilesNotification.type, (params) => {
    // A .stylintrc has change. No smartness here.
    // Simply revalidate all file.
    noConfigReported = new Map<string, StylintModule>();;
    missingModuleReported = new Map<string, StylintModule>();;
    params.changes.forEach((change) => {
        let fsPath = getFilePath(change.uri);
        if (!fsPath || isUNC(fsPath)) {
            return;
        }
        let dirname = path.dirname(fsPath);
        if (dirname) {
            let library = configErrorReported.get(fsPath);
            if (library) {
                let cli = library
                try {
                    cli.validate(path.join(dirname, '*.styl'))
                    configErrorReported.delete(fsPath);
                } catch (error) {
                }
            }
        }
    });
    validateMany(documents.all());
});

class Fixes {
    constructor(private edits: Map<string, AutoFix>) {
    }

    public static overlaps(lastEdit: AutoFix, newEdit: AutoFix): boolean {
        return !!lastEdit && lastEdit.edit.range[1] > newEdit.edit.range[0];
    }

    public isEmpty(): boolean {
        return this.edits.size === 0;
    }

    public getDocumentVersion(): number {
        if (this.isEmpty()) {
            throw new Error('No edits recorded.');
        }
        return this.edits.values().next().value.documentVersion;
    }

    public getScoped(diagnostics: Diagnostic[]): AutoFix[] {
        let result: AutoFix[] = [];
        for (let diagnostic of diagnostics) {
            let key = computeKey(diagnostic);
            let editInfo = this.edits.get(key);
            if (editInfo) {
                result.push(editInfo);
            }
        }
        return result;
    }

    public getAllSorted(): AutoFix[] {
        let result: AutoFix[] = [];
        this.edits.forEach((value) => result.push(value));
        return result.sort((a, b) => {
            let d = a.edit.range[0] - b.edit.range[0];
            if (d !== 0) {
                return d;
            }
            if (a.edit.range[1] === 0) {
                return -1;
            }
            if (b.edit.range[1] === 0) {
                return 1;
            }
            return a.edit.range[1] - b.edit.range[1];
        });
    }

    public getOverlapFree(): AutoFix[] {
        let sorted = this.getAllSorted();
        if (sorted.length <= 1) {
            return sorted;
        }
        let result: AutoFix[] = [];
        let last: AutoFix = sorted[0];
        result.push(last);
        for (let i = 1; i < sorted.length; i++) {
            let current = sorted[i];
            if (!Fixes.overlaps(last, current)) {
                result.push(current);
                last = current;
            }
        }
        return result;
    }
}

let commands: Map<string, WorkspaceChange>;
messageQueue.registerRequest(CodeActionRequest.type, (params) => {
    commands = new Map<string, WorkspaceChange>();
    let result: CodeAction[] = [];
    let uri = params.textDocument.uri;
    let edits = codeActions.get(uri);
    if (!edits) {
        return result;
    }

    let fixes = new Fixes(edits);
    if (fixes.isEmpty()) {
        return result;
    }

    let textDocument = documents.get(uri);
    let documentVersion: number = -1;
    let ruleId: string;

    function createTextEdit(editInfo: AutoFix): TextEdit {
        return TextEdit.replace(Range.create(textDocument.positionAt(editInfo.edit.range[0]), textDocument.positionAt(editInfo.edit.range[1])), editInfo.edit.text || '');
    }

    function getLastEdit(array: AutoFix[]): AutoFix {
        let length = array.length;
        if (length === 0) {
            return undefined;
        }
        return array[length - 1];
    }

    for (let editInfo of fixes.getScoped(params.context.diagnostics)) {
        documentVersion = editInfo.documentVersion;
        ruleId = editInfo.ruleId;
        let workspaceChange = new WorkspaceChange();
        workspaceChange.getTextEditChange({ uri, version: documentVersion }).add(createTextEdit(editInfo));
        commands.set(CommandIds.applySingleFix, workspaceChange);
        result.push(CodeAction.create(
            editInfo.label,
            Command.create(editInfo.label, CommandIds.applySingleFix),
            CodeActionKind.QuickFix
        ));
    };

    if (result.length > 0) {
        let same: AutoFix[] = [];
        let all: AutoFix[] = [];

        for (let editInfo of fixes.getAllSorted()) {
            if (documentVersion === -1) {
                documentVersion = editInfo.documentVersion;
            }
            if (editInfo.ruleId === ruleId && !Fixes.overlaps(getLastEdit(same), editInfo)) {
                same.push(editInfo);
            }
            if (!Fixes.overlaps(getLastEdit(all), editInfo)) {
                all.push(editInfo);
            }
        }
        if (same.length > 1) {
            let sameFixes: WorkspaceChange = new WorkspaceChange();
            let sameTextChange = sameFixes.getTextEditChange({ uri, version: documentVersion });
            same.map(createTextEdit).forEach(edit => sameTextChange.add(edit));
            commands.set(CommandIds.applySameFixes, sameFixes);
            let title = `Fix all ${ruleId} problems`;
            let command = Command.create(title, CommandIds.applySameFixes);
            result.push(CodeAction.create(
                title,
                command,
                CodeActionKind.QuickFix
            ));
        }
        if (all.length > 1) {
            let allFixes: WorkspaceChange = new WorkspaceChange();
            let allTextChange = allFixes.getTextEditChange({ uri, version: documentVersion });
            all.map(createTextEdit).forEach(edit => allTextChange.add(edit));
            commands.set(CommandIds.applyAllFixes, allFixes);
            let title = `Fix all auto-fixable problems`;
            let command = Command.create(title, CommandIds.applyAllFixes);
            result.push(CodeAction.create(
                title,
                command,
                CodeActionKind.QuickFix
            ));
        }
    }
    return result;
}, (params): number => {
    let document = documents.get(params.textDocument.uri);
    return document ? document.version : undefined;
});

function computeAllFixes(identifier: VersionedTextDocumentIdentifier): TextEdit[] {
    let uri = identifier.uri;
    let textDocument = documents.get(uri);
    if (!textDocument || identifier.version !== textDocument.version) {
        return undefined;
    }
    let edits = codeActions.get(uri);
    function createTextEdit(editInfo: AutoFix): TextEdit {
        return TextEdit.replace(Range.create(textDocument.positionAt(editInfo.edit.range[0]), textDocument.positionAt(editInfo.edit.range[1])), editInfo.edit.text || '');
    }

    if (edits) {
        let fixes = new Fixes(edits);
        if (!fixes.isEmpty()) {
            return fixes.getOverlapFree().map(createTextEdit);
        }
    }
    return undefined;
};

messageQueue.registerRequest(ExecuteCommandRequest.type, (params) => {
    let workspaceChange: WorkspaceChange;
    if (params.command === CommandIds.applyAutoFix) {
        let identifier: VersionedTextDocumentIdentifier = params.arguments[0];
        let edits = computeAllFixes(identifier);
        if (edits) {
            workspaceChange = new WorkspaceChange();
            let textChange = workspaceChange.getTextEditChange(identifier);
            edits.forEach(edit => textChange.add(edit));
        }
    } else {
        workspaceChange = commands.get(params.command);
    }

    if (!workspaceChange) {
        return {};
    }
    return connection.workspace.applyEdit(workspaceChange.edit).then((response) => {
        if (!response.applied) {
            connection.console.error(`Failed to apply command: ${params.command}`);
        }
        return {};
    }, () => {
        connection.console.error(`Failed to apply command: ${params.command}`);
    });
}, (params): number => {
    if (params.command === CommandIds.applyAutoFix) {
        let identifier: VersionedTextDocumentIdentifier = params.arguments[0];
        return identifier.version;
    } else {
        return undefined;
    }
});

connection.tracer.
    connection.listen();
