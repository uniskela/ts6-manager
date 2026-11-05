# Private-beta Discord bridge GHCR publish — trust model

Manual `workflow_dispatch` on `main` only. Not on the Release Please or
stable-image path. Do not dispatch until a maintainer is ready to approve
the `discord-bridge-private-beta` environment. Do not make the package public.

This is a **reduced-trust private preview**. It is not production provenance.
Treat published tags as maintainer-only until the image is rebuilt from merged
`main` by the existing stable release workflows. Approve that reduced-trust
use separately from merging #504.

Environment approval gates **GHCR push**, not the unprivileged build. The
image tarball is an Actions artifact for three days. Anyone who can dispatch
this workflow and read Actions artifacts can download those bytes without
approver sign-off. That is accepted for this preview: only trusted writers
should dispatch.

## What attestation proves

GitHub-signed OIDC attestation (`actions/attest` in a job that never runs PR,
Dockerfile, or image code) plus `gh attestation verify --cert-identity` on
`gh` 2.102.0+ proves:

- these tarball bytes were signed by GitHub for this workflow identity on
  `refs/heads/main`;
- the custom predicate `source_sha` equals the dispatch input.

It does **not** prove the bytes were built from that commit. Signing a tarball
received from the unprivileged build job does not fix artifact substitution.
A malicious Dockerfile at an approved SHA, or a swap of the saved tarball
before upload, still yields a GitHub-signed artifact for that dispatch SHA.

## Trusted-builder options (not adopted)

| Design | Why it was not used |
|--------|---------------------|
| Privileged rebuild + compare | Executes untrusted Dockerfile with `packages:write`. |
| Build and attest in one job with OIDC | Gives the job that runs the Dockerfile `id-token`. |
| `docker/build-push-action` provenance on push | Publishes during the build. |
| Independent bit-for-bit rebuild | Needs a reproducible lab image; this Dockerfile is not. |

The remaining builder is GitHub-hosted `ubuntu-latest` running the workflow
file from `main`: checkout approved SHA, `docker build`, save, upload, then
attest in a separate job with no `packages:write`. That is SLSA-style trust
in the platform and the `main` workflow, not source-to-bytes equivalence.

## Privilege split

| Job | May run PR / Dockerfile / image | OIDC | `packages:write` |
|-----|---------------------------------|------|------------------|
| `verify-and-build` | yes, after API membership check | no | no |
| `attest` | no | yes | no |
| `publish` | no. `docker load` + `docker push` only | no | yes, after approval |

`publish` checkouts `github.sha` for verify scripts. It does not checkout
`${{ inputs.commit }}` and does not run `packages/discord-bridge` scripts.

Environment `discord-bridge-private-beta` has required reviewers and admin
bypass disabled.

## GHCR privacy

GitHub: a **new** GHCR package is **private** by default. Once a package is
**public**, it **cannot** be made private.

This workflow still will not create the package. `require-private` before
push fails if the package is missing, not `private`, or the tag exists.
That is an operational control: confirm an already-private package, avoid
creating one from this workflow, and refuse tag overwrite.

Check/push race: the package can change after `require-private` and before
`docker push`. If it is public then, the new tag is public. The workflow
cannot PATCH it private.

After a push may have occurred (including digest-inspect failure),
`verify-after-push` always runs. Public visibility or anonymous HTTP 200
deletes only the version whose tags are exactly the tag we pushed, then
fails. Versions that also carry other tags are not deleted. DELETE errors
are included in the failure. Cleanup does **not** undo a pull that already
happened, and it does not make a public package private.

Registry v2 anonymous bearer flow: HTTP 200 on the manifest is confirmed
public access and triggers that retraction. If GHCR withholds an anonymous
token (HTTP 401/403), that counts as denied only after the Packages API
independently reports `visibility=private` for this repository. Malformed
token bodies, transport errors, rate limits, and unexpected status codes
fail closed without retracting. A raw unauthenticated 401 is not proof of
privacy by itself.

## Attestation verification

Publish requires `gh` 2.102.0 or newer (complete identity matching). It
passes `--cert-identity` (exact SAN, not `--signer-workflow`; those flags
are mutually exclusive) plus `--source-ref refs/heads/main` and the custom
predicate type. Local `gh` 2.102.0 accepts that argument set.
