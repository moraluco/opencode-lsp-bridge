'use strict';

import {
    createConnection, ProposedFeatures, Connection, TextDocuments,
    Diagnostic, DiagnosticSeverity, InitializeResult, TextDocumentPositionParams, CompletionItem,
    CompletionItemKind, SignatureHelp, Hover, DocumentSymbolParams, SymbolInformation,
    WorkspaceSymbolParams, Definition, ExecuteCommandParams, VersionedTextDocumentIdentifier, Location,
    TextDocumentSyncKind, SemanticTokensOptions, SemanticTokensLegend,
    SemanticTokensParams, SemanticTokens, SemanticTokensBuilder, ReferenceOptions, ReferenceParams,
    CodeLens, CodeLensParams, DocumentHighlight, DocumentHighlightKind, DocumentHighlightParams, DidOpenTextDocumentParams,
    RenameParams, WorkspaceEdit, ResponseError, PrepareRenameParams, Range, Position, Command, SemanticTokensDeltaParams,
    SemanticTokensDelta, TextDocumentItem,
    CodeActionParams,
    CodeAction,
    DidCloseTextDocumentParams,
    FileChangeType,
    DidChangeConfigurationParams, TextEdit,
    DocumentColorRegistrationOptions, DocumentColorParams, ColorInformation,
    ColorPresentationParams, ColorPresentation,
    TypeHierarchyItem, TypeHierarchyPrepareParams,
    TypeHierarchySupertypesParams, TypeHierarchySubtypesParams,
    WorkspaceSymbol, DocumentSymbol,
    InlayHint, InlayHintParams,
    InlineValue, InlineValueParams,
} from 'vscode-languageserver/node';
import { TextDocument, TextDocumentContentChangeEvent } from 'vscode-languageserver-textdocument';

import { Socket } from 'net';
import { URI } from 'vscode-uri'

import * as scriptfiles from './as_parser';
import * as parsedcompletion from './parsed_completion';
import * as typedb from './database';
import * as scriptreferences from './references';
import * as scriptoccurances from './highlight_occurances';
import * as scriptsemantics from './semantic_highlighting';
import * as scriptsymbols from './symbols';
import * as scriptdiagnostics from './ls_diagnostics';
import * as scriptlenses from './code_lenses';
import * as scriptactions from './code_actions';
import * as generatedcode from './generated_code';
import * as inlayhints from './inlay_hints';
import * as inlinevalues from './inline_values';
import * as colorpicker from './color_picker';
import * as typehierarchy from './type_hierarchy';
import * as api_docs from './api_docs';
import * as predefined from './load_predefined';
import * as fs from 'fs';
import {glob} from 'glob';

import {
    Message, MessageType, readMessages,
} from './unreal-buffers';

// Create a connection for the server. Auto-detect transport (--stdio / --node-ipc)
let connection: Connection = createConnection(ProposedFeatures.all);

// ─── TCP connection to Unreal Editor ────────────────────────────
let unreal: Socket;
const hostname = "127.0.0.1";
let port: number = 27099;
let reconnectTimeoutId: any = undefined;
let tcpTimedOut: boolean = false;

function connect_unreal()
{
    if (reconnectTimeoutId)
    {
        clearTimeout(reconnectTimeoutId);
        reconnectTimeoutId = undefined;
    }

    if (unreal != null)
    {
        unreal.removeAllListeners();
        unreal.destroy();
    }
    unreal = new Socket;

    unreal.on("data", function(data : Buffer) {
        let messages : Array<Message> = readMessages(data);
        for (let msg of messages)
        {
            if (msg.type == MessageType.Diagnostics)
            {
                let diagnostics: Diagnostic[] = [];

                // Based on https://en.wikipedia.org/wiki/File_URI_scheme,
                // file:/// should be on both platforms, but on Linux the path
                // begins with / while on Windows it is omitted. So we need to
                // add it here to make sure both platforms are valid.
                let localpath = msg.readString();
                let filename = (localpath[0] == '/') ? ("file://" + localpath) : ("file:///" + localpath);

                let msgCount = msg.readInt();
                for (let i = 0; i < msgCount; ++i)
                {
                    let message = msg.readString();
                    let line = msg.readInt();
                    let char = msg.readInt();
                    let isError = msg.readBool();
                    let isInfo = msg.readBool();

                    if (isInfo)
                    {
                        let hasExisting : boolean = false;
                        for(let diag of diagnostics)
                        {
                            if (diag.range.start.line == line-1)
                                hasExisting = true;
                        }

                        if(!hasExisting)
                            continue;
                    }

                    if (line <= 0)
                        line = 1;

                    let diagnosic: Diagnostic = {
                        severity: isInfo ? DiagnosticSeverity.Information : (isError ? DiagnosticSeverity.Error : DiagnosticSeverity.Warning),
                        range: {
                            start: { line: line-1, character: 0 },
                            end: { line: line-1, character: 10000 }
                        },
                        message: message,
                        source: 'as'
                    };
                    diagnostics.push(diagnosic);
                }

                scriptdiagnostics.UpdateCompileDiagnostics(filename, diagnostics);
            }
            else if(msg.type == MessageType.DebugDatabase)
            {
                let dbStr = msg.readString();
                let dbObj = JSON.parse(dbStr);
                typedb.AddTypesFromUnreal(dbObj);
            }
            else if(msg.type == MessageType.DebugDatabaseFinished)
            {
                // TCP data is authoritative — mark types ready from TCP
                typedb.FinishTypesFromUnreal();

                let scriptSettings = scriptfiles.GetScriptSettings();
                typedb.AddPrimitiveTypes(scriptSettings.floatIsFloat64);

                // Make sure no modules are resolved anymore
                ReResolveAllModules();
            }
            else if(msg.type == MessageType.DebugDatabaseSettings)
            {
                let version = msg.readInt();

                let scriptSettings = scriptfiles.GetScriptSettings();
                scriptSettings.automaticImports = msg.readBool();

                if (version >= 2)
                    scriptSettings.floatIsFloat64 = msg.readBool();
                if (version >= 3)
                    scriptSettings.useAngelscriptHaze = msg.readBool();
                scriptlenses.GetCodeLensSettings().engineSupportsCreateBlueprint = (version >= 4);
                if (version >= 5)
                {
                    scriptSettings.deprecateStaticClass = msg.readBool();
                    scriptSettings.disallowStaticClass = msg.readBool();
                }
                if (version >= 6)
                {
                    scriptSettings.exposeGlobalFunctions = msg.readBool();
                }
                if (version >= 7)
                {
                    scriptSettings.deprecateActorGenerics = msg.readBool();
                    scriptSettings.disallowActorGenerics = msg.readBool();
                }
            }
            // NOTE: AssetDatabase/AssetDatabaseInit/AssetDatabaseFinished skipped
            // (assets.ts not restored — UE asset DB not needed for our use case)
            // ReplaceAssetDefinition skipped (requires assets.ts)
            // buildGoTo/buildCreateBlueprint/buildOpenAssets skipped (editor commands removed)
        }
    });

    unreal.on("error", function() {
        if (unreal != null)
        {
            unreal.destroy();
            unreal = null;
            if (!reconnectTimeoutId)
                reconnectTimeoutId = setTimeout(connect_unreal, 5000);
        }
    });

    unreal.on("close", function() {
        if (unreal != null)
        {
            unreal.destroy();
            unreal = null;
            if (!reconnectTimeoutId)
                reconnectTimeoutId = setTimeout(connect_unreal, 5000);
        }
    });

    unreal.connect(port, hostname, function()
    {
        setTimeout(function()
        {
            if (!unreal)
                return;
            let reqDb = Buffer.alloc(5);
            reqDb.writeUInt32LE(1, 0);
            reqDb.writeUInt8(MessageType.RequestDebugDatabase, 4);

            unreal.write(reqDb);
        }, 1000);
    });
}

// ─── Queue state ────────────────────────────────────────────────

let ParseQueue : Array<scriptfiles.ASModule> = [];
let ParseQueueIndex = 0;
let LoadQueue : Array<scriptfiles.ASModule> = [];
let LoadQueueIndex = 0;
let PostProcessTypesQueue : Array<scriptfiles.ASModule> = [];
let PostProcessTypesQueueIndex = 0;
let ResolveQueue : Array<scriptfiles.ASModule> = [];
let ResolveQueueIndex = 0;
let IsServicingQueues = false;

let settings : any = null;

// Create a simple text document manager. The text document manager
// supports full document sync only
// Make the text document manager listen on the connection
// for open, change and close text document events

let shouldSendDiagnosticRelatedInformation: boolean = false;
let RootUris : string[] = [];

// After the server has started the client sends an initialize request. The server receives
// in the passed params the rootPath of the workspace plus the client capabilities.
connection.onInitialize((_params): InitializeResult => {
    shouldSendDiagnosticRelatedInformation = _params.capabilities && _params.capabilities.textDocument && _params.capabilities.textDocument.publishDiagnostics && _params.capabilities.textDocument.publishDiagnostics.relatedInformation;

    let Roots = [];

    if (_params.workspaceFolders == null) {
        if (_params.rootPath != null) Roots.push(_params.rootPath);
        if (_params.rootUri != null) RootUris.push(decodeURIComponent(_params.rootUri));
    } else {
        for (let Workspace of _params.workspaceFolders) {
            Roots.push(URI.parse(Workspace.uri).fsPath);
            RootUris.push(decodeURIComponent(Workspace.uri));
        }
    }


    connection.console.log("Workspace roots: " + Roots);

    // Initially read and parse all angelscript files in the workspace
    let GlobsRemaining = Roots.length;
    for (let RootPath of Roots)
    {
        let globOptions: glob.IOptions = {
            ignore: settings?.scriptIgnorePatterns || []
        };
        glob(RootPath + "/**/*.as", globOptions, function (err: any, files: any)
        {
            for (let file of files)
            {
                let uri = getFileUri(file);
                let asmodule = scriptfiles.GetOrCreateModule(getModuleName(uri), file, uri);
                LoadQueue.push(asmodule);
            }

            GlobsRemaining -= 1;
            if (GlobsRemaining <= 0)
                TickQueues();
        });

        // Read templates
        glob(RootPath+"/.vscode/templates/*.as.template", null, function(err : any, files : any)
        {
            scriptlenses.LoadFileTemplates(files);
        });
    }

    // ─── Hybrid type loading ─────────────────────────────────
    // 1. Start async TCP connection to UE Editor
    connect_unreal();

    // 2. Load as.predefined as baseline (adds types to DB but does NOT mark them ready)
    loadPredefinedTypes(Roots);

    // 3. Set 5-second timeout: if TCP hasn't delivered types by then, fallback to predefined
    setTimeout(() => {
        if (!typedb.HasTypesFromUnreal())
        {
            tcpTimedOut = true;
            connection.console.log("TCP connection timed out (5s). Using as.predefined types as fallback.");
            typedb.AddPrimitiveTypes(false);
            typedb.FinishTypesFromUnreal();
        }
    }, 5000);

    return {
        capabilities: {
            // Tell the client that the server works in FULL text document sync mode
            textDocumentSync: {
                openClose: true,
                change: TextDocumentSyncKind.Incremental,
            },
            // Tell the client that the server support code complete
            completionProvider: {
                resolveProvider: true,
                triggerCharacters: [".", ":"],
            },
            signatureHelpProvider: {
                triggerCharacters: ["(", ")", ","],
                retriggerCharacters: ["="],
            },
            hoverProvider: true,
            documentSymbolProvider: true,
            workspaceSymbolProvider: { "resolveProvider": true },
            definitionProvider: true,
            referencesProvider: true,
            documentHighlightProvider: true,
            inlayHintProvider: true,
            inlineValueProvider: true,
            renameProvider: {
                prepareProvider: true
            },
            codeLensProvider: {
                resolveProvider: false
            },
            codeActionProvider: {
                resolveProvider: true,
            },
            semanticTokensProvider: {
                legend: {
                    tokenTypes: scriptsemantics.SemanticTypeList.map(t => "as_"+t),
                    tokenModifiers: [],
                },
                range: false,
                full: {
                    delta: true,
                },
            },
            colorProvider : <DocumentColorRegistrationOptions> {
                documentSelector: null,
            },
            typeHierarchyProvider: true,
        }
    }
});

function loadPredefinedTypes(Roots: string[]): void
{
    // Filter out undefined/null entries (can happen if client doesn't send rootPath)
    const validRoots = (Roots || []).filter(r => r != null && r !== "undefined");
    if (validRoots.length === 0) {
        connection.console.log("Warning: No valid workspace roots. Skipping as.predefined load.");
        return;
    }

    // Try to find as.predefined relative to the workspace roots
    for (let root of validRoots)
    {
        // Try in tools/as-lsp/ (project structure) or at root
        let candidates = [
            root + "/tools/as-lsp/as.predefined",
            root + "/as.predefined",
        ];
        // Also try parent directories
        let parentDir = root.replace(/\\/g, "/");
        let lastSep = parentDir.lastIndexOf("/");
        if (lastSep > 0) {
            parentDir = parentDir.substring(0, lastSep);
            candidates.push(parentDir + "/tools/as-lsp/as.predefined");
            candidates.push(parentDir + "/as.predefined");
        }

        for (let candidate of candidates)
        {
            if (fs.existsSync(candidate))
            {
                connection.console.log("Loading predefined types from: " + candidate);
                predefined.LoadPredefinedTypes(candidate);
                // Note: Does NOT call FinishTypesFromUnreal — handled centrally
                return;
            }
        }
    }
    connection.console.log("Warning: Could not find as.predefined file. Types will be limited.");
    // FinishTypesFromUnreal will be called by TCP timeout if TCP also fails
}

function TickQueues()
{
    IsServicingQueues = true;

    if (LoadQueueIndex < LoadQueue.length)
    {
        for (let n = 0; n < 200 && LoadQueueIndex < LoadQueue.length; ++n, ++LoadQueueIndex)
        {
            if (!LoadQueue[LoadQueueIndex].loaded)
                scriptfiles.UpdateModuleFromDisk(LoadQueue[LoadQueueIndex]);
            ParseQueue.push(LoadQueue[LoadQueueIndex]);
        }
    }
    else if (LoadQueue.length != 0)
    {
        LoadQueue = [];
        LoadQueueIndex = 0;
    }
    else if (ParseQueueIndex < ParseQueue.length)
    {
        for (let n = 0; n < 10 && ParseQueueIndex < ParseQueue.length; ++n, ++ParseQueueIndex)
        {
            if (!ParseQueue[ParseQueueIndex].parsed)
                scriptfiles.ParseModule(ParseQueue[ParseQueueIndex]);
            PostProcessTypesQueue.push(ParseQueue[ParseQueueIndex]);
        }
    }
    else if (ParseQueue.length != 0)
    {
        ParseQueue = [];
        ParseQueueIndex = 0;
        scriptfiles.SetInitialParseDone();
    }
    else if (PostProcessTypesQueueIndex < PostProcessTypesQueue.length)
    {
        if (CanResolveModules())
        {
            for (let n = 0; n < 50 && PostProcessTypesQueueIndex < PostProcessTypesQueue.length; ++n, ++PostProcessTypesQueueIndex)
            {
                if (!PostProcessTypesQueue[PostProcessTypesQueueIndex].typesPostProcessed)
                    scriptfiles.PostProcessModuleTypes(PostProcessTypesQueue[PostProcessTypesQueueIndex]);
                ResolveQueue.push(PostProcessTypesQueue[PostProcessTypesQueueIndex]);
            }
        }
    }
    else if (PostProcessTypesQueue.length != 0)
    {
        PostProcessTypesQueue = [];
        PostProcessTypesQueueIndex = 0;
    }
    else if (ResolveQueueIndex < ResolveQueue.length)
    {
        if (CanResolveModules())
        {
            for (let n = 0; n < 20 && ResolveQueueIndex < ResolveQueue.length; ++n, ++ResolveQueueIndex)
            {
                if (!ResolveQueue[ResolveQueueIndex].resolved)
                {
                    scriptfiles.ResolveModule(ResolveQueue[ResolveQueueIndex]);
                    scriptdiagnostics.UpdateScriptModuleDiagnostics(ResolveQueue[ResolveQueueIndex], true);
                }
            }
        }
    }
    else if (ResolveQueue.length != 0)
    {
        ResolveQueue = [];
        ResolveQueueIndex = 0;
    }

    if (LoadQueue.length != 0 || ParseQueue.length != 0 || PostProcessTypesQueue.length != 0 || ResolveQueue.length != 0)
    {
        setTimeout(TickQueues, 1);
    }
    else
    {
        IsServicingQueues = false;
    }
}

function DirtyAllDiagnostics()
{
    if (IsServicingQueues)
        return;

    // Update diagnostics on all modules
    let moduleIndex = 0;
    let moduleList = scriptfiles.GetAllLoadedModules();
    let timerHandle = setInterval(UpdateDiagnostics, 1);

    function UpdateDiagnostics()
    {
        for (let i = 0; i < 20; ++i)
        {
            if (moduleIndex >= moduleList.length)
            {
                clearInterval(timerHandle);
                return;
            }

            let module = moduleList[moduleIndex];
            if (module && module.resolved)
                scriptdiagnostics.UpdateScriptModuleDiagnostics(module);
            moduleIndex += 1;
        }
    }
}

function ReResolveAllModules()
{
    if (IsServicingQueues)
        return;

    scriptfiles.ClearAllResolvedModules();

    // Update diagnostics on all modules
    let moduleIndex = 0;
    let moduleList = scriptfiles.GetAllLoadedModules();
    let timerHandle = setInterval(ReResolveModules, 1);

    function ReResolveModules()
    {
        for (let i = 0; i < 20; ++i)
        {
            if (moduleIndex >= moduleList.length)
            {
                clearInterval(timerHandle);
                return;
            }

            let module = moduleList[moduleIndex];
            if (module && !module.resolved)
            {
                scriptfiles.ResolveModule(module);
                scriptdiagnostics.UpdateScriptModuleDiagnostics(module);
            }
            moduleIndex += 1;
        }
    }
}

function CanResolveModules()
{
    return typedb.HasTypesFromUnreal() && LoadQueue.length == 0;
}

function IsInitialParseDone()
{
    return CanResolveModules() && ParseQueue.length == 0 && LoadQueue.length == 0;
}

scriptdiagnostics.OnDiagnosticsChanged( function (uri : string, diagnostics : Array<Diagnostic>){
    connection.sendDiagnostics({ "uri": uri, "diagnostics": diagnostics });
});

connection.onDidChangeWatchedFiles((_change) => {
    for(let change of _change.changes)
    {
        let module = scriptfiles.GetOrCreateModule(getModuleName(change.uri), getPathName(change.uri), change.uri);
        if (module)
        {
            if (!module.isOpened)
                scriptfiles.UpdateModuleFromDisk(module);
            scriptfiles.ParseModule(module);

            if (CanResolveModules() && ParseQueue.length == 0 && LoadQueue.length == 0)
            {
                scriptfiles.PostProcessModuleTypes(module);
                scriptfiles.ResolveModule(module);

                let alwaysSendDiagnostics = false;
                if (change.type == FileChangeType.Deleted)
                    alwaysSendDiagnostics = true;
                if (change.type == FileChangeType.Created)
                    alwaysSendDiagnostics = true;

                scriptdiagnostics.UpdateScriptModuleDiagnostics(module, false, alwaysSendDiagnostics);
            }
        }
    }
});

function GetAndParseModule(uri : string) : scriptfiles.ASModule
{
    let asmodule = scriptfiles.GetModuleByUri(uri);
    if (!asmodule)
        return null;

    scriptfiles.ParseModuleAndDependencies(asmodule);
    if (CanResolveModules())
    {
        scriptfiles.PostProcessModuleTypesAndDependencies(asmodule);
        scriptfiles.ResolveModule(asmodule);
    }
    return asmodule;
}

connection.onCompletion((_textDocumentPosition: TextDocumentPositionParams): CompletionItem[] => {
    let asmodule = GetAndParseModule(_textDocumentPosition.textDocument.uri);
    if (!asmodule)
        return null;
    let completions = parsedcompletion.Complete(asmodule, _textDocumentPosition.position);
    return completions;
});

connection.onCompletionResolve((item: CompletionItem): CompletionItem => {
    let resolvedItem = parsedcompletion.Resolve(item);
    if (resolvedItem)
        return resolvedItem;
    else
        return item;
});

connection.onSignatureHelp((_textDocumentPosition: TextDocumentPositionParams): SignatureHelp => {
    let asmodule = GetAndParseModule(_textDocumentPosition.textDocument.uri);
    if (!asmodule)
        return null;
    let help = parsedcompletion.Signature(asmodule, _textDocumentPosition.position);
    return help;
});

connection.onDefinition((_textDocumentPosition: TextDocumentPositionParams): Definition | null => {
    let asmodule = GetAndParseModule(_textDocumentPosition.textDocument.uri);
    if (!asmodule)
        return null;
    if (!asmodule.resolved)
        return null;
    let definitions = scriptsymbols.GetDefinition(asmodule, _textDocumentPosition.position);
    if (definitions && definitions.length == 1)
        return definitions[0];
    return definitions;
});

connection.onImplementation((_textDocumentPosition: TextDocumentPositionParams): Definition | null => {
    let asmodule = GetAndParseModule(_textDocumentPosition.textDocument.uri);
    if (!asmodule)
        return null;
    if (!asmodule.resolved)
        return null;
    let definitions = scriptsymbols.GetDefinition(asmodule, _textDocumentPosition.position);
    if (definitions && definitions.length != 0)
    {
        if (definitions.length == 1)
            return definitions[0];
        return definitions;
    }

    return null;
});

connection.onHover((_textDocumentPosition: TextDocumentPositionParams): Hover => {
    let asmodule = GetAndParseModule(_textDocumentPosition.textDocument.uri);
    if (!asmodule)
        return null;
    if (!asmodule.resolved)
        return null;
    return scriptsymbols.GetHover(asmodule, _textDocumentPosition.position);
});

connection.onDocumentSymbol((_params : DocumentSymbolParams) : DocumentSymbol[] => {
    let asmodule = GetAndParseModule(_params.textDocument.uri);
    if (!asmodule)
        return null;
    return scriptsymbols.DocumentSymbols(asmodule);
});

connection.onWorkspaceSymbol((_params : WorkspaceSymbolParams) : WorkspaceSymbol[] => {
    return scriptsymbols.WorkspaceSymbols(_params.query);
});

connection.onWorkspaceSymbolResolve((symbol : WorkspaceSymbol) : WorkspaceSymbol => {
    return scriptsymbols.ResolveWorkspaceSymbol(symbol);
});

connection.onReferences(function (params : ReferenceParams) : Location[] | Thenable<Location[]>
{
    if (!CanResolveModules())
        return null;
    if (LoadQueue.length != 0)
        return null;

    let generator = scriptreferences.FindReferences(params.textDocument.uri, params.position);
    let result = generator.next();
    if (result && result.value)
        return result.value;

    return new Promise((resolve, reject) => {
        let timerHandle = setInterval(MakeProgress, 1);
        function MakeProgress()
        {
            let result = generator.next();
            if (result && result.value)
            {
                clearInterval(timerHandle);
                resolve(result.value);
            }
        }
    });
});

connection.onPrepareRename(function (params : PrepareRenameParams) : Range | ResponseError<void>
{
    if (!CanResolveModules())
        return null;
    if (LoadQueue.length != 0)
        return null;

    let result : Range | ResponseError<void> = null;
    if (!CanResolveModules())
        result = new ResponseError<void>(0, "Please wait for all script parsing to finish...");
    else
        result = scriptreferences.PrepareRename(params.textDocument.uri, params.position);

    return result;
});

connection.onRenameRequest(function (params : RenameParams) : WorkspaceEdit | Thenable<WorkspaceEdit>
{
    if (!CanResolveModules())
        return null;
    if (LoadQueue.length != 0)
        return null;

    let generator = scriptreferences.PerformRename(params.textDocument.uri, params.position, params.newName);
    return new Promise((resolve, reject) => {
        let timerHandle = setInterval(MakeProgress, 1);
        function MakeProgress()
        {
            let result = generator.next();
            if (result && result.value)
            {
                clearInterval(timerHandle);

                let workspaceEdit : WorkspaceEdit = {};
                workspaceEdit.changes = {};
                for (let [uri, edits] of result.value)
                    workspaceEdit.changes[uri] = edits;
                resolve(workspaceEdit);
            }
        }
    });
});

connection.onDocumentHighlight(function (params : DocumentHighlightParams) : Array<DocumentHighlight>
{
    if (!CanResolveModules())
        return null
    return scriptoccurances.HighlightOccurances(params.textDocument.uri, params.position);
})

connection.onCodeLens(function (params : CodeLensParams) : CodeLens[]
{
    if (!CanResolveModules())
        return null;
    let asmodule = scriptfiles.GetModuleByUri(params.textDocument.uri);
    if (!asmodule)
        return null;

    scriptfiles.ParseModuleAndDependencies(asmodule);
    scriptfiles.PostProcessModuleTypesAndDependencies(asmodule);
    scriptfiles.ResolveModule(asmodule);
    return scriptlenses.ComputeCodeLenses(asmodule);
})

connection.onCodeLensResolve(function (lens : CodeLens) : CodeLens{
    return lens;
});

connection.onExecuteCommand(function (params : ExecuteCommandParams)
{
    // No UE-dependent commands in standalone mode (blueprint creation, open assets etc.)
});

connection.onCodeAction(function (params : CodeActionParams) : Array<CodeAction>
{
    let asmodule = GetAndParseModule(params.textDocument.uri);
    if (!asmodule)
        return null;
    if (!asmodule.resolved)
        return null;

    return scriptactions.GetCodeActions(asmodule, params.range, params.context.diagnostics);
});

connection.onCodeActionResolve(function (action : CodeAction) : CodeAction
{
    let data = action.data as any;
    if (!data || !data.uri)
        return action;
    let asmodule = GetAndParseModule(data.uri);
    if (!asmodule)
        return action;
    if (!asmodule.resolved)
        return action;

    return scriptactions.ResolveCodeAction(asmodule, action, data);
});

function TryResolveSymbols(asmodule : scriptfiles.ASModule) : SemanticTokens | null
{
    if (CanResolveModules())
    {
        if (!asmodule)
            return null;
        scriptfiles.ParseModuleAndDependencies(asmodule);
        scriptfiles.PostProcessModuleTypesAndDependencies(asmodule);
        scriptfiles.ResolveModule(asmodule);
        return scriptsemantics.HighlightSymbols(asmodule);
    }
    else
    {
        return null;
    }
}

function WaitForResolveSymbols(params : SemanticTokensParams) : SemanticTokens | Thenable<SemanticTokens>
{
    let asmodule = scriptfiles.GetModuleByUri(params.textDocument.uri);
    let result = TryResolveSymbols(asmodule);
    if (result)
        return result;

    function timerFunc(resolve : any, reject : any, triesLeft : number) {
        let result = TryResolveSymbols(asmodule);
        if (result)
            return resolve(result);
        setTimeout(function() { timerFunc(resolve, reject, triesLeft-1); }, 100);
    }
    let promise = new Promise<SemanticTokens>(function(resolve, reject)
    {
        timerFunc(resolve, reject, 50);
    });
    return promise;
};

connection.languages.semanticTokens.onDelta(function (params : SemanticTokensDeltaParams) : SemanticTokensDelta | Thenable<SemanticTokensDelta> | SemanticTokens | Thenable<SemanticTokens>
{
    if (!CanResolveModules())
        return WaitForResolveSymbols(params);

    let asmodule = scriptfiles.GetModuleByUri(params.textDocument.uri);
    scriptfiles.ParseModuleAndDependencies(asmodule);
    scriptfiles.PostProcessModuleTypesAndDependencies(asmodule);
    scriptfiles.ResolveModule(asmodule);
    let delta = scriptsemantics.HighlightSymbolsDelta(asmodule, params.previousResultId);
    return delta;
});

connection.languages.semanticTokens.on(function(params : SemanticTokensParams) : SemanticTokens | Thenable<SemanticTokens>
{
    return WaitForResolveSymbols(params);
});

function getPathName(uri : string) : string
{
    let pathname = decodeURIComponent(uri.replace("file://", "")).replace(/\//g, "\\");
    if(pathname.startsWith("\\"))
        pathname = pathname.substr(1);

    return pathname;
}

function getFileUri(pathname : string) : string
{
    let uri = pathname.replace(/\\/g, "/");
    if(!uri.startsWith("/"))
        uri = "/" + uri;

    return ("file://" + uri);
}

function getModuleName(uri : string) : string
{
    let modulename = decodeURIComponent(uri);

    // This assumes all relative paths are globally unique.
    for (let rootUri of RootUris) {
        if (modulename.startsWith(rootUri)) {
            modulename = modulename.replace(rootUri, "");
            break;
        }
    }
    modulename = modulename.replace(".as", "");
    modulename = modulename.replace(/\//g, ".");

    if (modulename[0] == '.')
        modulename = modulename.substr(1);

    return modulename;
}

connection.onRequest("angelscript/getModuleForSymbol", (...params: any[]) : string => {
    let pos : TextDocumentPositionParams = params[0];
    let asmodule = GetAndParseModule(pos.textDocument.uri);
    if (!asmodule)
        return null;
    if (!asmodule.resolved)
        return null;

    // When automatic imports are on we never return the symbol at all
    if (scriptfiles.GetScriptSettings().automaticImports)
        return "-";

    // See if we can find an unimported symbol on this line first
    let unimportedSymbol = scriptsymbols.FindUnimportedSymbolOnLine(asmodule, pos.position);
    if (unimportedSymbol)
    {
        let symbolDefs = scriptsymbols.GetSymbolDefinition(asmodule, unimportedSymbol);
        if (symbolDefs)
        {
            for (let def of symbolDefs)
            {
                if (def.module.modulename == asmodule.modulename)
                    continue;
                return def.module.modulename;
            }
        }
    }

    // Fall back to grabbing it by definition
    let definitions = scriptsymbols.GetDefinition(asmodule, pos.position);
    if (definitions == null)
    {
        connection.console.log(`Definition not found`);
        return "";
    }
    {
        let defArray = definitions as Location[];
        let moduleName = getModuleName(defArray[0].uri);

        // Don't add an import to the module we're in
        if (moduleName == asmodule.modulename)
            return "-";
        return moduleName;
    }
});

connection.onRequest("angelscript/getAPI", (root : string) : any => {
    return api_docs.GetAPIList(root);
});

connection.onRequest("angelscript/getAPISearch", (filter : string) : any => {
    return api_docs.GetAPISearch(filter);
});

connection.onRequest("angelscript/getAPIDetails", (root : any) : any => {
    return api_docs.GetAPIDetails(root);
});

connection.languages.inlineValue.on(function (params : InlineValueParams) : Array<InlineValue> {
    let asmodule = GetAndParseModule(params.textDocument.uri);
    if (!asmodule)
        return null;
    if (!asmodule.resolved)
        return null;
    return inlinevalues.ProvideInlineValues(asmodule, params.context.stoppedLocation.start);
});

function TriggerThrottledModuleParse(asmodule : scriptfiles.ASModule)
{
    if (!asmodule.parseDelay)
    {
        // We don't parse because of didChange more than ten times per second,
        // so we don't end up with a giant backlog of parses.
        scriptfiles.ParseModuleAndDependencies(asmodule);
        if (CanResolveModules() && ParseQueue.length == 0 && LoadQueue.length == 0)
        {
            scriptfiles.PostProcessModuleTypesAndDependencies(asmodule);
            scriptfiles.ResolveModule(asmodule);
            scriptdiagnostics.UpdateScriptModuleDiagnostics(asmodule);
        }

        asmodule.parseDelay = setTimeout(function() {
            asmodule.parseDelay = null;

            if (asmodule.parseAfterDelay)
            {
                asmodule.parseAfterDelay = false;
                TriggerThrottledModuleParse(asmodule);
            }
        }, 100);
    }
    else
    {
        asmodule.parseAfterDelay = true;
    }
}

connection.onDidChangeTextDocument((params) => {
    // The content of a text document did change in VSCode.
    // params.uri uniquely identifies the document.
    // params.contentChanges describe the content changes to the document.
    if (params.contentChanges.length == 0)
        return;

    let uri = params.textDocument.uri;
    let modulename = getModuleName(uri);

    let asmodule = scriptfiles.GetOrCreateModule(modulename, getPathName(uri), uri);
    if (!asmodule.loaded)
        scriptfiles.UpdateModuleFromDisk(asmodule);
    scriptfiles.UpdateModuleFromContentChanges(asmodule, params.contentChanges);
    TriggerThrottledModuleParse(asmodule);

    if (asmodule.lastEditStart != -1 && parsedcompletion.GetCompletionSettings().correctFloatLiteralsWhenExpectingDoublePrecision)
    {
        let floatPromise = parsedcompletion.HandleFloatLiteralHelper(asmodule);
        if (floatPromise)
        {
            floatPromise.then(
                function (edit : WorkspaceEdit)
                {
                    if (edit)
                        connection.workspace.applyEdit(edit);
                });
        }
    }
});

connection.onDidOpenTextDocument(function (params : DidOpenTextDocumentParams)
{
    let uri = params.textDocument.uri;
    let modulename = getModuleName(uri);

    let asmodule = scriptfiles.GetOrCreateModule(modulename, getPathName(uri), uri);
    asmodule.isOpened = true;
    scriptfiles.UpdateModuleFromContent(asmodule, params.textDocument.text);
    scriptfiles.ParseModuleAndDependencies(asmodule);
    if (CanResolveModules() && ParseQueue.length == 0 && LoadQueue.length == 0)
    {
        scriptfiles.PostProcessModuleTypesAndDependencies(asmodule);
        scriptfiles.ResolveModule(asmodule);
        scriptdiagnostics.UpdateScriptModuleDiagnostics(asmodule);
    }
});

connection.onDidCloseTextDocument(function (params : DidCloseTextDocumentParams)
{
    let asmodule = scriptfiles.GetModuleByUri(params.textDocument.uri);
    if (asmodule)
        asmodule.isOpened = false;
});

connection.onDidChangeConfiguration(function (change : DidChangeConfigurationParams)
{
    let settingsObject = change.settings as any;
    settings = settingsObject.UnrealAngelscript;
    if (!settings)
        return;

    let diagnosticSettings = scriptdiagnostics.GetDiagnosticSettings();
    let dirtyDiagnostics = false;

    if (diagnosticSettings.namingConventionDiagnostics != settings.diagnosticsForUnrealNamingConvention)
    {
        diagnosticSettings.namingConventionDiagnostics = settings.diagnosticsForUnrealNamingConvention;
        dirtyDiagnostics = true;
    }

    if (diagnosticSettings.markUnreadVariablesAsUnused != settings.markUnreadVariablesAsUnused)
    {
        diagnosticSettings.markUnreadVariablesAsUnused = settings.markUnreadVariablesAsUnused;
        dirtyDiagnostics = true;
    }

    if (dirtyDiagnostics)
        DirtyAllDiagnostics();

    // If the port has changed, reconnect
    if (port != settings.unrealConnectionPort)
    {
        port = settings.unrealConnectionPort;
        connect_unreal();
    }

    let completionSettings = parsedcompletion.GetCompletionSettings();
    completionSettings.mathCompletionShortcuts = settings.mathCompletionShortcuts;
    completionSettings.dependencyRestrictions = settings.completion.dependencyRestrictions;
    completionSettings.correctFloatLiteralsWhenExpectingDoublePrecision = settings.correctFloatLiteralsWhenExpectingDoublePrecision;
    parsedcompletion.RefreshDependencyRestrictions();

    let inlayHintSettings = inlayhints.GetInlayHintSettings();
    inlayHintSettings.inlayHintsEnabled = settings.inlayHints.inlayHintsEnabled;
    inlayHintSettings.parameterHintsForConstants = settings.inlayHints.parameterHintsForConstants;
    inlayHintSettings.parameterHintsForComplexExpressions = settings.inlayHints.parameterHintsForComplexExpressions;
    inlayHintSettings.parameterReferenceHints = settings.inlayHints.parameterReferenceHints;
    inlayHintSettings.parameterHintsForSingleParameterFunctions = settings.inlayHints.parameterHintsForSingleParameterFunctions;
    inlayHintSettings.typeHintsForAutos = settings.inlayHints.typeHintsForAutos;
    inlayHintSettings.typeHintsIgnoredTypes = new Set<string>(settings.inlayHints.typeHintsForAutoIgnoredTypes as Array<string>);
    inlayHintSettings.parameterHintsIgnoredParameterNames = new Set<string>(settings.inlayHints.parameterHintsIgnoredParameterNames as Array<string>);
    inlayHintSettings.parameterHintsIgnoredFunctionNames = new Set<string>(settings.inlayHints.parameterHintsIgnoredFunctionNames as Array<string>);

    let inlineValueSettings = inlinevalues.GetInlineValueSettings();
    inlineValueSettings.showInlineValueForFunctionThisObject = settings.inlineValues.showInlineValueForFunctionThisObject;
    inlineValueSettings.showInlineValueForLocalVariables = settings.inlineValues.showInlineValueForLocalVariables;
    inlineValueSettings.showInlineValueForParameters = settings.inlineValues.showInlineValueForParameters;
    inlineValueSettings.showInlineValueForMemberAssignment = settings.inlineValues.showInlineValueForMemberAssignment;

    let codeLensSettings = scriptlenses.GetCodeLensSettings();
    codeLensSettings.showCreateBlueprintClasses = settings.codeLenses.showCreateBlueprintClasses;

    let projectCodeGenerationSettings = generatedcode.GetProjectCodeGenerationSettings();
    projectCodeGenerationSettings.enable = settings.projectCodeGeneration.enable;
    projectCodeGenerationSettings.generators = settings.projectCodeGeneration.generators;
});

function TryResolveInlayHints(asmodule : scriptfiles.ASModule, range : Range) : Array<InlayHint> | null
{
    if (CanResolveModules())
    {
        if (!asmodule)
            return null;
        scriptfiles.ParseModuleAndDependencies(asmodule);
        scriptfiles.PostProcessModuleTypesAndDependencies(asmodule);
        scriptfiles.ResolveModule(asmodule);
        return inlayhints.GetInlayHintsForRange(asmodule, range);
    }
    else
    {
        return null;
    }
}

function WaitForInlayHints(uri : string, range : Range) : Array<InlayHint> | Thenable<Array<InlayHint>>
{
    let asmodule = scriptfiles.GetModuleByUri(uri);
    let result = TryResolveInlayHints(asmodule, range);
    if (result)
        return result;

    function timerFunc(resolve : any, reject : any, triesLeft : number) {
        let result = TryResolveInlayHints(asmodule, range);
        if (result)
            return resolve(result);
        setTimeout(function() { timerFunc(resolve, reject, triesLeft-1); }, 100);
    }
    let promise = new Promise<Array<InlayHint>>(function(resolve, reject)
    {
        timerFunc(resolve, reject, 50);
    });
    return promise;
};

connection.languages.inlayHint.on(function (params : InlayHintParams) : Array<InlayHint> | Thenable<Array<InlayHint>>
{
    let uri : string = params.textDocument.uri;
    return WaitForInlayHints(uri, params.range);
});

connection.onDocumentColor(function (params : DocumentColorParams) : ColorInformation[]
{
    let asmodule = GetAndParseModule(params.textDocument.uri);
    if (!asmodule)
        return null;
    if (!asmodule.resolved)
        return null;

    return colorpicker.ProvideDocumentColors(asmodule);
});

connection.onColorPresentation(function(params : ColorPresentationParams) : ColorPresentation[]
{
    let asmodule = GetAndParseModule(params.textDocument.uri);
    if (!asmodule)
        return null;
    if (!asmodule.resolved)
        return null;

    return colorpicker.ProvideColorPresentations(asmodule, params.range, params.color);
});

connection.languages.typeHierarchy.onPrepare(function (params : TypeHierarchyPrepareParams) : TypeHierarchyItem[]
{
    let asmodule = GetAndParseModule(params.textDocument.uri);
    if (!asmodule)
        return null;
    if (!asmodule.resolved)
        return null;

    return typehierarchy.PrepareTypeHierarchy(asmodule, params.position);
});

connection.languages.typeHierarchy.onSupertypes(function (params : TypeHierarchySupertypesParams) : TypeHierarchyItem[]
{
    return typehierarchy.GetTypeHierarchySupertypes(params.item);
});

connection.languages.typeHierarchy.onSubtypes(function (params : TypeHierarchySubtypesParams) : TypeHierarchyItem[]
{
    return typehierarchy.GetTypeHierarchySubtypes(params.item);
});

// Listen on the connection
connection.listen();
