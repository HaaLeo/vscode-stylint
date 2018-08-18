/* --------------------------------------------------------------------------------------------
 * Copyright (c) Leo Hanisch. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */

'use strict';

const exec = require('sb-exec');
import fs = require('fs');

class StylintModule {
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

    public get jsonReporterPath(): string {
        return this._jsonReporterPath;
    }

    public set jsonReporterPath(jsonReporterPath: string) {
        this._jsonReporterPath = jsonReporterPath;
    }

    public async validate(pathToFiles: string): Promise<any> {

        const parameter = [pathToFiles, '--reporter', this.jsonReporterPath];
        if (fs.existsSync(this.stylintrcPath)) {
            parameter.push('--config', this.stylintrcPath)
        }
        const options = { ignoreExitCode: true };
        const buffer = await exec.execNode(this.stylintExecPath, parameter, options);
        return JSON.parse(buffer.toString());
    }
}

export { StylintModule };
