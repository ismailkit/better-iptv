/**
 * Browser preview backend.
 *
 * The app's backend is the Rust side of Tauri: every `invoke` goes to it.
 * `npm run dev` on its own only serves the frontend, and opening that in a
 * normal browser tab has no `window.__TAURI_INTERNALS__`, so the first IPC
 * call throws "Cannot read properties of undefined (reading 'invoke')".
 *
 * In development, outside Tauri, this module answers the IPC calls in
 * memory instead: a generated demo provider (live channels in many
 * categories, movies, series, EPG and Home rows), or an M3U URL when the
 * provider allows cross-origin requests. Nothing plays (there is no MPV);
 * it exists to work on the UI. `npm run tauri dev` is the real thing.
 *
 * Imported first in main.tsx: other modules (the logger) call IPC while
 * they load.
 */
import { mockIPC } from '@tauri-apps/api/mocks';
import { emit } from '@tauri-apps/api/event';
import type { Channel, Playlist } from '../types';

type Args = Record<string, unknown> | undefined;
type Invoker = (cmd: string, args?: Record<string, unknown>, options?: unknown) => Promise<unknown>;

const STORE_KEY = 'browser-preview';

interface Persisted {
  playlists: Playlist[];
  activeId: number | null;
  favorites: number[];
  settings: Record<string, string>;
}

function load(): Persisted {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) return JSON.parse(raw) as Persisted;
  } catch {
    // Fall through to an empty store.
  }
  return { playlists: [], activeId: null, favorites: [], settings: {} };
}

function save(state: Persisted) {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(state));
  } catch {
    // Preview only; losing it means going through Setup again.
  }
}

// ---------- Demo data ----------

const LIVE_CATEGORIES: Array<[string, string[]]> = [
  ['News', ['World News', 'Business Live', 'News 24', 'Global Report', 'Politics Now']],
  ['Sports', ['Sport 1', 'Sport 2', 'Sport 3', 'Extreme', 'Golf', 'Tennis', 'Motors']],
  ['Football', ['Premier', 'La Liga', 'Serie A', 'Bundesliga', 'Ligue 1', 'Champions']],
  ['F1', ['F1 Live', 'F1 Onboard', 'F1 Pit Lane', 'F1 Data']],
  ['NBA', ['NBA League', 'NBA Classics', 'NBA TV']],
  ['Movies', ['Cinema 1', 'Cinema 2', 'Action', 'Comedy', 'Drama', 'Thriller', 'Classics']],
  ['Kids', ['Cartoons', 'Junior', 'Toons', 'Family', 'Animals Kids']],
  ['Documentary', ['Nature', 'History', 'Science', 'Discovery', 'Planet']],
  ['Music', ['Hits', 'Rock', 'Hip Hop', 'Classical', 'Jazz', '80s']],
  ['UK | Entertainment', ['One', 'Two', 'Three', 'Four', 'Gold', 'Dave', 'Drama']],
  ['US | Entertainment', ['ABC', 'NBC', 'CBS', 'FOX', 'AMC', 'HBO', 'Showtime', 'TNT']],
  ['Sweden', ['SVT1', 'SVT2', 'TV3', 'TV4', 'Kanal 5', 'TV6', 'Sjuan']],
  ['Norway', ['NRK1', 'NRK2', 'TV 2', 'TVNorge', 'TV3 NO']],
  ['France', ['TF1', 'France 2', 'France 3', 'M6', 'Arte', 'Canal+']],
  ['Germany', ['ARD', 'ZDF', 'RTL', 'SAT.1', 'ProSieben', 'VOX']],
  ['Spain', ['La 1', 'La 2', 'Antena 3', 'Cuatro', 'Telecinco']],
  ['Italy', ['Rai 1', 'Rai 2', 'Rai 3', 'Canale 5', 'Italia 1']],
  ['Arabic', ['MBC 1', 'MBC 2', 'MBC Action', 'Al Jazeera', 'Rotana']],
  ['Turkey', ['TRT 1', 'Show TV', 'Star TV', 'ATV', 'Kanal D']],
  ['India', ['Star Plus', 'Zee TV', 'Sony', 'Colors', 'NDTV']],
  ['4K UHD', ['UHD Nature', 'UHD Sports', 'UHD Movies']],
];

const MOVIE_GENRES = ['Action', 'Comedy', 'Drama', 'Thriller', 'Sci-Fi', 'Animation'];
const SERIES_GENRES = ['Crime', 'Drama', 'Comedy', 'Sci-Fi'];

const PROGRAMMES = [
  'Morning Briefing',
  'Live: Match Day',
  'The Big Interview',
  'Documentary Hour',
  'Evening News',
  'Late Show',
  'Classic Movie',
  'Highlights',
  'Weather',
  'Kids Club',
  'Top 40',
  'Talk of the Town',
  'Midnight Thriller',
  'Crime Files',
  'Premier League: Arsenal v Chelsea',
  'NBA: Celtics @ Lakers',
];

/** Guide genres for the demo matches, as XMLTV <category> gives them. */
const PROGRAMME_CATEGORIES: Record<string, string> = {
  'Premier League: Arsenal v Chelsea': 'Football',
  'NBA: Celtics @ Lakers': 'Basketball',
};

/** Demo ratings, as the backend reads them from XMLTV <rating> (see epg_domain). */
const PROGRAMME_AGES: Record<string, number> = {
  'Classic Movie': 12,
  'Late Show': 16,
  'Crime Files': 16,
  'Midnight Thriller': 18,
  'Kids Club': 3,
};

function demoChannels(): Channel[] {
  const out: Channel[] = [];
  let id = 1;
  for (const [group, names] of LIVE_CATEGORIES) {
    for (const name of names) {
      for (const suffix of ['', ' HD']) {
        out.push({
          id: id++,
          name: `${name}${suffix}`,
          group_name: group,
          epg_id: `demo.${id}`,
          content_type: 'live',
          is_favorite: false,
        });
      }
    }
  }
  for (const genre of MOVIE_GENRES) {
    for (let i = 1; i <= 14; i++) {
      out.push({
        id: id++,
        name: `${genre} Movie ${i} (20${10 + i})`,
        group_name: `Movies | ${genre}`,
        content_type: 'vod',
        is_favorite: false,
        created_at: new Date(Date.now() - id * 3_600_000).toISOString(),
      });
    }
  }
  for (const genre of SERIES_GENRES) {
    for (let i = 1; i <= 8; i++) {
      out.push({
        id: id++,
        name: `${genre} Series ${i}`,
        group_name: `Series | ${genre}`,
        content_type: 'series',
        is_favorite: false,
        created_at: new Date(Date.now() - id * 3_600_000).toISOString(),
      });
    }
  }
  return out;
}

// ---------- M3U (real providers, when CORS allows) ----------

function attr(line: string, name: string): string | undefined {
  const m = line.match(new RegExp(`${name}="([^"]*)"`, 'i'));
  return m?.[1] || undefined;
}

function parseM3u(text: string): Channel[] {
  const out: Channel[] = [];
  let pending: string | null = null;
  let id = 1;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('#EXTINF')) {
      pending = line;
    } else if (pending && line && !line.startsWith('#')) {
      const content_type = /\/movie\//i.test(line)
        ? 'vod'
        : /\/series\//i.test(line)
          ? 'series'
          : 'live';
      out.push({
        id: id++,
        name: pending.slice(pending.lastIndexOf(',') + 1).trim() || `Channel ${id}`,
        logo: attr(pending, 'tvg-logo'),
        group_name: attr(pending, 'group-title'),
        epg_id: attr(pending, 'tvg-id'),
        content_type,
        is_favorite: false,
      });
      pending = null;
    }
  }
  return out;
}

async function fetchM3u(url: string): Promise<Channel[]> {
  let text: string;
  try {
    const res = await globalThis.fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    text = await res.text();
  } catch (err) {
    throw new Error(
      `Browser preview could not download this playlist (${err instanceof Error ? err.message : err}). ` +
        'Most providers block browser requests (CORS). Type "demo" as the URL to load demo data, ' +
        'or run `npm run tauri dev` for the real backend.'
    );
  }
  const channels = parseM3u(text);
  if (channels.length === 0) throw new Error('No channels found in this playlist');
  return channels;
}

// ---------- Mock backend ----------

function install() {
  const state = load();
  let channels: Channel[] = [];
  let loadedFor: number | null = null;
  let playing = false;

  async function channelsFor(playlistId: number | undefined): Promise<Channel[]> {
    const id = playlistId ?? state.activeId;
    if (id == null) return [];
    if (loadedFor !== id) {
      const pl = state.playlists.find((p) => p.id === id);
      const src = pl?.url;
      channels = !src || src === 'demo' ? demoChannels() : await fetchM3u(src);
      loadedFor = id;
    }
    const favs = new Set(state.favorites);
    return channels.map((c) => ({ ...c, is_favorite: favs.has(c.id) }));
  }

  // Programme slots are 30-90 minutes, aligned to the half hour, stable per
  // channel so the guide and cards agree.
  function programmes(epgId: string, from: number, to: number) {
    const seed = [...epgId].reduce((a, ch) => a + ch.charCodeAt(0), 0);
    const slot = 30 * 60_000;
    const out: Array<{
      title: string;
      description: string;
      start_time: string;
      end_time: string;
      age: number | null;
    }> = [];
    let t = Math.floor(from / slot) * slot - slot * (seed % 3);
    let i = seed;
    while (t < to) {
      const len = slot * (1 + (i % 3));
      if (t + len > from) {
        const title = PROGRAMMES[i % PROGRAMMES.length];
        out.push({
          title,
          age: PROGRAMME_AGES[title] ?? null,
          description: 'Demo programme from the browser preview backend.',
          start_time: new Date(t).toISOString(),
          end_time: new Date(t + len).toISOString(),
        });
      }
      t += len;
      i += 7;
    }
    return out;
  }

  function card(c: Channel) {
    const genre = c.group_name?.split('|').pop()?.trim() ?? 'Drama';
    return {
      channel_id: c.id,
      tmdb_id: c.id,
      title: c.name.replace(/ \(\d{4}\)$/, ''),
      year: 2010 + (c.id % 15),
      rating: 5 + (c.id % 45) / 10,
      poster_url: null,
      backdrop_url: null,
      genres: [genre],
      overview: 'A demo title from the browser preview backend.',
    };
  }

  // ---------- Simulated in-app player ----------
  // A live stream whose edge advances in real time, a 15-minute rewind
  // buffer, two audio and two subtitle tracks. Emits `player-state` like the
  // backend does, four times a second.
  const sim = {
    timer: 0 as ReturnType<typeof setInterval> | 0,
    startedAt: 0,
    pos: 0,
    pause: false,
    volume: 100,
    mute: false,
    aid: 1 as number | string,
    sid: 'no' as number | string,
    speed: 1,
  };
  const liveEnd = () => 900 + (Date.now() - sim.startedAt) / 1000;
  const tracks = () => [
    { id: 1, type: 'video', codec: 'h264', selected: true, 'demux-w': 1920, 'demux-h': 1080 },
    {
      id: 1,
      type: 'audio',
      lang: 'eng',
      codec: 'aac',
      'demux-channel-count': 2,
      selected: sim.aid === 1,
    },
    {
      id: 2,
      type: 'audio',
      lang: 'spa',
      title: 'Commentary',
      codec: 'ac3',
      'demux-channel-count': 6,
      selected: sim.aid === 2,
    },
    { id: 1, type: 'sub', lang: 'eng', codec: 'subrip', selected: sim.sid === 1 },
    { id: 2, type: 'sub', lang: 'fra', codec: 'subrip', selected: sim.sid === 2 },
  ];
  const simState = () => {
    const end = liveEnd();
    return {
      'time-pos': sim.pos,
      pause: sim.pause,
      volume: sim.volume,
      mute: sim.mute,
      speed: sim.speed,
      aid: sim.aid,
      sid: sim.sid,
      seekable: true,
      'idle-active': false,
      loading: false,
      error: false,
      'track-list': tracks(),
      'demuxer-cache-state': {
        'seekable-ranges': [{ start: Math.max(0, end - 900), end }],
        'cache-end': end,
      },
      width: 1920,
      height: 1080,
    };
  };
  const simStart = () => {
    sim.startedAt = Date.now();
    sim.pos = 900;
    sim.pause = false;
    if (sim.timer) clearInterval(sim.timer);
    sim.timer = setInterval(() => {
      if (!sim.pause) sim.pos = Math.min(liveEnd(), sim.pos + 0.25 * sim.speed);
      void emit('player-state', simState());
    }, 250);
  };
  const simStop = () => {
    if (sim.timer) clearInterval(sim.timer);
    sim.timer = 0;
    void emit('player-state', { 'idle-active': true });
  };

  // ---------- Demo sports data ----------
  let quotaLeft = 97;
  const kickoff = Date.now() - 70 * 60_000; // second half, about 55'
  const team = (name: string, id: number) => ({ id, name, logo: null });
  const demoMatch = (home: string, away: string) => {
    const H = team(home, 1);
    const A = team(away, 2);
    const minute = Math.min(90, Math.floor((Date.now() - kickoff) / 60_000) - 15);
    const events = [
      { time: '12', type: 'Yellow Card', team: A, player: 'R. James' },
      { time: '23', type: 'Goal', team: H, player: 'B. Saka', assist: 'M. Ødegaard' },
      { time: '41', type: 'Goal', team: A, player: 'C. Palmer', assist: 'N. Jackson' },
      { time: '45+2', type: 'Yellow Card', team: H, player: 'D. Rice' },
      { time: '52', type: 'Goal', team: H, player: 'K. Havertz', assist: 'B. Saka' },
      { time: '54', type: 'Substitution', team: A, player: 'M. Mudryk', substituted: 'P. Neto' },
      { time: '58', type: 'Red Card', team: A, player: 'M. Caicedo' },
      { time: '63', type: 'VAR', team: H, player: 'G. Martinelli' },
      { time: '68', type: 'Missed Penalty', team: H, player: 'B. Saka' },
    ].filter((e) => parseInt(e.time, 10) <= minute);
    const goals = events.filter((e) => e.type === 'Goal');
    const hg = goals.filter((e) => e.team === H).length;
    const ag = goals.length - hg;
    const stat = (displayName: string, h: number, a: number) => [
      { displayName, value: h },
      { displayName, value: a },
    ];
    const rows = [
      stat('Possession', 0.58, 0.42),
      stat('Shots total', 14, 7),
      stat('Shots on target', 6, 3),
      stat('Corners', 7, 2),
      stat('Fouls', 9, 13),
      stat('Passes accuracy', 0.88, 0.81),
      stat('Expected goals', 1.9, 0.8),
    ];
    return {
      id: 4242,
      date: new Date(kickoff).toISOString(),
      round: 'Regular Season - 8',
      league: { id: 39, name: 'Premier League', logo: null, season: 2026 },
      country: { code: 'GB', name: 'England', logo: null },
      homeTeam: {
        ...H,
        topPlayers: [
          {
            name: 'B. Saka',
            position: 'Forward',
            statistics: [
              { name: 'Goals', value: 1 },
              { name: 'Assists', value: 1 },
            ],
          },
        ],
      },
      awayTeam: {
        ...A,
        topPlayers: [
          { name: 'C. Palmer', position: 'Midfielder', statistics: [{ name: 'Goals', value: 1 }] },
        ],
      },
      state: {
        description: 'Second half',
        clock: minute,
        score: { current: `${hg} - ${ag}`, penalties: null },
      },
      events,
      statistics: [
        { team: H, statistics: rows.map((r) => r[0]) },
        { team: A, statistics: rows.map((r) => r[1]) },
      ],
      venue: { name: 'Emirates Stadium', city: 'London', country: 'England', capacity: '60704' },
      referee: { name: 'M. Oliver', nationality: 'England' },
      forecast: { status: 'Clear', temperature: '14°C' },
      predictions: {
        prematch: [
          {
            probabilities: { home: '48%', draw: '27%', away: '25%' },
            description: `${home} are slight favourites.`,
          },
        ],
        live: [
          {
            probabilities: { home: '71%', draw: '19%', away: '10%' },
            description: `${home} lead and have an extra player.`,
          },
        ],
      },
      news: [],
    };
  };
  const lineup = (name: string) => ({
    name,
    logo: null,
    formation: '4-3-3',
    initialLineup: Array.from({ length: 11 }, (_, i) => ({
      name: `${name} Player ${i + 1}`,
      number: i + 1,
      position: i === 0 ? 'Goalkeeper' : i < 5 ? 'Defender' : i < 8 ? 'Midfielder' : 'Forward',
    })),
    substitutes: Array.from({ length: 7 }, (_, i) => ({
      name: `${name} Sub ${i + 1}`,
      number: 12 + i,
    })),
  });
  let lastMatch: { home: string; away: string } = { home: 'Arsenal', away: 'Chelsea' };
  const spend = () => {
    quotaLeft = Math.max(0, quotaLeft - 1);
  };

  const handlers: Record<string, (a: Args) => unknown> = {
    check_mpv_installed: () => true,
    play_channel: () => {
      playing = true;
      simStart();
    },
    stop_playback: () => {
      playing = false;
      simStop();
    },
    player_capabilities: () => ({ embedded_supported: true, embedded: true }),
    player_set_rect: () => undefined,
    player_set_property: (a) => {
      const name = String(a?.name);
      const v = a?.value as never;
      if (name === 'pause') sim.pause = Boolean(v);
      if (name === 'volume') sim.volume = Number(v);
      if (name === 'mute') sim.mute = Boolean(v);
      if (name === 'speed') sim.speed = Number(v);
      if (name === 'aid') sim.aid = v;
      if (name === 'sid') sim.sid = v === 'auto' ? 1 : v;
      void emit('player-state', simState());
    },
    player_seek: (a) => {
      const v = Number(a?.value);
      const end = liveEnd();
      const target = String(a?.mode).startsWith('absolute') ? v : sim.pos + v;
      sim.pos = Math.min(end, Math.max(end - 900, target));
      void emit('player-state', simState());
    },
    player_frame_step: () => {
      sim.pause = true;
    },
    sports_quota: () => ({ has_key: true, remaining: quotaLeft, limit: 100 }),
    sports_set_key: () => undefined,
    sports_find_match: (a) => {
      spend();
      lastMatch = { home: String(a?.home), away: String(a?.away) };
      // /matches answers carry the fixture only; details come from /matches/{id}.
      const { id, date, round, league, country, homeTeam, awayTeam, state } = demoMatch(
        lastMatch.home,
        lastMatch.away
      );
      return { id, date, round, league, country, homeTeam, awayTeam, state };
    },
    sports_match: () => {
      spend();
      return demoMatch(lastMatch.home, lastMatch.away);
    },
    sports_highlights: () => {
      spend();
      return [
        {
          id: 1,
          title: `${lastMatch.home} vs ${lastMatch.away}: first-half highlights`,
          url: 'https://highlightly.net',
          imgUrl: null,
          source: 'youtube',
          channel: 'Demo',
        },
        {
          id: 2,
          title: 'Goal: K. Havertz header',
          url: 'https://highlightly.net',
          imgUrl: null,
          source: 'twitter',
          channel: 'Demo',
        },
      ];
    },
    sports_lineups: () => {
      spend();
      return { homeTeam: lineup(lastMatch.home), awayTeam: lineup(lastMatch.away) };
    },
    playback_status: () => ({ playing, failed: false }),
    play_series_episodes: () => {
      playing = true;
      simStart();
    },
    play_episode_with_season: () => {
      playing = true;
      simStart();
    },

    import_playlist: async (a) => {
      const source = String(a?.source ?? '').trim();
      const id = Math.max(0, ...state.playlists.map((p) => p.id ?? 0)) + 1;
      const isDemo = source === '' || /^demo$/i.test(source);
      const playlist: Playlist = {
        id,
        name: String(a?.name || (isDemo ? 'Demo' : 'Playlist')),
        url: isDemo ? 'demo' : source,
        auto_refresh: false,
        last_updated: new Date().toISOString(),
      };
      // Validate before saving, so a CORS failure leaves Setup as it was.
      if (!isDemo) await fetchM3u(source);
      state.playlists.push(playlist);
      state.activeId = id;
      save(state);
      return playlist;
    },
    import_xtream_playlist: () => {
      throw new Error(
        'Xtream login needs the real backend: run `npm run tauri dev`. ' +
          'In the browser preview, use M3U with the URL "demo".'
      );
    },
    get_playlists: () => state.playlists,
    delete_playlist: (a) => {
      state.playlists = state.playlists.filter((p) => p.id !== a?.id);
      if (state.activeId === a?.id) state.activeId = state.playlists[0]?.id ?? null;
      save(state);
    },
    rename_playlist: (a) => {
      const p = state.playlists.find((x) => x.id === a?.playlistId);
      if (p) p.name = String(a?.newName);
      save(state);
    },
    get_active_profile_id: () => state.activeId,
    set_active_profile_id: (a) => {
      state.activeId = Number(a?.profileId);
      save(state);
    },
    get_subscription_expiry: () => null,
    refresh_playlist: () => ({ added: 0, updated: 0, removed: 0 }),
    get_stale_playlist_ids: () => [],
    get_playlist_channel_counts: () =>
      Object.fromEntries(state.playlists.map((p) => [String(p.id), channels.length])),

    get_channels: (a) => channelsFor(a?.playlistId as number | undefined),
    get_favorites: async () => (await channelsFor(undefined)).filter((c) => c.is_favorite),
    toggle_favorite: (a) => {
      const id = Number(a?.channelId);
      state.favorites = state.favorites.includes(id)
        ? state.favorites.filter((f) => f !== id)
        : [...state.favorites, id];
      save(state);
    },
    get_channel_groups: async (a) => {
      const list = await channelsFor(a?.playlistId as number);
      const type = a?.contentType as string | undefined;
      const seen = new Set<string>();
      for (const c of list) {
        if (type && c.content_type !== type) continue;
        if (c.group_name) seen.add(c.group_name);
      }
      return [...seen];
    },
    get_xtream_series_id: () => null,
    get_local_series_info: () => ({
      seasons: [{ id: '1', name: 'Season 1', season_number: '1', episode_count: 6 }],
      info: {},
      episodes: {
        '1': Array.from({ length: 6 }, (_, i) => ({
          id: String(100000 + i),
          episode_num: i + 1,
          title: `Episode ${i + 1}`,
          container_extension: 'mkv',
          season: 1,
          info: {},
        })),
      },
    }),

    get_setting: (a) => state.settings[String(a?.key)] ?? null,
    set_setting: (a) => {
      state.settings[String(a?.key)] = String(a?.value);
      save(state);
    },

    fetch_epg_data: () => 0,
    get_channel_epg: (a) => {
      const now = Date.now();
      const p = programmes(String(a?.channelEpgId), now, now + 3 * 3_600_000);
      return [p[0]?.title ?? null, p[1]?.title ?? null];
    },
    get_channels_epg: (a) => {
      const now = Date.now();
      const out: Record<string, unknown> = {};
      for (const id of (a?.epgIds as string[]) ?? []) {
        // Roughly one channel in six has no guide data, as with real providers.
        if (id.length % 6 === 0) continue;
        const [cur, next] = programmes(id, now, now + 3 * 3_600_000);
        out[id] = {
          current: cur?.title ?? null,
          current_start: cur?.start_time ?? null,
          current_end: cur?.end_time ?? null,
          next: next?.title ?? null,
          next_start: next?.start_time ?? null,
          current_age: (cur && PROGRAMME_AGES[cur.title]) ?? null,
          current_category: (cur && PROGRAMME_CATEGORIES[cur.title]) ?? null,
        };
      }
      return out;
    },
    get_guide: (a) => {
      const from = Date.parse(String(a?.from));
      const to = Date.parse(String(a?.to));
      return Object.fromEntries(
        ((a?.epgIds as string[]) ?? []).map((id) => [id, programmes(id, from, to)])
      );
    },
    get_current_ages: () => {
      const now = Date.now();
      const out: Record<string, number> = {};
      for (const c of channels) {
        if (c.content_type !== 'live' || !c.epg_id) continue;
        const [cur] = programmes(c.epg_id, now, now + 60_000);
        const age = cur && PROGRAMME_AGES[cur.title];
        if (age) out[c.epg_id.toLowerCase()] = age;
      }
      return out;
    },
    get_guide_epg_ids: () =>
      channels.filter((c) => c.content_type === 'live' && c.epg_id).map((c) => c.epg_id!),
    get_epg_status: () => ({
      has_url: true,
      last_fetched: new Date().toISOString(),
      program_count: 1000,
    }),
    force_refresh_epg: () => ({
      success: true,
      programs_loaded: 1000,
      timestamp: new Date().toISOString(),
      error: null,
    }),

    set_parental_pin: () => undefined,
    verify_parental_pin: () => true,
    reset_parental_pin: () => undefined,
    get_blocked_channels: () => [],
    set_blocked_channels: () => undefined,
    get_parental_settings: () => ({
      enabled: false,
      has_pin: false,
      auto_detect: false,
      blocked_channels: [],
      blocked_categories: [],
      unlock_duration: '15m',
      visibility: 'hide',
    }),

    check_for_update: () => null,

    get_tmdb_status: () => ({
      enabled: true,
      has_user_key: true,
      has_shared_key: true,
      user_key_rejected: false,
      shared_key_rejected: false,
      language: 'en-US',
      background_enrich: true,
      background_progress: null,
    }),
    get_tmdb_cards: (a) => {
      const ids = new Set((a?.channelIds as number[]) ?? []);
      return channels.filter((c) => ids.has(c.id) && c.content_type !== 'live').map(card);
    },
    get_tmdb_details: (a) => {
      const c = channels.find((x) => x.id === a?.channelId);
      const k = c ? card(c) : null;
      return {
        available: true,
        matched: Boolean(k),
        manual: false,
        tmdb_id: k?.tmdb_id ?? null,
        title: k?.title ?? null,
        original_title: k?.title ?? null,
        year: k?.year ?? null,
        rating: k?.rating ?? null,
        poster_url: null,
        backdrop_url: null,
        overview: k?.overview ?? null,
        runtime_minutes: 110,
        genres: k?.genres ?? [],
        cast: [],
        trailer_url: null,
      };
    },
    get_tmdb_season: () => [],
    get_home_rows: () => {
      const rows: unknown[] = [];
      for (const [type, genres] of [
        ['vod', MOVIE_GENRES],
        ['series', SERIES_GENRES],
      ] as const) {
        for (const genre of genres) {
          const items = channels
            .filter((c) => c.content_type === type && c.group_name?.endsWith(genre))
            .slice(0, 12)
            .map(card);
          if (items.length) rows.push({ genre, content_type: type, items });
        }
      }
      return rows;
    },
    get_home_pick: () => {
      const c = channels.find((x) => x.content_type === 'vod');
      return c ? { item: card(c), source: 'trending' } : null;
    },
    search_tmdb: () => [],
    set_tmdb_match: (a) => handlers.get_tmdb_details(a),
    delete_tmdb_cache: () => 0,
    check_tmdb_key: () => undefined,
  };

  // No MPV draws under the page here: paint the "video" area so the
  // player's layout can be judged.
  document.documentElement.classList.add('browser-preview');
  const style = document.createElement('style');
  style.textContent = `html.browser-preview.video-hole, html.browser-preview.video-full {
    background: radial-gradient(circle at 30% 40%, #2a6b3c, #0d2a17 60%, #050d08) fixed !important; }`;
  document.head.appendChild(style);

  mockIPC(
    (cmd, payload) => {
      const handler = handlers[cmd];
      if (handler) return handler(payload as Args);
      // Plugins (log, opener, app, path) and anything new: answer quietly.
      if (cmd === 'plugin:app|version') return '0.0.0-preview';
      if (cmd === 'plugin:path|resolve_directory') return '/';
      return null;
    },
    { shouldMockEvents: true }
  );

  // The mock removes listeners by `id`, but this API version unlistens with
  // `eventId`: without this, unmounted listeners stay registered and every
  // emit warns about a missing callback.
  const internals = (window as unknown as { __TAURI_INTERNALS__: { invoke: Invoker } })
    .__TAURI_INTERNALS__;
  const invokeMock = internals.invoke;
  internals.invoke = (cmd, args, options) =>
    invokeMock(
      cmd,
      cmd === 'plugin:event|unlisten' && args ? { ...args, id: args.eventId } : args,
      options
    );

  // eslint-disable-next-line no-console -- the one notice that the backend is simulated
  console.info(
    '%c[browser preview]%c No Tauri backend: IPC answered by src/lib/browserPreview.ts. ' +
      'Use M3U URL "demo" in Setup. Run `npm run tauri dev` for the real app.',
    'color:#F2B441;font-weight:bold',
    ''
  );
}

/** True when this module stands in for the backend (dev build, plain browser tab). */
export const isBrowserPreview =
  import.meta.env.DEV &&
  import.meta.env.MODE !== 'test' &&
  typeof window !== 'undefined' &&
  !('__TAURI_INTERNALS__' in window);

if (isBrowserPreview) install();
