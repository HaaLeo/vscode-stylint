# VS Code Stylint extension

[![Version](https://vsmarketplacebadge.apphb.com/version/HaaLeo.vscode-stylint.svg?style=flat-square)](https://marketplace.visualstudio.com/items?itemName=HaaLeo.vscode-stylint) [![Installs](https://vsmarketplacebadge.apphb.com/installs/HaaLeo.vscode-stylint.svg?style=flat-square)](https://marketplace.visualstudio.com/items?itemName=HaaLeo.vscode-stylint) [![Ratings](https://vsmarketplacebadge.apphb.com/rating/HaaLeo.vscode-stylint.svg?style=flat-square)](https://marketplace.visualstudio.com/items?itemName=HaaLeo.vscode-stylint#review-details) [![Stars](https://img.shields.io/github/stars/HaaLeo/vscode-stylint.svg?label=Stars&logo=github&style=flat-square)](https://github.com/HaaLeo/vscode-stylint/stargazers)  
[![License](https://img.shields.io/badge/license-MIT-brightgreen.svg?style=flat-square)](https://raw.githubusercontent.com/HaaLeo/vscode-stylint/master/LICENSE.txt) [![Build Status](https://img.shields.io/travis/HaaLeo/vscode-stylint/master.svg?style=flat-square)](https://travis-ci.org/HaaLeo/vscode-stylint)  
[![David](https://img.shields.io/david/HaaLeo/vscode-stylint.svg?style=flat-square)](https://david-dm.org/HaaLeo/vscode-stylint) [![David](https://img.shields.io/david/dev/HaaLeo/vscode-stylint.svg?style=flat-square)](https://david-dm.org/HaaLeo/vscode-stylint?type=dev) [![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg?style=flat-square)](http://makeapullrequest.com)  
[![Donate](https://img.shields.io/badge/-Donate-blue.svg?logo=paypal&style=flat-square)](https://www.paypal.me/LeoHanisch)

## Description

Integrates [Stylint](https://simenb.github.io/stylint/) into VS Code. If you are new to Stylint check the [documentation](https://simenb.github.io/stylint/).

The extension uses the Stylint library installed in the opened workspace folder. If the folder doesn't provide one the extension looks for a global install version. If you haven't installed Stylint either locally or globally do so by running `npm install stylint` in the workspace folder for a local install or `npm install -g stylint` for a global install.

On new folders you might also need to create a `.stylintrc` configuration file. The extension will search for an `.stylintrc` file on the workspace folder root.

This extension was heavily inspired by [Dirk Baeumer's ESLint extension](https://marketplace.visualstudio.com/items?itemName=dbaeumer.vscode-eslint).

## Installation

### Via Visual Studio Code

1. Press <kbd>Ctrl</kbd> + <kbd>P</kbd> to open the _Go to File..._ view
2. Type `ext install HaaLeo.vscode-stylint` and press <kbd>Enter</kbd>

### From VSIX

1. Download the `.vsix` file of the latest [release from GitHub](https://github.com/HaaLeo/vscode-stylint/releases)
2. Run `code --install-extension vscode-stylint-*.*.*.vsix` in the command line ([reference](https://code.visualstudio.com/docs/editor/extension-gallery#_install-from-a-vsix))

## Settings Options

This extension contributes the following variables to the [settings](https://code.visualstudio.com/docs/customization/userandworkspace):

- `stylint.enable`: enable/disable stylint. Is enabled by default.
- `stylint.stylintrcPath`: The path to the `.stylintrc` file. When no `.stylintrc` file is found the [default options](https://github.com/SimenB/stylint#options) are used.
- `stylint.run`: run the linter `onSave` or `onType`, default is `onType`.
- `stylint.nodePath`: use this setting if an installed Stylint package can't be detected, for example `/myGlobalNodePackages/node_modules`.
- `stylint.alwaysShowStatus`: Always show the Stylint status bar item.
- `stylint.trace.server`: Traces the communication between VSCode and the stylint linter service.
- `stylint.workingDirectories` - an array for working directories to be used. Stylint resolves configuration files relative to a working directory. This new settings allows users to control which working directory is used for which files. Consider the following setups:
```
client/
  .stylintignore
  .stylintrc.json
  client.js
server/
  .stylintignore
  .stylintrc.json
  server.js
```
Then using the setting:
```json
  "stylint.workingDirectories": [
    "./client", "./server"
  ]
```
will validate files inside the server directory with the server directory as the current working directory. Same for files in the client directory. If the setting is omitted the working directory is the workspace folder.

The setting also supports literals of the form `{ "directory": string, "changeProcessCWD": boolean }` as elements. Use this form if you want to instruct Stylint to change the current working directory of the Stylint validation process to the value of `directory` as well.

## Commands:

This extension contributes the following commands to the Command palette.

- `Disable Stylint for this Workspace`: disables Stylint extension for this workspace.
- `Enable Stylint for this Workspace`: enable Stylint extension for this workspace.
- `stylint.showOutputChannel`: show the output channel of the Stylint extension.

## Contribution

If you found a bug or are missing a feature do not hesitate to [file an issue](https://github.com/HaaLeo/vscode-stylint/issues/new).  
Pull Requests are welcome!

## Support
When you like this extension make sure to [star the repo](https://github.com/HaaLeo/vscode-stylint/stargazers) and [write a review](https://marketplace.visualstudio.com/items?itemName=HaaLeo.vscode-stylint#review-details). I am always looking for new ideas and feedback.  
In addition, it is possible to [donate via paypal](https://www.paypal.me/LeoHanisch).
