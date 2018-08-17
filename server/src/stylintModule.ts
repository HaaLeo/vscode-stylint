/* --------------------------------------------------------------------------------------------
 * Copyright (c) Leo Hanisch. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */

'use strict';

import { execSync } from 'child_process';

import { IConnection } from 'vscode-languageserver';

class StylintModule {
    private _stylintWrapperPath: string
    private _stylintrcPath: string
    private _jsonReporterPath: string
    private _stylintExecPath: string // Path to the index.js

    public get stylintExecPath(): string {
        return this._stylintExecPath;
    }

    public set stylintExecPath(stylintExecPath: string) {
        this._stylintExecPath = stylintExecPath;
    }

    public set stylintrcPath(stylintrcPath: string) {
        this._stylintrcPath = stylintrcPath;
    }


    public get stylintrcPath(): string {
        return this._stylintrcPath;
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

    public validate(pathToFiles: string, connection: IConnection) {
        let command: string;
        const args = '"' + this.stylintWrapperPath + '" "' + this.stylintExecPath + '" "' + pathToFiles + '" "' + this.stylintrcPath + '" "' + this.jsonReporterPath + '"';

        command = 'node ' + args

        try {
            const buffer = execSync(command);
            return JSON.parse(buffer.toString());
        } catch (err) {
            connection.console.error('Linting failed! Ensure all rules of the ' + this.stylintrcPath + ' are configured as warnings!');
        }
    }
}

export { StylintModule };
