import type { JellyfinLibraryItemExtended } from '@server/api/jellyfin';
import type TheMovieDb from '@server/api/themoviedb';
import { MediaType } from '@server/constants/media';
import {
  buildWatchHistory,
  rankRecommendations,
  type WatchHistory,
} from '@server/lib/recommendations';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const NOW = new Date('2026-01-01T00:00:00Z').getTime();
const daysAgo = (days: number) => new Date(NOW - days * 864e5).toISOString();

const item = (
  init: Partial<JellyfinLibraryItemExtended>
): JellyfinLibraryItemExtended =>
  ({
    Name: 'Item',
    Id: 'id',
    HasSubtitles: false,
    Type: 'Movie',
    LocationType: 'FileSystem',
    MediaType: 'Video',
    ProviderIds: {},
    ...init,
  }) as JellyfinLibraryItemExtended;

const weightOf = (history: WatchHistory, type: MediaType, tmdbId: number) =>
  history.seeds.find((s) => s.mediaType === type && s.tmdbId === tmdbId)
    ?.weight;

describe('buildWatchHistory', () => {
  it('weights recent and rewatched movies higher', () => {
    const history = buildWatchHistory({
      movies: [
        item({
          Id: 'a',
          ProviderIds: { Tmdb: '1' },
          UserData: { PlayCount: 1, LastPlayedDate: daysAgo(0) },
        }),
        item({
          Id: 'b',
          ProviderIds: { Tmdb: '2' },
          UserData: { PlayCount: 1, LastPlayedDate: daysAgo(90) },
        }),
        item({
          Id: 'c',
          ProviderIds: { Tmdb: '3' },
          UserData: { PlayCount: 4, LastPlayedDate: daysAgo(0) },
        }),
        item({ Id: 'no-tmdb', UserData: { PlayCount: 1 } }),
      ],
      episodes: [],
      series: [],
      favorites: [],
      now: NOW,
    });

    assert.equal(history.seeds.length, 3);
    assert.equal(weightOf(history, MediaType.MOVIE, 1), 1);
    assert.equal(weightOf(history, MediaType.MOVIE, 2), 0.5);
    assert.equal(weightOf(history, MediaType.MOVIE, 3), 2);
    assert.ok(history.watched.has('movie:1'));
  });

  it('aggregates episodes into their series', () => {
    const history = buildWatchHistory({
      movies: [],
      episodes: [
        ...Array.from({ length: 7 }, (_, i) =>
          item({
            Id: `ep${i}`,
            Type: 'Episode',
            SeriesId: 'binged',
            UserData: { LastPlayedDate: daysAgo(i === 3 ? 0 : 30) },
          })
        ),
        item({
          Id: 'pilot',
          Type: 'Episode',
          SeriesId: 'abandoned',
          UserData: { LastPlayedDate: daysAgo(0) },
        }),
      ],
      series: [
        item({ Id: 'binged', Type: 'Series', ProviderIds: { Tmdb: '10' } }),
        item({ Id: 'abandoned', Type: 'Series', ProviderIds: { Tmdb: '11' } }),
      ],
      favorites: [],
      now: NOW,
    });

    assert.equal(weightOf(history, MediaType.TV, 10), 3);
    assert.equal(weightOf(history, MediaType.TV, 11), 1);
    assert.ok(history.watched.has('tv:10'));
  });

  it('boosts favorites and keeps unplayed favorites recommendable', () => {
    const history = buildWatchHistory({
      movies: [
        item({
          Id: 'a',
          ProviderIds: { Tmdb: '1' },
          UserData: { PlayCount: 1, LastPlayedDate: daysAgo(0) },
        }),
      ],
      episodes: [],
      series: [],
      favorites: [
        item({ Id: 'a', ProviderIds: { Tmdb: '1' } }),
        item({ Id: 'fav', Type: 'Series', ProviderIds: { Tmdb: '20' } }),
      ],
      now: NOW,
    });

    assert.equal(weightOf(history, MediaType.MOVIE, 1), 1.5);
    assert.equal(weightOf(history, MediaType.TV, 20), 0.75);
    assert.ok(!history.watched.has('tv:20'));
  });
});

describe('rankRecommendations', () => {
  const result = (id: number, extra: Record<string, unknown> = {}) => ({
    id,
    vote_count: 1000,
    vote_average: 7,
    genre_ids: [18],
    ...extra,
  });

  const recommendationsBySeed: Record<number, ReturnType<typeof result>[]> = {
    1: [result(100), result(101), result(1)],
    2: [result(101), result(102, { vote_count: 3 })],
  };

  const tmdb = {
    getMovieRecommendations: async ({ movieId }: { movieId: number }) => ({
      results: recommendationsBySeed[movieId] ?? [],
    }),
    getMovie: async () => ({ genres: [{ id: 18, name: 'Drama' }] }),
    getTvRecommendations: async () => ({ results: [] }),
    getTvShow: async () => ({ genres: [] }),
  } as unknown as TheMovieDb;

  it('favors titles recommended by several seeds and drops watched ones', async () => {
    const ranked = await rankRecommendations(
      tmdb,
      {
        seeds: [
          { tmdbId: 1, mediaType: MediaType.MOVIE, weight: 1 },
          { tmdbId: 2, mediaType: MediaType.MOVIE, weight: 1 },
        ],
        watched: new Set(['movie:1', 'movie:2']),
      },
      'en'
    );

    assert.deepEqual(
      ranked.map((r) => r.result.id),
      // 101 is recommended by both seeds, 1 is already watched and 102 has
      // too few votes to be trusted.
      [101, 100]
    );
    assert.equal(ranked[0].result.media_type, 'movie');
  });

  it('returns nothing without history', async () => {
    assert.deepEqual(
      await rankRecommendations(tmdb, { seeds: [], watched: new Set() }, 'en'),
      []
    );
  });
});
