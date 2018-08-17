'use strict';

const fs = require('fs');
const stylint = require(process.argv[2]) // stylint/index.js path

let config;
try {
    config = JSON.parse(fs.readFileSync(process.argv[4])); // .stylintrc path
}
catch (err) {
    config = {
        "blocks": false,
        "brackets": "never",
        "colons": "always",
        "colors": "always",
        "commaSpace": "always",
        "commentSpace": "always",
        "cssLiteral": "never",
        "customProperties": [],
        "depthLimit": false,
        "duplicates": true,
        "efficient": "always",
        "exclude": [],
        "extendPref": false,
        "globalDupe": false,
        "groupOutputByFile": true,
        "indentPref": false,
        "leadingZero": "never",
        "maxErrors": false,
        "maxWarnings": false,
        "mixed": false,
        "mixins": [],
        "namingConvention": false,
        "namingConventionStrict": false,
        "none": "never",
        "noImportant": true,
        "parenSpace": false,
        "placeholders": "always",
        "prefixVarsWithDollar": "always",
        "quotePref": false,
        "reporterOptions": {
            "columns": ["lineData", "severity", "description", "rule"],
            "columnSplitter": "  ",
            "showHeaders": false,
            "truncate": true
        },
        "semicolons": "never",
        "sortOrder": "alphabetical",
        "stackedProperties": "never",
        "trailingWhitespace": "never",
        "universal": false,
        "valid": true,
        "zeroUnits": "never",
        "zIndexNormalize": false
    };
}
config.reporter = process.argv[5] // reporter/index.js path
stylint(process.argv[3], config).create(); // .styl file path
