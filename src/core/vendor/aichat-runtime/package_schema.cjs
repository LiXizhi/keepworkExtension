"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PACKAGE_SCHEMA = void 0;
// Canonical portable schema. SDK JSON is checked for parity in contract tests.
exports.PACKAGE_SCHEMA = {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "title": "AIChat package v1",
    "type": "object",
    "required": [
        "schemaVersion",
        "id",
        "version",
        "hostApi",
        "files",
        "capabilities"
    ],
    "properties": {
        "schemaVersion": {
            "const": 1
        },
        "id": {
            "type": "string",
            "pattern": "^[a-z0-9][a-z0-9._-]{0,95}$"
        },
        "version": {
            "type": "string",
            "pattern": "^[0-9]+\\.[0-9]+\\.[0-9]+$"
        },
        "hostApi": {
            "type": "string",
            "pattern": "^\\^?[0-9]+\\.[0-9]+\\.[0-9]+$"
        },
        "dependencies": {
            "type": "object",
            "additionalProperties": {
                "type": "string"
            }
        },
        "files": {
            "type": "array",
            "uniqueItems": true,
            "items": {
                "type": "string"
            }
        },
        "capabilities": {
            "type": "array",
            "uniqueItems": true,
            "items": {
                "type": "string"
            }
        },
        "entrypoints": {
            "type": "object",
            "properties": {
                "browser": {
                    "type": "string"
                },
                "host": {
                    "type": "string"
                }
            },
            "additionalProperties": false
        },
        "configSchema": {
            "type": "object"
        },
        "contributes": {
            "type": "object"
        },
        "assetLayout": {
            "enum": [
                "legacy",
                "isolated"
            ]
        },
        "requiresServices": {
            "type": "object",
            "additionalProperties": {
                "type": "string",
                "pattern": "^\\^?[0-9]+\\.[0-9]+\\.[0-9]+$"
            }
        }
    }
};
