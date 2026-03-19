# Contributing to Interactive Subtitle Dictionary

First off, thank you for considering contributing to this project! It's people like you that make open source such a great community.

## Getting Started

1. **Fork the repository** on GitHub.
2. **Clone your fork** locally: `git clone https://github.com/YOUR-USERNAME/interactive-subtitle-dictionary.git`
3. **Install dependencies**: `npm install`
4. **Run the dev server**: `npm run dev` (this will rebuild automatically on changes)

### Loading in Chrome

1. Open Chrome and go to `chrome://extensions/`
2. Enable **Developer mode** in the top right.
3. Click **Load unpacked**.
4. Select the `dist/` directory from this project.

## Code Architecture

This project is built with Vanilla JavaScript and Vite. We follow a modular architecture:

- `src/background/`: Service worker scripts handling API calls and Context Menus.
- `src/content/`: Scripts injected into web pages (Netflix, YouTube, Amazon) to overlay subtitles.
- `src/ui/`: UI components like the Sidebar and Settings pages.
- `src/services/`: Integrations with external APIs (Anki, Mistral, Ollama).

## Pull Request Guidelines

1. **Create a new branch**: `git checkout -b feature/your-feature-name`
2. **Commit your changes**: Write clear, concise commit messages.
3. **Run the linter**: Ensure your code passes `npm run lint` (uses ESLint/Prettier).
4. **Push and Open a PR**: Submit a pull request against the `main` branch.

### Bug Reports

If you find a bug, please create an Issue on GitHub with:
- What you expected to happen
- What actually happened
- Browser version and OS
- Steps to reproduce

Thank you for contributing!
