import { expect, test, type Page, type Route } from '@playwright/test';

const token = 't'.repeat(43);
const session = 's'.repeat(43);
const voteId = 'v'.repeat(22);

const playlist = { id: 3, name: 'Late Night Drive', trackCount: 3, duration: 600, wholeRequest: true };
const songs = [1, 2, 3].map((n) => ({ id: n, title: `Drive ${n}`, artist: 'Northline', duration: 200 }));

const settings = { voting: true, thresholdPercent: 80, windowSeconds: 60, maxTracks: 25 };

function openVote(over: Record<string, unknown> = {}) {
  return {
    id: voteId,
    status: 'open',
    reason: null,
    playlist: { id: 3, name: playlist.name, trackCount: 3 },
    yes: 1,
    no: 0,
    needed: 4,
    listeners: 5,
    thresholdPercent: 80,
    deadline: new Date(Date.now() + 45_000).toISOString(),
    ownBallot: null,
    isRequester: false,
    ...over,
  };
}

function baseState(over: Record<string, unknown> = {}, permissions: Record<string, unknown> = {}) {
  return {
    bot: { id: 12, name: 'Aurora Radio', status: 'playing' },
    nowPlaying: { id: '1', title: 'Glass Harbor', artist: 'Northline', duration: 180 },
    upNext: [],
    upNextCount: 0,
    permissions: {
      searchLibrary: true,
      addToQueue: true,
      requestUrl: false,
      browsePlaylists: true,
      requestPlaylist: true,
      vote: true,
      ...permissions,
    },
    playlistRequests: settings,
    limits: { maxRequestSeconds: 900 },
    vote: null,
    ...over,
  };
}

function remote(path: string): RegExp {
  return new RegExp(`/api/listener-remote${path}(\\?.*)?$`);
}

async function fulfill(route: Route, body: unknown, status = 200, headers: Record<string, string> = {}) {
  await route.fulfill({ status, contentType: 'application/json', headers, body: JSON.stringify(body) });
}

async function noHorizontalOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true);
}

type Reply = { status?: number; body: unknown; headers?: Record<string, string> };

/** A remote whose `/state` is whatever `current.state` holds at the time of the poll. */
async function openRemote(page: Page, state: unknown, handlers: {
  request?: () => Reply;
  ballot?: (method: string, body: unknown) => Reply;
  cancel?: () => Reply;
} = {}) {
  const current = { state, stateCalls: 0 };
  const calls: Array<{ method: string; path: string; body: unknown }> = [];
  const record = (route: Route) => {
    const request = route.request();
    const url = new URL(request.url());
    calls.push({ method: request.method(), path: url.pathname.replace('/api/listener-remote', ''), body: request.postDataJSON() });
  };
  await page.route(remote('/exchange'), (route) => fulfill(route, {
    session,
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
    botId: 12,
  }));
  await page.route(remote('/state'), (route) => {
    current.stateCalls += 1;
    return fulfill(route, current.state);
  });
  await page.route(remote('/library'), (route) => fulfill(route, { songs: [], page: 1, pageSize: 25 }));
  await page.route(remote('/playlists'), (route) => fulfill(route, { playlists: [playlist], page: 1, pageSize: 25 }));
  await page.route(remote('/playlists/3/songs'), (route) => fulfill(route, { playlist, songs, page: 1, pageSize: 25 }));
  await page.route(remote('/playlist-requests'), (route) => {
    record(route);
    const reply = handlers.request?.() ?? { body: { ok: true, outcome: 'vote', created: true, vote: openVote({ isRequester: true, ownBallot: 'yes' }) } };
    return fulfill(route, reply.body, reply.status, reply.headers);
  });
  await page.route(remote(`/votes/${voteId}/ballot`), (route) => {
    record(route);
    const reply = handlers.ballot?.(route.request().method(), route.request().postDataJSON()) ?? { body: { ok: true, vote: openVote() } };
    return fulfill(route, reply.body, reply.status, reply.headers);
  });
  await page.route(remote(`/votes/${voteId}`), (route) => {
    record(route);
    const reply = handlers.cancel?.() ?? { body: { ok: true } };
    return fulfill(route, reply.body, reply.status, reply.headers);
  });
  await page.goto(`/remote#token=${token}`);
  await expect(page.getByRole('heading', { name: 'Aurora Radio' })).toBeVisible();
  return { current, calls };
}

async function openPlaylist(page: Page) {
  await page.getByRole('button', { name: /Late Night Drive/ }).click();
  await expect(page.getByRole('heading', { name: playlist.name })).toBeVisible();
  await expect(page.getByText('Drive 1')).toBeVisible();
}

function banner(page: Page) {
  return page.getByTestId('vote-banner');
}

test.beforeEach(async ({ request }) => {
  await request.post('/__test/reset');
});

test('phone: propose a playlist, see the vote, and cancel it', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  const { current, calls } = await openRemote(page, baseState());
  await openPlaylist(page);
  await expect(page.getByText(/Starts a 60-second vote in the channel\. Your yes counts, and it passes when 80% of listeners vote yes\./)).toBeVisible();

  current.state = baseState({ vote: openVote({ isRequester: true, ownBallot: 'yes' }) });
  await page.getByRole('button', { name: 'Propose this playlist' }).click();
  expect(calls[0]).toEqual({ method: 'POST', path: '/playlist-requests', body: { playlistId: 3 } });

  const vote = banner(page);
  await expect(vote).toBeFocused();
  await expect(vote.getByRole('heading', { name: 'Playlist vote' })).toBeVisible();
  await expect(vote.getByText('Play “Late Night Drive” (3 songs)?')).toBeVisible();
  await expect(vote.getByText('1 yes · 0 no · needs 4 of 5 listeners')).toBeVisible();
  await expect(vote.getByRole('timer')).toHaveText(/^\d+ s left$/);
  await expect(vote.getByText('You proposed this playlist, so your yes is already counted.')).toBeVisible();
  await expect(vote.locator('[aria-live="polite"]')).toHaveText(/Your playlist vote started for “Late Night Drive”/);
  // The requester has no Yes/No: their yes is automatic and their "no" is Cancel.
  await expect(vote.getByRole('button', { name: 'Yes' })).toHaveCount(0);
  // Another vote cannot be proposed while this one runs.
  await expect(page.getByRole('button', { name: 'Propose this playlist' })).toBeDisabled();
  await expect(page.getByText(/A playlist vote is running/)).toBeVisible();

  const cancel = vote.getByRole('button', { name: 'Cancel vote' });
  const size = await cancel.boundingBox();
  expect(size?.height).toBeGreaterThanOrEqual(44);
  await noHorizontalOverflow(page);

  current.state = baseState({ vote: openVote({ isRequester: true, status: 'cancelled', reason: 'requester_cancelled' }) });
  await cancel.click();
  expect(calls[1]).toEqual({ method: 'DELETE', path: `/votes/${voteId}`, body: null });
  await expect(vote.getByRole('heading', { name: 'Playlist vote ended' })).toBeVisible();
  await expect(vote.getByTestId('vote-result')).toHaveText('You cancelled the vote.');
  await expect(vote.getByRole('timer')).toHaveCount(0);
});

test('desktop: another listener votes with the keyboard, changes and withdraws', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  let tally = openVote();
  const { current, calls } = await openRemote(page, baseState({ vote: tally }), {
    ballot: (method, body) => {
      const choice = method === 'DELETE' ? null : (body as { choice: 'yes' | 'no' }).choice;
      tally = openVote({ ownBallot: choice, yes: choice === 'yes' ? 2 : 1, no: choice === 'no' ? 1 : 0 });
      current.state = baseState({ vote: tally });
      return { body: { ok: true, vote: tally } };
    },
  });

  const vote = banner(page);
  await expect(vote.locator('[aria-live="polite"]')).toHaveText(/A playlist vote started: play “Late Night Drive”\?/);
  // The banner spans both desktop columns above playback and the add controls.
  const bannerBox = await vote.boundingBox();
  const nowBox = await page.getByRole('heading', { name: 'Now playing' }).boundingBox();
  expect(bannerBox!.y).toBeLessThan(nowBox!.y);
  expect(bannerBox!.width).toBeGreaterThan(900);

  const group = vote.getByRole('group', { name: 'Vote on “Late Night Drive”' });
  const yes = group.getByRole('button', { name: 'Yes' });
  const no = group.getByRole('button', { name: 'No' });
  await expect(yes).toHaveAttribute('aria-pressed', 'false');
  await yes.focus();
  await page.keyboard.press('Enter');
  await expect(yes).toHaveAttribute('aria-pressed', 'true');
  await expect(vote.getByText('2 yes · 0 no · needs 4 of 5 listeners')).toBeVisible();
  await expect(vote.getByText('You voted yes. You can change your vote until it closes.')).toBeVisible();
  await expect(vote.locator('[aria-live="polite"]')).toHaveText('You voted yes.');

  await page.keyboard.press('Tab');
  await expect(no).toBeFocused();
  await page.keyboard.press('Space');
  await expect(no).toHaveAttribute('aria-pressed', 'true');
  await expect(yes).toHaveAttribute('aria-pressed', 'false');

  await vote.getByRole('button', { name: 'Withdraw my vote' }).click();
  await expect(vote.getByRole('button', { name: 'Withdraw my vote' })).toHaveCount(0);
  await expect(vote.locator('[aria-live="polite"]')).toHaveText('Your vote was withdrawn.');

  expect(calls.map((c) => [c.method, c.path, c.body])).toEqual([
    ['PUT', `/votes/${voteId}/ballot`, { choice: 'yes' }],
    ['PUT', `/votes/${voteId}/ballot`, { choice: 'no' }],
    ['DELETE', `/votes/${voteId}/ballot`, null],
  ]);
  await noHorizontalOverflow(page);
});

test('a deciding yes shows the result at once', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  const passed = openVote({ status: 'passed', reason: 'approved', yes: 4, ownBallot: 'yes' });
  const { current } = await openRemote(page, baseState({ vote: openVote({ yes: 3 }) }), {
    ballot: () => {
      current.state = baseState({ vote: passed });
      return { body: { ok: true, vote: passed } };
    },
  });
  await banner(page).getByRole('button', { name: 'Yes' }).click();
  await expect(banner(page).getByTestId('vote-result')).toHaveText('Vote passed. 3 songs from “Late Night Drive” were added to the queue.');
  await expect(banner(page).locator('[aria-live="polite"]')).toHaveText('Vote passed. 3 songs from “Late Night Drive” were added to the queue.');
  await expect(banner(page).getByRole('button')).toHaveCount(0);
});

test('closed votes explain why they ended', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  const { current } = await openRemote(page, baseState({ vote: openVote({ status: 'failed', reason: 'deadline' }) }));
  await expect(banner(page).getByTestId('vote-result')).toHaveText('Vote failed. Not enough listeners voted yes for “Late Night Drive” in time.');
  current.state = baseState({ vote: openVote({ id: 'w'.repeat(22), status: 'cancelled', reason: 'requester_left' }) });
  await expect(banner(page).getByTestId('vote-result')).toHaveText(/cancelled because the person who proposed it left the channel/, { timeout: 8_000 });
  current.state = baseState();
  await expect(banner(page)).toHaveCount(0, { timeout: 8_000 });
});

test('at zero the remote asks for the result instead of waiting for the next poll', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  const { current } = await openRemote(page, baseState({ vote: openVote({ deadline: new Date(Date.now() - 1_000).toISOString() }) }));
  await expect(banner(page).getByRole('timer')).toHaveText('Closing…');
  await expect.poll(() => current.stateCalls, { timeout: 3_000 }).toBeGreaterThanOrEqual(2);
});

test('people who cannot vote see why', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await openRemote(page, baseState({ vote: openVote() }, { vote: false }));
  await expect(banner(page).getByText("Only listeners in the bot's channel can vote.")).toBeVisible();
  await expect(banner(page).getByRole('button')).toHaveCount(0);
});

test('voting off adds the whole playlist straight away', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  const { calls } = await openRemote(page, baseState({ playlistRequests: { ...settings, voting: false } }), {
    request: () => ({ body: { ok: true, outcome: 'queued', trackCount: 3 } }),
  });
  await openPlaylist(page);
  await expect(page.getByText('Adds all 3 songs to the queue.')).toBeVisible();
  await page.getByRole('button', { name: 'Add all 3 songs' }).click();
  await expect(page.getByText('Added 3 songs from “Late Night Drive” to the queue.')).toBeVisible();
  await expect(banner(page)).toHaveCount(0);
  expect(calls).toHaveLength(1);
});

test('limits and permissions are explained before anyone asks', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  const { current } = await openRemote(page, baseState({ playlistRequests: { ...settings, maxTracks: 2 } }));
  await openPlaylist(page);
  await expect(page.getByText('Whole-playlist requests are limited to 2 songs. This playlist has 3.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Propose this playlist' })).toBeDisabled();

  current.state = baseState({}, { requestPlaylist: false });
  await page.getByRole('button', { name: 'Back to playlists' }).click();
  await expect.poll(() => current.stateCalls).toBeGreaterThan(1);
  await openPlaylist(page);
  await expect(page.getByText('You can add songs one at a time. Requesting the whole playlist is not allowed for you.')).toBeVisible({ timeout: 8_000 });
  await expect(page.getByRole('button', { name: 'Propose this playlist' })).toHaveCount(0);
});

test('browse-only playlists say so', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await openRemote(page, baseState());
  await page.unroute(remote('/playlists/3/songs'));
  await page.route(remote('/playlists/3/songs'), (route) => fulfill(route, { playlist: { ...playlist, wholeRequest: false }, songs, page: 1, pageSize: 25 }));
  await openPlaylist(page);
  await expect(page.getByText('You can add songs from this playlist one at a time. The whole playlist cannot be requested.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Propose this playlist' })).toHaveCount(0);
});

test('refusals give a plain reason and a wait time', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  let reply: Reply = { status: 409, body: { error: 'A playlist vote is already running.', code: 'vote_running' } };
  await openRemote(page, baseState(), { request: () => reply });
  await openPlaylist(page);
  const propose = page.getByRole('button', { name: 'Propose this playlist' });

  await propose.click();
  const alert = page.getByRole('alert');
  await expect(alert).toHaveText('Another playlist vote is running in this channel. Wait for it to finish.');
  await expect(alert).toBeFocused();

  reply = { status: 429, body: { error: 'Too many remote requests', code: 'rate_limited' }, headers: { 'Retry-After': '95' } };
  await propose.click();
  await expect(page.getByRole('alert')).toHaveText('Playlist requests are paused right now. Try again in about 2 minutes.');

  reply = { status: 422, body: { error: 'Playlist requests are limited to 25 tracks.', code: 'request_too_large' } };
  await propose.click();
  await expect(page.getByRole('alert')).toHaveText('Playlist requests are limited to 25 tracks.');
});

test('a vote that already ended answers clearly', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await openRemote(page, baseState({ vote: openVote() }), {
    ballot: () => ({ status: 404, body: { error: 'Vote not found.', code: 'not_found' } }),
  });
  await banner(page).getByRole('button', { name: 'Yes' }).click();
  await expect(banner(page).getByRole('alert')).toHaveText('This vote has already ended.');
});

test('an expired session while voting returns to the link prompt', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await openRemote(page, baseState({ vote: openVote() }), {
    ballot: () => ({ status: 401, body: { error: 'Remote access is invalid or expired', code: 'invalid_access' } }),
  });
  await banner(page).getByRole('button', { name: 'Yes' }).click();
  await expect(page.getByText(/Type !remote/)).toBeVisible();
  await expect(banner(page)).toHaveCount(0);
});

test('the vote banner raises no CSP violations and stores nothing', async ({ page }) => {
  const cspHits: string[] = [];
  page.on('console', (msg) => {
    if (/content security policy/i.test(msg.text())) cspHits.push(msg.text());
  });
  await page.setViewportSize({ width: 1280, height: 800 });
  await openRemote(page, baseState({ vote: openVote({ yes: 2 }) }));
  await expect(banner(page).getByText('2 yes · 0 no · needs 4 of 5 listeners')).toBeVisible();
  const stored = await page.evaluate((secrets) => {
    const dump = JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } });
    return secrets.some((secret) => dump.includes(secret));
  }, [token, session, voteId]);
  expect(stored).toBe(false);
  expect(cspHits).toEqual([]);
});
