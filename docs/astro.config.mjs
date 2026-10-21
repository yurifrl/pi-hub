import { defineConfig } from "astro/config";

export default defineConfig({
    // Every markdown file in docs/ becomes a page: 01-architecture.md → /01-architecture.html
    site: "http://127.0.0.1:4321",
    markdown: { syntaxHighlight: "shiki" },
    build: { format: "file" },
});
