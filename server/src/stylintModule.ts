/* --------------------------------------------------------------------------------------------
 * Copyright (c) Leo Hanisch. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */

'use strict';

import { execSync } from 'child_process';
import * as path from 'path';

class StylintModule {
    private _stylintWrapperPath: string
    private _jsonReporterPath: string
    private _stylintExecPath: string // Path to the index.js

    public get stylintExecPath(): string {
        return this._stylintExecPath;
    }

    public set stylintExecPath(stylintExecPath: string) {
        this._stylintExecPath = stylintExecPath;
    }

    public get stylintWrapperPath(): string {
        return this._stylintWrapperPath;
    }

    public set stylintWrapperPath(stylintWrapperPath: string) {
        this._stylintWrapperPath = stylintWrapperPath;
    }

    public get jsonReporterPath(): string {
        return this._jsonReporterPath;
    }

    public set jsonReporterPath(jsonReporterPath: string) {
        this._jsonReporterPath = jsonReporterPath;
    }

    public validate(pathToFiles: string, pathToConfig: string, nodePath?: string) {
        let command: string;
        const args = '"' + this.stylintWrapperPath + '" "' + this.stylintExecPath + '" "' + pathToFiles + '" "' + pathToConfig + '" "' + this.jsonReporterPath + '"';
        if (nodePath) {
            command = '"' + path.join(nodePath, 'node') + '"' + ' ' + args
        } else {
            command = 'node ' + args
        }
        const buffer = execSync(command);
        return JSON.parse(buffer.toString());
    }
}

export { StylintModule };
