# Changelog
All notable changes to the "vscode-stylint" extension will be documented in this file. This project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Unreleased
* **Updated** dependencies to fix security vulnerability in `node.extend`.

## 2018-11-25 - v0.1.1
* **Fixed** the type of setting `stylint.stylintrcPath`. [PR #5](https://github.com/HaaLeo/vscode-stylint/pull/5) by [@maranomynet](https://github.com/maranomynet).

## 2018-10-29 - v0.1.0
* **Added** a setting `stylint.packageManager` that controls the package manager to be used to resolve the Stylint library ([#1](https://github.com/HaaLeo/vscode-stylint/issues/1)).

## 2018-08-18 - v0.0.2
* **Fixed** a bug that crashed the server when a rule's severity was set to `"error": true`.

## 2018-08-17 - v0.0.1
* **Initial Release**
* **Added** a feature that enables basic linting.
