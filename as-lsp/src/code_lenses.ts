import * as scriptfiles from './as_parser';
import * as typedb from './database';
import * as fs from 'fs';
import * as path from 'path';

import { Range, Position, Location, CodeLens, InitializedNotification, Command } from "vscode-languageserver";

class ASFileTemplate
{
    name : string;
    content : string;
    order : number = 0;
}

let FileTemplates = new Array<ASFileTemplate>();
let FileTemplateNames = new Set<string>();

export interface CodeLensSettings
{
    engineSupportsCreateBlueprint : boolean;
    showCreateBlueprintClasses : Array<string>;
};

let CodeLensSettings : CodeLensSettings = {
    engineSupportsCreateBlueprint : false,
    showCreateBlueprintClasses : [],
};

export function GetCodeLensSettings() : CodeLensSettings
{
    return CodeLensSettings;
}

export function LoadFileTemplates(filenames : Array<string>)
{
    for (let file of filenames)
    {
        try
        {
            let content = fs.readFileSync(file, 'utf8');

            let basename = path.basename(file, ".as.template");

            let template = new ASFileTemplate();
            template.content = content;
            template.name = basename.replace("_", " ");

            let match = template.name.match(/^([0-9]+)\.(.*)/);
            if (match)
            {
                template.name = match[2];
                template.order = parseInt(match[1]);
            }

            if (!FileTemplateNames.has(template.name.toLowerCase()))
            {
                FileTemplateNames.add(template.name.toLowerCase());
                FileTemplates.push(template);
            }
        }
        catch (readError)
        {
            continue;
        }
    }

    // Add default templates for actor and component if they don't already exist
    if (!FileTemplateNames.has("actor"))
    {
        let template = new ASFileTemplate();
        template.content =
`class A\${TM_FILENAME_BASE} : AActor
{
	UPROPERTY(DefaultComponent, RootComponent)
	USceneComponent Root;$0

	UFUNCTION(BlueprintOverride)
	void BeginPlay()
	{
	}
};`;
        template.name = "Actor";
        FileTemplates.push(template);
        FileTemplateNames.add("actor");
    }

    if (!FileTemplateNames.has("component"))
    {
        let template = new ASFileTemplate();
        template.content =
`class U\${TM_FILENAME_BASE} : UActorComponent
{$0
	UFUNCTION(BlueprintOverride)
	void BeginPlay()
	{
	}
};`;
        template.name = "Component";
        FileTemplates.push(template);
        FileTemplateNames.add("component");
    }

    FileTemplates.sort(
        function(a : ASFileTemplate, b : ASFileTemplate) : number {
            if (a.order < b.order)
                return -1;
            else if (a.order > b.order)
                return 1;
            else
                return 0;
        }
    );
}

export function ComputeCodeLenses(asmodule : scriptfiles.ASModule) : Array<CodeLens>
{
    let lenses = new Array<CodeLens>();

    // If the file is empty, add lenses for activating templates
    if (asmodule.rootscope.next == null && FileTemplates.length != 0 && asmodule.content.match(/^[\s\r\n]*$/))
    {
        for (let template of FileTemplates)
        {
            if (template.content.length == 0)
                continue;

            lenses.push(<CodeLens> {
                range: Range.create(Position.create(0, 0), Position.create(0, 10000)),
                command: <Command> {
                    title: "Create "+template.name,
                    command: "editor.action.insertSnippet",
                    arguments: [{
                        "snippet": template.content
                    }],
                }
            });
        }
    }

    return lenses;
}

export function AllowCreateBlueprintForClass(dbtype : typedb.DBType) : boolean
{
    return false;
}
