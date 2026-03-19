# Original Prompt (Extracted from Conversation)

I want to add two new CLI commands to the SolidActions CLI that help AI coding assistants write SolidActions workflows more easily.

The first command, `solidactions ai:init`, should install an AI helper file into the user's project. It asks the user whether they want CLAUDE.md or AGENTS.md (both contain the same content, just different filenames for different AI tools). It also supports `--claude` and `--agents` flags so AI tools can run it non-interactively. The command fetches the CLAUDE.md content from the solidactions-examples GitHub repo and either creates the file fresh or merges it into the bottom of an existing one using `<!-- SolidActions -->` markers. It also fetches the SDK reference doc from the solidactions-ts-sdk repo and saves it to `.solidactions/sdk-reference.md`, adding a reference note in a separate `<!-- SolidActions SDK Reference -->` section in the AI file. Running the command again replaces only the content inside the markers with the latest version.

The second command, `solidactions ai:examples`, clones example workflow projects into `.solidactions/examples/`. With no arguments it opens an interactive multi-selector. You can also pass specific example names as arguments or use `--all` to grab everything. It discovers available examples by reading the folder structure from the GitHub repo (no manifest file). When examples are cloned, it adds a note to the CLAUDE.md/AGENTS.md in its own `<!-- SolidActions Examples -->` section explaining where the examples are and that AI should use them as reference for writing workflows. If an example already exists locally it warns the user, with `--overwrite` to bypass.

There's also a separate task to update the examples repo's CLAUDE.md with critical SDK gotchas that AI needs to know: determinism rules (no fetch/filesystem/Math.random in workflows), Promise.all vs Promise.allSettled for parallel steps, using now() instead of Date.now(), using randomUUID() instead of crypto.randomUUID(), step retry config details, send/recv topic behavior, and error class details.

---
*Extracted by Clavix on 2026-02-23. See optimized-prompt.md for enhanced version.*
