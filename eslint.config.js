import js from "@eslint/js";

export default [
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: {
        chrome: "readonly",
        window: "readonly",
        document: "readonly",
        console: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        setInterval: "readonly",
        clearInterval: "readonly",
        fetch: "readonly",
        MutationObserver: "readonly",
        NodeFilter: "readonly",
        URL: "readonly",
        URLSearchParams: "readonly",
        ShadowRoot: "readonly",
        requestAnimationFrame: "readonly",
        Image: "readonly",
        location: "readonly",
        Node: "readonly",
        Math: "readonly",
        Date: "readonly"
      }
    },
    rules: {
      "no-unused-vars": "warn",
      "no-undef": "error",
      "no-console": "off",
      "no-case-declarations": "warn",
      "no-useless-escape": "warn",
      "no-empty": "warn"
    }
  }
];
