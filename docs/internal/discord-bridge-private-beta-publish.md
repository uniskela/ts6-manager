# Private-beta Discord bridge GHCR publish — trust model

Manual `workflow_dispatch` on `main` only. Not on the Release Please or
stable-image path. Do not dispatch until a maintainer is ready to approve
the `discord-bridge-private-beta` environment. Do not make the package public.

## Trust roots

Independently verifiable:

1. **Dispatch SHA** — `${{ inputs.commit }}` comes from the GitHub event, not
   from the image or a file the build job wrote.
2. **PR membership** — `scripts/ci/verify_private_beta_source.py` asks the
   GitHub API (not stdin) whether that SHA is on open, same-repository PR 504.
   Build, attest, and publish each run this against `github.sha` scripts.
3. **GitHub OIDC attestation** — the `attest` job checkouts `github.sha` only.
   It never checkouts the PR, never runs the Dockerfile, never loads or execs
   the image. It hashes the tarball and GitHub-signs a predicate whose
   `source_sha` is `${{ inputs.commit }}`. Privileged publish re-hashes the
   tarball and runs `gh attestation verify --signer-workflow` for this
   workflow and predicate type. A self-written checksum, `provenance.json`,
   or OCI label is not a trust root.
4. **Environment approval** — `publish` requires `discord-bridge-private-beta`
   with required reviewers and admin bypass disabled.

Not trust roots: OCI `org.opencontainers.image.revision`, a sha256 file next
to the tarball, or any JSON the unprivileged build job generated.

## Privilege split

| Job | May run PR / Dockerfile / image | OIDC | `packages:write` |
|-----|---------------------------------|------|------------------|
| `verify-and-build` | yes, after API membership check | no | no |
| `attest` | no | yes | no |
| `publish` | no. `docker load` + `docker push` only | no | yes, after approval |

`publish` checkouts `github.sha` for the verify scripts. It does not checkout
`${{ inputs.commit }}` and does not run `packages/discord-bridge` scripts.

## GHCR privacy

This workflow will not create the package. First push of a public-repo GHCR
package is public by default. Provision `ghcr.io/uniskela/ts6-manager/discord-bridge`
as a **private** package out of band, then dispatch. `require-private` fails
if the package is missing, public, or the tag already exists.

After push: `assert-private` plus the unauthenticated Registry v2 bearer
flow (`GET https://ghcr.io/token?...` then `Authorization: Bearer` on the
manifest). HTTP 200 on the manifest fails the job (public). Token or
transport errors fail closed. A raw unauthenticated 401 is not treated as
proof of privacy.

## Residual

A compromised unprivileged build can still substitute tarball bytes. GitHub
will then attest those bytes to the dispatch SHA. Containment is: no OIDC
and no `packages:write` on build; environment approval; signer-workflow
bind; no privileged execution of PR or image code. Bit-for-bit rebuild in
`publish` is refused because that would execute the untrusted Dockerfile
with `packages:write`.
