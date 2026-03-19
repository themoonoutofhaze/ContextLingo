# Privacy Policy for ContextLingo

Last updated: 2026-03-19

ContextLingo is a Chrome extension that helps users look up words in context and optionally create Anki cards.

## Data We Process

- Selected text and nearby context from web pages you choose to interact with.
- Extension settings stored in Chrome sync storage (for example AI provider, deck names, and optional API keys you enter).
- Optional screenshot captures only when you trigger an Anki add flow that requests a screenshot.

## How Data Is Used

- To provide dictionary and AI explanations for selected words.
- To generate and submit Anki cards to a local AnkiConnect instance on your machine.
- To save user preferences across browser sessions.

## Third-Party Services

If you enable AI features, selected text/context may be sent to your configured provider:

- Mistral
- OpenAI-compatible endpoint
- Ollama (typically local)
- Gemini-compatible endpoint (if configured)

Dictionary lookups may use external dictionary endpoints.

You are responsible for the API credentials you configure and for reviewing each provider's privacy terms.

## Data Storage

- Settings are stored with `chrome.storage.sync` or session storage where applicable.
- Context text is processed on demand and is not persisted by the extension beyond feature operation unless included in generated Anki content.

## Data Sharing

- We do not sell personal data.
- Data is shared only with services needed to fulfill user-requested features (AI provider, dictionary endpoints, AnkiConnect local app).

## Security

- API keys are stored in Chrome extension storage and used only for requests you trigger.
- You should use dedicated API keys and rotate them periodically.

## User Controls

- You can disable the extension per site.
- You can clear or change extension settings at any time.
- You can stop using AI providers by removing API keys.

## Contact

Mehdi Nickzamir  
Email: mehdi.nickzamir99@gmail.com  
Website: https://mehdinickzamir.com
