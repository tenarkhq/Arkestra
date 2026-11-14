# Arkestra

Arkestra is an agent IDE: one desktop surface where different AI coding agents
work side by side, in shared rooms, on your projects.

It is built on a cleaned-up and reshaped VS Code (Code OSS) base. The surface
aims to be as simple as Cursor, and more beautiful. It mixes the functions of the
ChatGPT and Claude desktop apps with the room engine of 2ARK.

**Status: design phase.** The UI is being drawn and the feature list settled.
No code has been written yet.

## Platforms

macOS, Windows and Linux, from one code base.

## Languages

The whole interface is available in English and Hungarian. It starts in the
system language and can be switched with one click.

## Features of the first version

### Agents and rooms

1. **Any agent joins any thread, even mid-run.** For example, an OpenAI agent
   can be attached to a running Claude thread. It receives the thread so far
   and works in the same conversation. The running agent does not stop.
2. **2ARK room templates.** The room types defined in 2ARK (coding, audit,
   brief check) start from the IDE. The template brings the roles, the order
   and the output; you only choose the target (file, branch, PR, brief).
3. **Local and remote CLIs.** Every agent runs through a CLI, on the local
   machine or on a server over SSH. A room can mix them, for example a local
   Claude with a Codex running on a server.
   Files move over SSH by drag and drop: drop files or folders from the
   desktop onto a remote folder, or onto an SSH terminal for its current
   folder, to upload them (SFTP); drag them out to
   download, with progress and cancel, for any connection, even without
   opening that project.
4. **Projects and categories.** Threads are grouped into projects (a project is
   a folder or repository, local or over SSH) and tagged with categories
   (coding, audit, brief, idea). Threads can be pinned.
5. **API key and subscription.** Every provider connects by API key, by
   subscription login (through its own CLI), or both.
   Beyond the built-in providers, any agent that speaks the open Agent
   Client Protocol (ACP) joins rooms without its own integration code, for
   example Gemini CLI, or Claude Code and Codex through their ACP adapters.

### Taken from Cursor

6. **Best-of-N.** The same task runs on several models in separate worktrees;
   the results are compared and one is chosen.
7. **Checkpoints.** A checkpoint before every agent step, restorable with one
   click.
8. **Inline edit (Cmd+K).** Select code, describe the change, review it as a
   diff in place.
9. **@-references.** Pull files, folders, the git diff, docs, the web, the
   terminal, another thread or a 2ARK brief into a message.
10. **Shared rules and memory.** One rules file and one memory that every agent
    receives, whatever its provider (handed to each CLI in its own format).
11. **Plan mode.** The agent writes a plan first; coding starts after approval.
12. **Command allow lists.** Per machine and project: what runs without asking,
    what needs approval, what is forbidden.

Next-edit prediction (Cursor Tab) is left for later.

### Artifacts

13. Every artifact any agent makes (diagram, document, page, code, image) is
    collected in one place, with versions, filters by project, type and agent,
    pinning, and a link back to its thread.

### Project management, linked with GitHub

14. **Project views:** Board, Table, Plan and Graph.
    - **Board and Table** follow the GitHub Project fields (status, line,
      executor model, review model, prerequisites, PR), plus two columns of
      our own: the room running on the task and its progress.
    - **Plan** shows release lanes with weighted progress, branch rails (where
      `main` and each open branch stand and what goes on next), and a
      dependency staircase with the critical path.
    - **Graph** is a free node graph where dependencies are drawn by hand.
15. **Live two-way sync with GitHub, no manual refresh.** Anything that happens
    on GitHub (issues, PRs, reviews, CI, project fields, blocked-by links,
    branches) shows up within seconds, and every change made in Arkestra is
    written to GitHub at once. Webhooks through a GitHub App; polling only
    as a fallback after a dropped connection.

### Quota, tokens and context

16. **Quota at a glance.** A small ring in the header shows the most used
    limit; a click opens every provider's limits, reset times and extra
    usage. The windows shown are whatever each provider reports, never
    hard-coded ones.
17. **Context per thread and per agent,** and **tokens used** per thread,
    per agent and per day (input, output, cache, API cost).

## Layout

- The chat (the room) is the centre of the window by default.
- Files and code sit in a side panel that closes and reopens.
- Left: threads by project, pinned items, files, git, artifacts, project views.
- Dark and light themes.

## VS Code base

Removed: telemetry, Microsoft account and sync, the welcome page and
walkthroughs, Live Share, tips and notification noise.

Other agents stay usable: GitHub Copilot and any other AI extension (Cline,
Continue, Roo Code, the Claude Code and Codex extensions) can be installed
and used beside Arkestra's own agents. None of them ships by default.

Hidden but restorable: the activity bar, minimap, breadcrumbs bar, debug panel,
extension recommendations and the menu bar.

Kept: the editor, language services, terminal, git, search, command palette,
key bindings and extensions.

Extensions come from [Open VSX](https://open-vsx.org), as in Cursor and
VSCodium. Microsoft's own extensions cannot be used in a fork; open
equivalents or built-in features replace them (for example basedpyright for
Pylance, clangd for C/C++, Open Remote - SSH for Remote-SSH).

## Not decided yet

- The app icon.
