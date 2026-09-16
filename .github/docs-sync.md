# Notify the Uniskela documentation site

The `Notify Uniskela documentation` workflow sends an immediate update notification after README/docs changes merge to `main`. It does not publish the website directly: `uniskela/.com` imports reviewed content, runs checks, and proposes a draft PR for review.

Configure Actions variable `DOCS_SYNC_APP_ID` and Actions secret `DOCS_SYNC_APP_PRIVATE_KEY` using the dedicated documentation GitHub App installed only on `uniskela/.com` with Contents read/write permission. The workflow creates a short-lived, destination-only installation token and revokes it after use. It never runs on pull requests or forks and does not check out source code.

Merge the receiver into the destination default branch and configure its `DOCS_SYNC_APP_SLUG` before merging/enabling this notifier. Missing source credentials cause a visible workflow failure. Then run this workflow manually on `main` to test, and verify the destination receiver succeeds. The weekly destination sync remains a fallback. New documentation pages still need selection in the destination manifest.

Account-wide registration, configuration, and smoke-test instructions are maintained by the site owner in the `.com` repository at `docs/docs-dispatch-setup.md`. Do not put App private keys in repository files, PRs, or chats.

GitHub may suppress push-triggered workflows when the original push used `GITHUB_TOKEN`; use the manual run or scheduled destination fallback for such updates. Existing GitHub Pages deployments continue unchanged until the separate documentation migration cutover.
