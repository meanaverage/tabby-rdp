# Working on tabby-rdp

Read [CONTRIBUTING.md](CONTRIBUTING.md) for implementation, validation and release requirements.

## Branches, PRs and test builds

- The active release-preparation branch is **`0.6.0`**, for package version **`0.6.0`**. All follow-up changes,
  including documentation and agent instructions, belong there. `0.6.0-rc.1` through `0.6.0-rc.4` are released.
- Start feature/fix branches from current `origin/0.6.0` and target their PRs at `0.6.0`. The stable release-integration PR alone targets `main`.
  Use one PR for a cohesive change and its tests, documentation and packaging. Check an existing checkout's base
  and PR destination before preparing or merging it; preserve newer fixes when moving older work.
- After publishing a release, create or select the next development version's branch from the released version's tag and
  advance its package version before further changes. Do not accumulate new changes under a released version.
  Update the active branch/version recorded here and each `target-branch` in `.github/dependabot.yml` at that transition.
- Prepare the PR and a downloadable package for analysis and hands-on testing. Keep the PR as a draft while that
  work remains. State which client OS/architecture and remote servers were actually tested, and which remain pending.
- A requested PR authorizes the branch, commits, push and PR needed to make the change reviewable. A direction to
  integrate changes into the active preview branch authorizes that integration after checks pass; it does not
  authorize merging into `main`, tagging or publishing. Continue routine implementation and validation without
  repeatedly asking the maintainer to reconfirm this procedure.

## Release approval

- The package version, working branch and release tag are different things. Use preview versions such as
  `0.6.0-rc.1` in `package.json` and the root entries of `package-lock.json`; the eventual tag is `v0.6.0-rc.1`.
- Version preparation and a PR test build do not constitute a release. Use
  `npm run pack:release -- --pack-destination <directory>` to create a test package without a tag.
- `main` holds stable releases only, so that a checkout of it is always a released, stable version. A preview is
  tagged on its version branch and is not merged into `main`. Merge a version branch into `main` only for a stable
  release, after the required checks pass and the maintainer authorizes that integration. The 0.6.0-rc.1 preview
  predates this rule; from 0.6.0 on, `main` holds stable releases only.
- **Do not create or push a release tag, stage or approve an npm publication, or publish a GitHub release until the
  maintainer explicitly authorizes that release after testing.** Passing CI or a version bump is not that approval.
- Once authorized, tag a preview on its version branch, and a stable release on the merged commit on `main`.
  Follow CONTRIBUTING.md: preview versions use npm's `beta` dist-tag; a release tag triggers package validation and
  npm staging; independently verify the staged package before approval and verify npm before publishing the GitHub
  release draft.

## Documentation

- Keep the README focused on what is supported, installation, first use and links to detailed guides in `docs/`.
- Describe Windows and supported Linux desktops near the top. Distinguish GNOME's automatic headless setup from
  xrdp sessions and experimental KRDP support without implying that Linux support requires GNOME.
- Use short comparison tables for connection routes, OS differences and settings. Put detailed credential,
  certificate, migration and protocol rules in linked guides, retaining the behavior that matters to users.
- Keep guides in this repository so they stay versioned and reviewed with the implementation. Update links when
  moving material. Experimental client capabilities must be distinguished from the default IronRDP client.

## Public copy and audience

- Write PR and issue descriptions, release notes, README text and user guides for readers who have not seen the
  chat. Describe the problem, resulting behavior, relevant limitations and concise validation evidence.
- Keep communications to the maintainer in chat: progress reports, approval requests or history, personal test
  instructions, installed-build status, local VM/profile names, machine-specific paths, agent handoffs and model
  review transcripts. Do not copy those updates into public descriptions or documentation.
- Report validation by client OS/architecture, server/version, checks and outcome. Include genuine coverage gaps;
  omit private setup details, agent/model names and a chronology of work or approvals.
- Public installation instructions must work for any reader. Link to a release or downloadable artifact rather
  than describing a build installed on the maintainer's computer. User-facing instructions such as choosing a
  setting are appropriate; maintainer-specific instructions are not.
- Keep release procedures in CONTRIBUTING.md and agent instructions here. Generated release drafts may state
  that they are unpublished, but must not instruct the maintainer inside their release-note text. Remove the
  unpublished notice before publication after verifying npm availability.
- Before saving or publishing public copy, check the exact outgoing text for its audience. After updating a
  GitHub description or release, fetch and read back the saved text. Rewrite stale descriptions around the final
  change instead of appending conversational updates. Follow the same rules when creating a PR for copy changes.
