import JellyfinAPI, {
  type JellyfinLibraryItemExtended,
} from '@server/api/jellyfin';
import type TheMovieDb from '@server/api/themoviedb';
import type {
  TmdbMovieResult,
  TmdbTvResult,
} from '@server/api/themoviedb/interfaces';
import { MediaType } from '@server/constants/media';
import { MediaServerType } from '@server/constants/server';
import type { User } from '@server/entity/User';
import cacheManager from '@server/lib/cache';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import { getHostname } from '@server/utils/getHostname';

// How far back we look into a user's history.
const MAX_PLAYED_MOVIES = 200;
const MAX_PLAYED_EPISODES = 1000;
const MAX_FAVORITES = 100;

// Only the strongest signals are expanded through TMDB, which bounds the
// number of upstream requests per rebuild to roughly 2 * MAX_SEEDS.
const MAX_SEEDS = 60;

// A title watched this many days ago counts half as much as one watched today.
const RECENCY_HALF_LIFE_DAYS = 90;

// Favorites are the most explicit taste signal, so they add a fixed weight
// that does not decay. This matches a show binged for ~30 episodes this week,
// keeping favorites among the strongest seeds whether watched or not.
const FAVORITE_WEIGHT = 5;

// Titles with fewer votes than this are mostly noise in TMDB recommendations.
const MIN_VOTE_COUNT = 25;

const MAX_RESULTS = 200;

export interface WatchSeed {
  tmdbId: number;
  mediaType: MediaType;
  weight: number;
}

export interface WatchHistory {
  seeds: WatchSeed[];
  // Everything the user has started watching, so it is never recommended.
  watched: Set<string>;
}

export interface Recommendation {
  mediaType: MediaType;
  score: number;
  result: TmdbMovieResult | TmdbTvResult;
}

const historyKey = (mediaType: MediaType, tmdbId: number) =>
  `${mediaType}:${tmdbId}`;

const recencyFactor = (lastPlayed?: string, now = Date.now()): number => {
  if (!lastPlayed) {
    // Played without a timestamp (e.g. marked as watched): treat as old.
    return 0.25;
  }

  const ageDays = Math.max(0, (now - new Date(lastPlayed).getTime()) / 864e5);

  return Math.pow(0.5, ageDays / RECENCY_HALF_LIFE_DAYS);
};

const getTmdbId = (item: JellyfinLibraryItemExtended): number | undefined => {
  const id = Number(item.ProviderIds?.Tmdb ?? item.ProviderIds?.TheMovieDb);

  return Number.isInteger(id) && id > 0 ? id : undefined;
};

/**
 * Converts raw Jellyfin playback state into weighted seeds.
 *
 * Movies are weighted by rewatches, shows by how many episodes were watched,
 * so a show binged for three seasons outweighs a pilot that was abandoned.
 * Watch history decays with time since last played, while favorites add a
 * large fixed weight on top, whether they were watched or not.
 */
export const buildWatchHistory = ({
  movies,
  episodes,
  series,
  favorites,
  now = Date.now(),
}: {
  movies: JellyfinLibraryItemExtended[];
  episodes: JellyfinLibraryItemExtended[];
  series: JellyfinLibraryItemExtended[];
  favorites: JellyfinLibraryItemExtended[];
  now?: number;
}): WatchHistory => {
  const seeds = new Map<string, WatchSeed>();

  for (const movie of movies) {
    const tmdbId = getTmdbId(movie);
    if (!tmdbId) continue;

    const playCount = Math.max(1, movie.UserData?.PlayCount ?? 1);
    const engagement = 1 + 0.5 * Math.log2(playCount);

    seeds.set(historyKey(MediaType.MOVIE, tmdbId), {
      tmdbId,
      mediaType: MediaType.MOVIE,
      weight: engagement * recencyFactor(movie.UserData?.LastPlayedDate, now),
    });
  }

  const episodesBySeries = new Map<
    string,
    { count: number; lastPlayed?: string }
  >();
  for (const episode of episodes) {
    if (!episode.SeriesId) continue;

    const entry = episodesBySeries.get(episode.SeriesId) ?? { count: 0 };
    entry.count++;
    const played = episode.UserData?.LastPlayedDate;
    if (played && (!entry.lastPlayed || played > entry.lastPlayed)) {
      entry.lastPlayed = played;
    }
    episodesBySeries.set(episode.SeriesId, entry);
  }

  for (const show of series) {
    const tmdbId = getTmdbId(show);
    const history = episodesBySeries.get(show.Id);
    if (!tmdbId || !history) continue;

    // 1 episode -> 1, 3 -> 2, 7 -> 3, 15 -> 4, ...
    const engagement = Math.log2(1 + history.count);

    seeds.set(historyKey(MediaType.TV, tmdbId), {
      tmdbId,
      mediaType: MediaType.TV,
      weight: engagement * recencyFactor(history.lastPlayed, now),
    });
  }

  // Everything started so far, so it is never recommended back.
  const watched = new Set(seeds.keys());

  for (const favorite of favorites) {
    const tmdbId = getTmdbId(favorite);
    if (!tmdbId) continue;

    const mediaType =
      favorite.Type === 'Series' ? MediaType.TV : MediaType.MOVIE;
    const seed = seeds.get(historyKey(mediaType, tmdbId));

    if (seed) {
      seed.weight += FAVORITE_WEIGHT;
    } else {
      seeds.set(historyKey(mediaType, tmdbId), {
        tmdbId,
        mediaType,
        weight: FAVORITE_WEIGHT,
      });
    }
  }

  return { seeds: [...seeds.values()], watched };
};

/**
 * Fetches the user's playback history from Jellyfin/Emby.
 * Returns undefined when the user has no linked media server account.
 */
export const getWatchHistory = async (
  user: User
): Promise<WatchHistory | undefined> => {
  const settings = getSettings();

  if (
    (settings.main.mediaServerType !== MediaServerType.JELLYFIN &&
      settings.main.mediaServerType !== MediaServerType.EMBY) ||
    !user.jellyfinUserId ||
    !settings.jellyfin.apiKey
  ) {
    return undefined;
  }

  const jellyfin = new JellyfinAPI(getHostname(), settings.jellyfin.apiKey);
  const userId = user.jellyfinUserId;

  const [movies, episodes, favorites] = await Promise.all([
    jellyfin.getUserItems(userId, {
      includeItemTypes: ['Movie'],
      filters: ['IsPlayed'],
      sortBy: 'DatePlayed',
      sortOrder: 'Descending',
      limit: MAX_PLAYED_MOVIES,
    }),
    jellyfin.getUserItems(userId, {
      includeItemTypes: ['Episode'],
      filters: ['IsPlayed'],
      sortBy: 'DatePlayed',
      sortOrder: 'Descending',
      limit: MAX_PLAYED_EPISODES,
    }),
    jellyfin.getUserItems(userId, {
      includeItemTypes: ['Movie', 'Series'],
      filters: ['IsFavorite'],
      limit: MAX_FAVORITES,
    }),
  ]);

  // Episodes do not carry the series' provider ids, so look the series up.
  const seriesIds = [
    ...new Set(
      episodes
        .map((episode) => episode.SeriesId)
        .filter((id): id is string => !!id)
    ),
  ];
  const series: JellyfinLibraryItemExtended[] = [];
  for (let i = 0; i < seriesIds.length; i += 100) {
    series.push(
      ...(await jellyfin.getUserItems(userId, {
        includeItemTypes: ['Series'],
        ids: seriesIds.slice(i, i + 100),
      }))
    );
  }

  return buildWatchHistory({ movies, episodes, series, favorites });
};

/**
 * Ranks candidates from TMDB's per-title recommendations of the user's
 * strongest seeds.
 *
 * A candidate's score is the sum of the weights of every seed recommending
 * it (discounted by its position in that seed's list), so titles that several
 * favorites agree on rise to the top. Scores are then adjusted by how well
 * the candidate's genres match the user's genre profile and by its rating.
 */
export const rankRecommendations = async (
  tmdb: TheMovieDb,
  history: WatchHistory,
  language: string
): Promise<Recommendation[]> => {
  const seeds = [...history.seeds]
    .sort((a, b) => b.weight - a.weight)
    .slice(0, MAX_SEEDS);

  if (!seeds.length) {
    return [];
  }

  const candidates = new Map<
    string,
    { mediaType: MediaType; score: number; result: Recommendation['result'] }
  >();
  const genreWeights = new Map<number, number>();
  let totalSeedWeight = 0;

  await Promise.all(
    seeds.map(async (seed) => {
      try {
        const [recommendations, genres] =
          seed.mediaType === MediaType.MOVIE
            ? await Promise.all([
                tmdb.getMovieRecommendations({
                  movieId: seed.tmdbId,
                  language,
                }),
                tmdb
                  .getMovie({ movieId: seed.tmdbId, language })
                  .then((movie) => movie.genres),
              ])
            : await Promise.all([
                tmdb.getTvRecommendations({ tvId: seed.tmdbId, language }),
                tmdb
                  .getTvShow({ tvId: seed.tmdbId, language })
                  .then((show) => show.genres),
              ]);

        totalSeedWeight += seed.weight;
        for (const genre of genres) {
          genreWeights.set(
            genre.id,
            (genreWeights.get(genre.id) ?? 0) + seed.weight
          );
        }

        const total = recommendations.results.length;
        recommendations.results.forEach((result, rank) => {
          const key = historyKey(seed.mediaType, result.id);
          // Rank 0 counts fully, the last result about half.
          const contribution = seed.weight * (1 - rank / (2 * total));
          const candidate = candidates.get(key);

          if (candidate) {
            candidate.score += contribution;
          } else {
            candidates.set(key, {
              mediaType: seed.mediaType,
              score: contribution,
              result:
                seed.mediaType === MediaType.MOVIE
                  ? { ...(result as TmdbMovieResult), media_type: 'movie' }
                  : { ...(result as TmdbTvResult), media_type: 'tv' },
            });
          }
        });
      } catch (e) {
        logger.debug('Failed to expand recommendation seed', {
          label: 'Recommendations',
          tmdbId: seed.tmdbId,
          mediaType: seed.mediaType,
          errorMessage: e.message,
        });
      }
    })
  );

  const genreAffinity = (genreIds: number[]): number => {
    if (!totalSeedWeight || !genreIds.length) return 0;

    const affinity = genreIds.reduce(
      (sum, id) => sum + (genreWeights.get(id) ?? 0) / totalSeedWeight,
      0
    );

    return Math.min(1, affinity);
  };

  return [...candidates.entries()]
    .filter(
      ([key, candidate]) =>
        !history.watched.has(key) &&
        candidate.result.vote_count >= MIN_VOTE_COUNT
    )
    .map(([, candidate]) => {
      const { vote_average, genre_ids } = candidate.result;
      const quality = 0.75 + 0.5 * Math.min(1, vote_average / 10);
      const genreBoost = 1 + 0.5 * genreAffinity(genre_ids ?? []);

      return {
        mediaType: candidate.mediaType,
        score: candidate.score * quality * genreBoost,
        result: candidate.result,
      };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_RESULTS);
};

/**
 * Personalised recommendations from the user's watch history, cached per
 * user and language so pagination and repeat visits are cheap.
 */
export const getRecommendationsForUser = async (
  user: User,
  tmdb: TheMovieDb,
  language: string
): Promise<Recommendation[]> => {
  const cache = cacheManager.getCache('recommendations').data;
  const cacheKey = `${user.id}:${language}`;
  const cached = cache.get<Recommendation[]>(cacheKey);

  if (cached) {
    return cached;
  }

  const history = await getWatchHistory(user);
  if (!history) {
    return [];
  }

  const recommendations = await rankRecommendations(tmdb, history, language);
  cache.set(cacheKey, recommendations);

  logger.debug('Built watch history recommendations', {
    label: 'Recommendations',
    userId: user.id,
    seeds: history.seeds.length,
    results: recommendations.length,
  });

  return recommendations;
};
