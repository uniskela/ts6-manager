# Notify the Uniskela documentation site

The `Notify Uniskela documentation` workflow sends an immediate update notification after README/docs changes merge to `main`. It does not publish the website directly: `uniskela/com` imports reviewed content, runs checks, and proposes a draft PR for review.

Configure Actions variable `DOCS_SYNC_APP_ID` and Actions secret `DOCS_SYNC_APP_PRIVATE_KEY` using the dedicated documentation GitHub App installed only on `uniskela/com` with Contents read/write permission. The workflow creates a short-lived, destination-only installation token and revokes it after use. It never runs on pull requests or forks and does not check out source code.

Merge the receiver into the destination default branch and configure its `DOCS_SYNC_APP_SLUG` before merging/enabling this notifier. Missing source credentials cause a visible workflow failure. Then run this workflow manually on `main` to test, and verify the destination receiver succeeds. The weekly destination sync remains a fallback. New public pages belong in `docs/public/` and `docs/manifest.json`. `docs/internal/` and `docs/agents/` are not imported. New documentation pages still need selection in the destination manifest.

Account-wide registration, configuration, and smoke-test instructions are maintained by the site owner in the `uniskela/com` repository at `docs/docs-dispatch-setup.md`. Do not put App private keys in repository files, PRs, or chats.

GitHub may suppress push-triggered workflows when the original push used `GITHUB_TOKEN`; use the manual run or scheduled destination fallback for such updates. Existing GitHub Pages deployments continue unchanged until the separate documentation migration cutover.

## TS6 Manager website (replacement, inactive until approved)

`.github/workflows/notify-website-docs.yml` notifies the new website, `uniskela/ts6-manager-website` (a private repository), which is replacing the Uniskela docs. It runs alongside the workflow above during the migration and does not change it or `release-please.yml`.

- **Triggers:** README/docs changes merged to `main` (Next), and completed `Release Please` runs on `main` (stable). A release is announced only when the latest published release's tag points at the commit that run built. Manual runs on `main` are allowed for testing.
- **What it sends:** a `workflow_dispatch` of the website's `docs-update.yml` with the commit SHA and, for releases, the tag. The website re-resolves the latest release and `main` itself, runs its checks and opens a draft PR. The notification cannot choose what gets published.
- **Credentials:** a dedicated notifier GitHub App, installed only on `uniskela/ts6-manager-website`, with **Actions: read and write** and nothing else, so it can start a workflow run but cannot push code or open PRs. It is not the existing `DOCS_SYNC_APP_*` App. Configure variable `TS6_WEBSITE_NOTIFY_APP_ID` and secret `TS6_WEBSITE_NOTIFY_APP_PRIVATE_KEY`.
- **Switch:** the job is skipped unless the repository variable `TS6_WEBSITE_DOCS_NOTIFY` is `true`. Unset it to stop notifications.

Registration, activation order and the smoke test are in the website repository at `docs/docs-automation-setup.md` (maintainers only). The website also runs a daily sync, so a missed notification is picked up within a day.
