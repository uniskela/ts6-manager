# IPTV Local Hosts Header UX Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the IPTV LAN allowlist editor off the always-visible page card into a header **Local hosts** dialog (admin only), with a short empty-state hint.

**Architecture:** Keep `/settings/iptv-network` and `allowedLocalHosts` unchanged. Convert `IptvLocalHostsCard` into a controlled dialog plus a compact header trigger (count badge). `Iptv.tsx` owns `hostsOpen` state so both the header button and empty-state hint open the same dialog.

**Tech Stack:** React, TanStack Query, shadcn Dialog/Button/Badge, Playwright, existing `useIptvNetworkSettings` / `parseHostLines`.

**Spec:** `docs/superpowers/specs/2026-10-01-iptv-local-hosts-header-ux-design.md`

## Global Constraints

- Frontend-only; do not change backend allowlist validation or API contract.
- Admins only (same as today’s card); non-admins see no trigger.
- Do **not** add a third Add Playlist mode or treat hosts as a playlist list row.
- Do **not** add a second large primary empty-state button for hosts.
- Button label: **Local hosts**; tooltip: `Allow Threadfin / xTeVe / TVHeadend for IPTV`.
- Empty-state hint copy: `Using Threadfin, xTeVe or TVHeadend? Allow its host first.`
- Conventional commits; prefer one PR titled `feat: move IPTV local hosts into header dialog`.

## File map

| File | Responsibility |
|---|---|
| `packages/frontend/src/components/iptv/IptvLocalHostsDialog.tsx` | Controlled dialog + header trigger button (replaces card) |
| `packages/frontend/src/components/iptv/IptvLocalHostsCard.tsx` | Delete after move (or thin re-export deleted) |
| `packages/frontend/src/pages/Iptv.tsx` | Header button, empty-state hint, remove bottom card |
| `packages/frontend/tests/iptv-local-hosts.spec.ts` | Open via header → save allowlist |
| `packages/frontend/src/hooks/use-iptv-network.ts` | Unchanged |
| `packages/frontend/src/lib/iptv-network.ts` | Unchanged (`parseHostLines`) |

---

### Task 1: Dialog + header trigger component

**Files:**
- Create: `packages/frontend/src/components/iptv/IptvLocalHostsDialog.tsx`
- Delete: `packages/frontend/src/components/iptv/IptvLocalHostsCard.tsx` (after Task 2 swaps imports)
- Test: `packages/frontend/tests/iptv-local-hosts.spec.ts` (updated in Task 3; smoke via typecheck here)

**Interfaces:**
- Produces: `IptvLocalHostsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void })`
- Produces: `IptvLocalHostsTrigger({ onClick }: { onClick: () => void })` — outline button with Network icon, label **Local hosts**, `title` tooltip, optional count badge from `useIptvNetworkSettings(true)`
- Consumes: `useIptvNetworkSettings`, `useUpdateIptvNetworkSettings`, `parseHostLines`, existing toast copy

- [ ] **Step 1: Create `IptvLocalHostsDialog.tsx`**

```tsx
/**
 * Admin allowlist of LAN hosts (Threadfin, xTeVe, TVHeadend, a router proxy …)
 * that IPTV playlists and channels may use. URLs typed in chat or the video
 * URL box stay blocked from private addresses regardless.
 */

import { useEffect, useState } from 'react';
import { Network } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { useIptvNetworkSettings, useUpdateIptvNetworkSettings } from '@/hooks/use-iptv-network';
import { apiErrorMessage } from '@/lib/api-error';
import { parseHostLines } from '@/lib/iptv-network';

const TOOLTIP = 'Allow Threadfin / xTeVe / TVHeadend for IPTV';

/** Header / empty-state control that opens the allowlist dialog. */
export function IptvLocalHostsTrigger({ onClick }: { onClick: () => void }) {
  const query = useIptvNetworkSettings(true);
  const count = query.data?.allowedLocalHosts.length ?? 0;

  return (
    <Button type="button" variant="outline" onClick={onClick} title={TOOLTIP}>
      <Network className="h-4 w-4 mr-1.5" aria-hidden="true" />
      Local hosts
      {count > 0 && (
        <Badge variant="secondary" className="ml-1.5 px-1.5 py-0 text-[10px]" aria-label={`${count} allowed hosts`}>
          {count}
        </Badge>
      )}
    </Button>
  );
}

export function IptvLocalHostsDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const query = useIptvNetworkSettings(true);
  const update = useUpdateIptvNetworkSettings();
  const saved = query.data?.allowedLocalHosts ?? [];
  const [draft, setDraft] = useState('');

  useEffect(() => {
    if (open && query.data) setDraft(query.data.allowedLocalHosts.join('\n'));
  }, [open, query.data]);

  const hosts = parseHostLines(draft);
  const dirty = hosts.join('\n') !== saved.join('\n');

  const save = () => {
    update.mutate(hosts, {
      onSuccess: (data) => {
        setDraft(data.allowedLocalHosts.join('\n'));
        toast.success(data.allowedLocalHosts.length
          ? 'Local IPTV hosts saved — refresh a playlist to use them'
          : 'Local IPTV hosts cleared');
      },
      onError: (e) => toast.error(apiErrorMessage(e, 'Failed to save local IPTV hosts')),
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Network className="h-4 w-4" aria-hidden="true" /> Local network sources
          </DialogTitle>
          <DialogDescription>
            Playlists and channels on your home network (for example Threadfin, xTeVe or TVHeadend at 192.168.x.x)
            are blocked by default. List the hosts you trust to allow them for IPTV only.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-2 py-1">
          <Label htmlFor="iptv-local-hosts">Allowed local IPTV hosts</Label>
          <Textarea
            id="iptv-local-hosts"
            rows={5}
            spellCheck={false}
            placeholder={'192.168.1.20\n192.168.1.0/24\nthreadfin.lan'}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            disabled={!query.data}
          />
          <p className="text-xs text-muted-foreground">
            One per line: an IP, a range or a hostname. Links typed in chat or the video URL box stay blocked;
            loopback and link-local addresses cannot be allowed.
          </p>
        </div>

        <DialogFooter className="gap-2 sm:gap-0">
          {dirty && (
            <Button type="button" variant="ghost" onClick={() => setDraft(saved.join('\n'))}>
              Reset
            </Button>
          )}
          <Button type="button" onClick={save} disabled={!query.data || !dirty || update.isPending}>
            {update.isPending ? 'Saving…' : 'Save hosts'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step 2: Typecheck the new module**

Run from repo root:

```bash
pnpm --filter frontend exec tsc -b --pretty false
```

Expected: PASS (or only pre-existing unrelated errors). Fix any errors introduced by this file.

- [ ] **Step 3: Commit**

```bash
git add packages/frontend/src/components/iptv/IptvLocalHostsDialog.tsx
git commit -m "$(cat <<'EOF'
feat: add IPTV local hosts dialog and header trigger

EOF
)"
```

---

### Task 2: Wire IPTV page (header + empty hint; remove card)

**Files:**
- Modify: `packages/frontend/src/pages/Iptv.tsx`
- Delete: `packages/frontend/src/components/iptv/IptvLocalHostsCard.tsx`

**Interfaces:**
- Consumes: `IptvLocalHostsDialog`, `IptvLocalHostsTrigger` from `@/components/iptv/IptvLocalHostsDialog`
- Produces: page state `hostsOpen: boolean` shared by header trigger and empty-state hint

- [ ] **Step 1: Update imports and state in `Iptv.tsx`**

Replace:

```tsx
import { IptvLocalHostsCard } from '@/components/iptv/IptvLocalHostsCard';
```

with:

```tsx
import { IptvLocalHostsDialog, IptvLocalHostsTrigger } from '@/components/iptv/IptvLocalHostsDialog';
```

Add next to other dialog state (`addOpen`, etc.):

```tsx
const [hostsOpen, setHostsOpen] = useState(false);
```

- [ ] **Step 2: Header actions — Local hosts left of Add Playlist**

Replace the `actions` fragment so admins get the trigger before Add Playlist:

```tsx
actions={(
  <>
    <Select value={selectedConfigId ? String(selectedConfigId) : ''} onValueChange={(v) => { setServer(parseInt(v)); setSelectedPlaylistId(null); }}>
      <SelectTrigger aria-label="IPTV server" className="h-10 min-w-0 flex-1 sm:h-9 sm:w-48 sm:flex-none"><SelectValue placeholder="Select server" /></SelectTrigger>
      <SelectContent>
        {serverList.map((s: any) => <SelectItem key={s.id} value={String(s.id)}>{s.name}</SelectItem>)}
      </SelectContent>
    </Select>
    {isAdmin && <IptvLocalHostsTrigger onClick={() => setHostsOpen(true)} />}
    <Button onClick={() => setAddOpen(true)} disabled={!selectedConfigId}>
      <Plus className="h-4 w-4 mr-1.5" /> Add Playlist
    </Button>
  </>
)}
```

- [ ] **Step 3: Empty state — primary Add Playlist + secondary hint**

Replace the empty-state children with:

```tsx
<EmptyState
  icon={Tv}
  title="No IPTV playlists"
  description="Add an M3U/M3U8 playlist URL or upload a playlist file to browse channels and stream them into a TeamSpeak channel."
>
  <div className="flex flex-col items-center gap-3">
    <Button onClick={() => setAddOpen(true)} disabled={!selectedConfigId}>
      <Plus className="h-4 w-4 mr-1.5" /> Add Playlist
    </Button>
    {isAdmin && (
      <button
        type="button"
        className="text-xs text-muted-foreground underline-offset-4 hover:underline"
        onClick={() => setHostsOpen(true)}
      >
        Using Threadfin, xTeVe or TVHeadend? Allow its host first.
      </button>
    )}
  </div>
</EmptyState>
```

- [ ] **Step 4: Mount dialog; remove bottom card**

Remove:

```tsx
{isAdmin && <IptvLocalHostsCard />}
```

Add near other dialogs (still only useful for admins, but safe to mount when `isAdmin`):

```tsx
{isAdmin && <IptvLocalHostsDialog open={hostsOpen} onOpenChange={setHostsOpen} />}
```

- [ ] **Step 5: Delete the old card file**

```bash
git rm packages/frontend/src/components/iptv/IptvLocalHostsCard.tsx
```

Confirm no remaining imports:

```bash
rg "IptvLocalHostsCard" packages/frontend
```

Expected: no matches.

- [ ] **Step 6: Typecheck**

```bash
pnpm --filter frontend exec tsc -b --pretty false
```

Expected: PASS for these changes.

- [ ] **Step 7: Commit**

```bash
git add packages/frontend/src/pages/Iptv.tsx
git add packages/frontend/src/components/iptv/IptvLocalHostsCard.tsx
git commit -m "$(cat <<'EOF'
feat: open IPTV local hosts from header instead of page card

EOF
)"
```

---

### Task 3: Update Playwright coverage

**Files:**
- Modify: `packages/frontend/tests/iptv-local-hosts.spec.ts`

**Interfaces:**
- Consumes: header button role name `Local hosts`, dialog title `Local network sources`, label `Allowed local IPTV hosts`, button `Save hosts`

- [ ] **Step 1: Rewrite the e2e test for header → dialog → save**

Replace `packages/frontend/tests/iptv-local-hosts.spec.ts` with:

```ts
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

async function signIn(page: Page, request: APIRequestContext) {
  await request.post('/__test/reset');
  await request.post('/__test/docs?on');
  await request.post('/__test/auth?on');
  await page.goto('/login');
  await page.getByLabel('Username').fill('admin');
  await page.getByLabel('Password', { exact: true }).fill('test-password');
  await page.getByRole('button', { name: 'Sign In' }).click();
  await expect(page).toHaveURL('/dashboard');
}

test('admins can allow LAN IPTV hosts from the IPTV header', async ({ page, request }) => {
  let stored: string[] = [];
  const puts: unknown[] = [];
  await page.route('**/api/settings/iptv-network', async (route) => {
    if (route.request().method() === 'PUT') {
      const body = route.request().postDataJSON() as { allowedLocalHosts: string[] };
      puts.push(body);
      stored = body.allowedLocalHosts;
    }
    await route.fulfill({ json: { allowedLocalHosts: stored } });
  });

  await signIn(page, request);
  await page.goto('/iptv');

  // Editor is not always on the page
  await expect(page.getByLabel('Allowed local IPTV hosts')).toHaveCount(0);

  await page.getByRole('button', { name: 'Local hosts' }).click();
  await expect(page.getByRole('heading', { name: 'Local network sources' })).toBeVisible();

  const hosts = page.getByLabel('Allowed local IPTV hosts');
  await expect(page.getByRole('button', { name: 'Save hosts' })).toBeDisabled();
  await hosts.fill('192.168.1.20\nThreadfin.LAN, 192.168.1.20');
  await page.getByRole('button', { name: 'Save hosts' }).click();

  await expect.poll(() => puts.length).toBe(1);
  expect(puts[0]).toEqual({ allowedLocalHosts: ['192.168.1.20', 'threadfin.lan'] });
  await expect(page.getByText('Local IPTV hosts saved')).toBeVisible();
  await expect(hosts).toHaveValue('192.168.1.20\nthreadfin.lan');
  await expect(page.getByRole('button', { name: 'Save hosts' })).toBeDisabled();
});

test('empty state hint opens the local hosts dialog', async ({ page, request }) => {
  await page.route('**/api/settings/iptv-network', async (route) => {
    await route.fulfill({ json: { allowedLocalHosts: [] } });
  });
  await page.route('**/api/iptv/playlists*', async (route) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({ json: [] });
      return;
    }
    await route.continue();
  });

  await signIn(page, request);
  await page.goto('/iptv');

  await page.getByRole('button', {
    name: 'Using Threadfin, xTeVe or TVHeadend? Allow its host first.',
  }).click();

  await expect(page.getByRole('heading', { name: 'Local network sources' })).toBeVisible();
  await expect(page.getByLabel('Allowed local IPTV hosts')).toBeVisible();
});
```

Notes for implementers:

- If empty playlist list is not mocked by the second route path used in this app, adjust the route to whatever `useIptvPlaylists` hits (inspect network or `iptv.api.ts`). Keep the assertion: hint opens the same dialog.
- Prefer `getByRole('button', { name: /Local hosts/ })` if the count badge changes accessible name; then tighten with `{ exact: true }` only if needed.

- [ ] **Step 2: Run the Playwright file**

```bash
pnpm --filter frontend test -- tests/iptv-local-hosts.spec.ts
```

Expected: both tests PASS.

If the empty-state hint is a `<button>` with that full string as accessible name, good. If Playwright cannot find it, ensure the element is a real `button` (as in Task 2), not a styled `span`.

- [ ] **Step 3: Commit**

```bash
git add packages/frontend/tests/iptv-local-hosts.spec.ts
git commit -m "$(cat <<'EOF'
test: cover IPTV local hosts header dialog flow

EOF
)"
```

---

## Spec coverage checklist

| Spec requirement | Task |
|---|---|
| Remove always-visible hosts card | Task 2 |
| Admin header **Local hosts** left of Add Playlist | Task 2 |
| Tooltip copy | Task 1 (`title={TOOLTIP}`) |
| Count badge when `> 0` | Task 1 |
| Dialog with same textarea / Save / Reset / help | Task 1 |
| API unchanged | All (no backend edits) |
| Empty-state hint, no second primary button | Task 2 |
| Non-admins unchanged | Task 2 (`isAdmin` gates) |
| Playwright header → save | Task 3 |
| Not a playlist / Add Playlist tab | Non-goal; no task adds this |

## Out of scope (do not implement)

- Settings-only relocation
- Auto LAN discovery
- Contextual “allow this host?” on failed playlist URL
