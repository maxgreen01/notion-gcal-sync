import globals from "globals";
import js from "@eslint/js";
import eslintConfigPrettier from "eslint-config-prettier";
import eslintPluginGoogleAppsScript from "eslint-plugin-googleappsscript";

// https://eslint.org/docs/latest/use/configure/
export default [
    js.configs.recommended,
    eslintConfigPrettier,
    {
        ignores: ["node_modules/**", "dist/**", "build/**"],
        files: ["**/*.gs", "**/*.js"],

        plugins: {
            googleappsscript: eslintPluginGoogleAppsScript,
        },
        rules: {
            "no-unused-vars": "warn",
            "no-undef": "error",
            "no-redeclare": "warn",
        },
        languageOptions: {
            sourceType: "script",
            globals: {
                ...globals.node,
                ...eslintPluginGoogleAppsScript.environments.googleappsscript.globals,
            },
        },
    },
];
